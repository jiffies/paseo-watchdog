import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PaseoApi } from "@getpaseo/client";
import { assessClaudeUsage, isQuotaFailure } from "./quota";

const execFileAsync = promisify(execFile);
const CHECK_EVERY_MS = 15 * 60_000;
const RESET_GRACE_MS = 60_000;
const CONTINUE_PROMPT = "继续当前未完成的任务。";

type Phase =
  "off" | "armed" | "waiting" | "checking" | "resuming" | "resumed" | "stopped";
type Command = "on" | "off" | "status";
type TurnOutcome =
  | { kind: "completed" }
  | { kind: "canceled"; reason: string }
  | { kind: "failed"; error: { message: string; code?: string } };

interface Pending {
  generation: number;
  lastUserMessageAt: string | null;
  confirmedExhaustion: boolean;
  reportId: string | null;
  exhaustedWindowIds: string[];
}

interface WatchState {
  phase: Phase;
  message: string;
  armed: boolean;
  pending: Pending | null;
  generation: number;
  timer: ReturnType<typeof setTimeout> | null;
  lastCheckAt: string | null;
  nextCheckAt: string | null;
  resetsAt: string | null;
  usedPct: number | null;
}

export type WatchdogStatus = Pick<
  WatchState,
  "phase" | "message" | "lastCheckAt" | "nextCheckAt" | "resetsAt" | "usedPct"
>;

function newState(): WatchState {
  return {
    phase: "off",
    message: "未启用；只在当前会话手动开启后生效。",
    armed: false,
    pending: null,
    generation: 0,
    timer: null,
    lastCheckAt: null,
    nextCheckAt: null,
    resetsAt: null,
    usedPct: null,
  };
}

async function queryPaseoUsage(agentId: string): Promise<unknown> {
  // This is a validated identifier passed to Paseo, never to a shell on POSIX.
  if (!/^[a-zA-Z0-9_-]{1,200}$/.test(agentId)) {
    throw new Error("Agent ID 包含不受支持的字符");
  }
  const args = ["usage", "ls", "--agent", agentId, "--json", "--refresh"];
  const command = process.platform === "win32" ? "cmd.exe" : "paseo";
  // Windows npm CLI installs may be .cmd shims; strictly validated ID prevents cmd injection.
  const commandArgs =
    process.platform === "win32"
      ? ["/d", "/s", "/c", `paseo ${args.join(" ")}`]
      : args;
  const { stdout } = await execFileAsync(command, commandArgs, {
    timeout: 20_000,
    maxBuffer: 200_000,
    windowsHide: true,
  });
  return JSON.parse(stdout);
}

export class Watchdog {
  private readonly states = new Map<string, WatchState>();
  private paseo: PaseoApi | null = null;

  private state(agentId: string): WatchState {
    let value = this.states.get(agentId);
    if (!value) {
      value = newState();
      this.states.set(agentId, value);
    }
    return value;
  }

  private status(agentId: string): WatchdogStatus {
    const { phase, message, lastCheckAt, nextCheckAt, resetsAt, usedPct } =
      this.state(agentId);
    return { phase, message, lastCheckAt, nextCheckAt, resetsAt, usedPct };
  }

  private standby(agentId: string, reason: string): void {
    const state = this.state(agentId);
    state.generation++;
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    state.pending = null;
    state.nextCheckAt = null;
    state.phase = state.armed ? "armed" : "stopped";
    state.message = reason;
  }

  private stop(agentId: string, reason: string): void {
    this.state(agentId).armed = false;
    this.standby(agentId, reason);
  }

  async control(
    agentId: string,
    action: Command,
    paseo: PaseoApi,
  ): Promise<WatchdogStatus> {
    this.paseo = paseo;
    if (action === "status") return this.status(agentId);
    if (action === "off") {
      this.stop(agentId, "已手动关闭。不会发送继续消息。");
      return this.status(agentId);
    }

    const state = this.state(agentId);
    if (state.armed) return this.status(agentId);
    // A later `off` must win even if this `on` RPC is still refreshing the agent.
    const requestGeneration = ++state.generation;
    const snapshot = (await paseo.agents.ref(agentId).refresh())?.agent;
    if (state.generation !== requestGeneration) return this.status(agentId);
    if (!snapshot) throw new Error("Paseo 中找不到当前 Agent");
    if (snapshot.provider !== "claude")
      throw new Error("MVP 仅支持 Claude Code Agent");
    if (snapshot.status === "closed" || snapshot.archivedAt) {
      throw new Error("Agent 已关闭或归档，无法监控");
    }
    if (state.armed) return this.status(agentId);

    state.armed = true;
    state.phase = "armed";
    state.message =
      "持续保护已开启：正常回复结束后仍会待命；仅在额度中断后查询用量。";
    state.lastCheckAt = null;
    state.nextCheckAt = null;
    state.usedPct = null;
    state.resetsAt = null;

    // Also supports enabling after the current turn has already stopped at a quota error.
    if (
      snapshot.status === "error" &&
      isQuotaFailure(snapshot.lastError ?? "")
    ) {
      this.startWaiting(agentId, snapshot.lastUserMessageAt ?? null);
    }
    return this.status(agentId);
  }

  async onTurnEnded(
    agentId: string,
    provider: string,
    outcome: TurnOutcome,
    paseo: PaseoApi,
  ): Promise<void> {
    this.paseo = paseo;
    const state = this.states.get(agentId);
    if (!state?.armed) return;
    const generation = state.generation;
    if (provider !== "claude") {
      this.stop(agentId, "仅支持 Claude Code；监控已停止。");
      return;
    }
    if (outcome.kind !== "failed") {
      this.standby(
        agentId,
        outcome.kind === "completed"
          ? "本轮任务已结束；持续保护仍开启，等待后续额度中断。"
          : "本轮任务已取消，不会自动继续该轮；持续保护仍开启。",
      );
      return;
    }
    const error = `${outcome.error.code ?? ""} ${outcome.error.message}`;
    if (!isQuotaFailure(error)) {
      this.standby(
        agentId,
        "本轮失败不是明确的额度限制，不自动重试；持续保护仍开启。",
      );
      return;
    }
    if (state.pending) return;
    try {
      const snapshot = (await paseo.agents.ref(agentId).refresh())?.agent;
      if (!state.armed || state.generation !== generation) return;
      if (
        !snapshot ||
        snapshot.provider !== "claude" ||
        snapshot.status === "closed" ||
        snapshot.archivedAt
      ) {
        this.stop(agentId, "Agent 不可用、已关闭或归档，持续保护停止。");
        return;
      }
      if (snapshot.activeTurn || snapshot.pendingPermissions?.length) {
        this.standby(
          agentId,
          "Agent 已开始其他操作或正在等待确认，取消本次恢复；持续保护仍开启。",
        );
        return;
      }
      this.startWaiting(agentId, snapshot.lastUserMessageAt ?? null);
    } catch {
      if (!state.armed || state.generation !== generation) return;
      this.standby(
        agentId,
        "无法确认 Agent 状态，未启动本次恢复；持续保护仍开启。",
      );
    }
  }

  onTurnStarted(agentId: string): void {
    const state = this.states.get(agentId);
    if (state?.armed) {
      this.standby(agentId, "新轮次已开始，旧恢复请求已清除；持续保护仍开启。");
    }
  }

  onArchivedOrClosed(agentId: string): void {
    const state = this.states.get(agentId);
    if (state?.armed) this.stop(agentId, "Agent 已关闭或归档，监控取消。");
  }

  private startWaiting(
    agentId: string,
    lastUserMessageAt: string | null,
  ): void {
    const state = this.state(agentId);
    state.generation++;
    state.pending = {
      generation: state.generation,
      lastUserMessageAt,
      confirmedExhaustion: false,
      reportId: null,
      exhaustedWindowIds: [],
    };
    state.phase = "waiting";
    state.message = "检测到额度失败；正在通过 Paseo 检查五小时窗口。";
    this.schedule(agentId, 0);
  }

  private schedule(agentId: string, delayMs: number): void {
    const state = this.state(agentId);
    if (state.timer) clearTimeout(state.timer);
    state.nextCheckAt = new Date(Date.now() + delayMs).toISOString();
    const generation = state.generation;
    state.timer = setTimeout(() => {
      state.timer = null;
      void this.check(agentId, generation).catch(() => {
        console.error("[paseo-watchdog] internal check failed");
        if (state.generation === generation && state.pending) {
          state.phase = "waiting";
          state.message = "内部检查失败；将在 15 分钟后重试。";
          this.schedule(agentId, CHECK_EVERY_MS);
        }
      });
    }, delayMs);
  }

  private async stillSafe(
    agentId: string,
    generation: number,
  ): Promise<boolean> {
    const state = this.state(agentId);
    const pending = state.pending;
    if (
      !state.armed ||
      !pending ||
      pending.generation !== generation ||
      !this.paseo
    ) {
      return false;
    }
    const snapshot = (await this.paseo.agents.ref(agentId).refresh())?.agent;
    if (!state.armed || state.pending?.generation !== generation) return false;
    if (
      !snapshot ||
      snapshot.provider !== "claude" ||
      snapshot.archivedAt ||
      snapshot.status === "closed"
    ) {
      this.stop(agentId, "Agent 不可用、已关闭或归档，持续保护停止。");
      return false;
    }
    if (
      snapshot.activeTurn ||
      snapshot.pendingPermissions?.length ||
      (snapshot.lastUserMessageAt ?? null) !== pending.lastUserMessageAt
    ) {
      this.standby(
        agentId,
        "检测到新任务、新消息或待处理确认，取消本次恢复；持续保护仍开启。",
      );
      return false;
    }
    return true;
  }

  private async check(agentId: string, generation: number): Promise<void> {
    if (!(await this.stillSafe(agentId, generation))) return;
    const state = this.state(agentId);
    if (
      !state.armed ||
      state.generation !== generation ||
      state.pending?.generation !== generation
    )
      return;
    state.phase = "checking";
    state.nextCheckAt = null;

    let quota;
    try {
      quota = assessClaudeUsage(
        await queryPaseoUsage(agentId),
        Date.now(),
        state.pending?.exhaustedWindowIds,
      );
    } catch (error) {
      if (!state.pending || state.generation !== generation) return;
      state.lastCheckAt = new Date().toISOString();
      state.phase = "waiting";
      const code =
        error && typeof error === "object" && "code" in error
          ? String(error.code)
          : "CLI/JSON ERROR";
      state.message = `Paseo Usage 查询失败（${code}）；请检查 daemon 的 paseo CLI，15 分钟后重试。`;
      this.schedule(agentId, CHECK_EVERY_MS);
      return;
    }

    if (!state.pending || state.generation !== generation) return;
    state.lastCheckAt = new Date().toISOString();
    state.resetsAt = quota.resetsAt;
    state.usedPct = quota.usedPct;

    if (
      quota.reportId &&
      state.pending.reportId &&
      quota.reportId !== state.pending.reportId
    ) {
      this.stop(agentId, "Paseo 返回的账号已改变；为避免错用额度，监控停止。 ");
      return;
    }

    if (quota.state === "blocked") {
      state.pending.confirmedExhaustion = true;
      state.pending.reportId = quota.reportId;
      state.pending.exhaustedWindowIds = [
        ...new Set([
          ...state.pending.exhaustedWindowIds,
          ...quota.exhaustedWindowIds,
        ]),
      ];
    }
    if (quota.state === "ready" && state.pending.confirmedExhaustion) {
      if (!(await this.stillSafe(agentId, generation))) return;
      // Cancellation can run after stillSafe resolves but before this continuation.
      if (
        !state.armed ||
        state.generation !== generation ||
        state.pending?.generation !== generation
      )
        return;
      // Consume this interruption before sending; later turns can report a new one.
      this.standby(
        agentId,
        "额度已恢复；正在向原 Agent 发送一次通用继续指令。",
      );
      const resumeGeneration = state.generation;
      state.phase = "resuming";
      try {
        await this.paseo!.agents.ref(agentId).send(CONTINUE_PROMPT);
        if (!state.armed || state.generation !== resumeGeneration) return;
        state.phase = "armed";
        state.message =
          "已发送一次『继续当前未完成的任务。』；持续保护仍开启，可处理后续额度中断。";
      } catch {
        if (!state.armed || state.generation !== resumeGeneration) return;
        this.standby(
          agentId,
          "恢复消息发送失败或结果未知，不重发本次消息；持续保护仍开启。",
        );
      }
      return;
    }

    state.phase = "waiting";
    state.message =
      quota.state === "ready"
        ? "额度看起来可用，但监控尚未亲自观察到额度耗尽；暂不发送消息。"
        : quota.reason;
    let delayMs = CHECK_EVERY_MS;
    if (quota.state === "blocked" && quota.resetsAt) {
      const resetMs = Date.parse(quota.resetsAt);
      if (Number.isFinite(resetMs) && resetMs > Date.now()) {
        // One check after the known reset is cheaper than polling throughout the window.
        delayMs = resetMs - Date.now() + RESET_GRACE_MS;
      }
    }
    this.schedule(agentId, delayMs);
  }

  dispose(): void {
    for (const state of this.states.values()) {
      if (state.timer) clearTimeout(state.timer);
      state.timer = null;
      state.generation++;
      state.armed = false;
      state.pending = null;
    }
    this.states.clear();
    this.paseo = null;
  }
}
