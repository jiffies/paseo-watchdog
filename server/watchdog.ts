import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PaseoApi } from "@getpaseo/client";
import { assessClaudeUsage, isQuotaFailure } from "./quota";
import { findQuotaNotice } from "./quota-notice.mjs";

const execFileAsync = promisify(execFile);
const CHECK_EVERY_MS = 15 * 60_000;
const RESET_GRACE_MS = 60_000;
const CONTINUE_PROMPT = "继续当前未完成的任务。";
const HISTORY_LIMIT = 20;

type Phase =
  "off" | "armed" | "waiting" | "checking" | "resuming" | "resumed" | "stopped";
type Command = "on" | "off" | "status";
type TurnOutcome =
  | { kind: "completed" }
  | { kind: "canceled"; reason: string }
  | { kind: "failed"; error: { message: string; code?: string } };

interface Pending {
  activityVersion: number;
  lastUserMessageAt: string | null;
  noticeId?: string;
}

interface TriggerRecord {
  id: number;
  at: string;
  prompt: string;
  result: "sending" | "submitted" | "unknown";
}

interface WatchState {
  phase: Phase;
  message: string;
  armed: boolean;
  pending: Pending | null;
  generation: number;
  activityVersion: number;
  timer: ReturnType<typeof setTimeout> | null;
  lastCheckAt: string | null;
  nextCheckAt: string | null;
  resetsAt: string | null;
  usedPct: number | null;
  reportId: string | null;
  exhaustedWindowIds: string[];
  triggerCount: number;
  submittedCount: number;
  unknownCount: number;
  triggers: TriggerRecord[];
  handledNoticeId: string | null;
  ignoreCurrentNotice: boolean;
}

export type WatchdogStatus = Pick<
  WatchState,
  | "phase"
  | "message"
  | "lastCheckAt"
  | "nextCheckAt"
  | "resetsAt"
  | "usedPct"
  | "triggerCount"
  | "submittedCount"
  | "unknownCount"
  | "triggers"
>;

function newState(): WatchState {
  return {
    phase: "off",
    message: "未启用；只在当前会话手动开启后生效。",
    armed: false,
    pending: null,
    generation: 0,
    activityVersion: 0,
    timer: null,
    lastCheckAt: null,
    nextCheckAt: null,
    resetsAt: null,
    usedPct: null,
    reportId: null,
    exhaustedWindowIds: [],
    triggerCount: 0,
    submittedCount: 0,
    unknownCount: 0,
    triggers: [],
    handledNoticeId: null,
    ignoreCurrentNotice: false,
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
    let state = this.states.get(agentId);
    if (!state) {
      state = newState();
      this.states.set(agentId, state);
    }
    return state;
  }

  private status(agentId: string): WatchdogStatus {
    const {
      phase,
      message,
      lastCheckAt,
      nextCheckAt,
      resetsAt,
      usedPct,
      triggerCount,
      submittedCount,
      unknownCount,
      triggers,
    } = this.state(agentId);
    return {
      phase,
      message,
      lastCheckAt,
      nextCheckAt,
      resetsAt,
      usedPct,
      triggerCount,
      submittedCount,
      unknownCount,
      triggers: triggers.map((record) => ({ ...record })),
    };
  }

  private stop(agentId: string, message: string): void {
    const state = this.state(agentId);
    state.generation++;
    state.armed = false;
    state.pending = null;
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    state.nextCheckAt = null;
    state.phase = "stopped";
    state.message = message;
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
    const generation = ++state.generation;
    const snapshot = (await paseo.agents.ref(agentId).refresh())?.agent;
    if (state.generation !== generation) return this.status(agentId);
    if (
      !snapshot ||
      snapshot.provider !== "claude" ||
      snapshot.status === "closed" ||
      snapshot.archivedAt
    ) {
      throw new Error("只能为可用的 Claude Code Agent 开启保护");
    }
    state.armed = true;
    state.ignoreCurrentNotice = false;
    state.phase = "checking";
    state.message = "持续保护已开启，正在查询额度和五小时窗口重置时间。";
    state.lastCheckAt = state.nextCheckAt = state.resetsAt = null;
    state.usedPct = null;
    state.reportId = null;
    state.exhaustedWindowIds = [];
    state.pending =
      snapshot.status === "error" && isQuotaFailure(snapshot.lastError ?? "")
        ? {
            activityVersion: state.activityVersion,
            lastUserMessageAt: snapshot.lastUserMessageAt ?? null,
          }
        : null;
    this.schedule(agentId, 0, false);
    return this.status(agentId);
  }

  async onTurnEnded(
    agentId: string,
    provider: string,
    outcome: TurnOutcome,
    paseo: PaseoApi,
    turnId?: string | null,
  ): Promise<void> {
    this.paseo = paseo;
    const state = this.states.get(agentId);
    if (!state?.armed) return;
    if (provider !== "claude") {
      this.stop(agentId, "仅支持 Claude Code；保护已停止。");
      return;
    }
    const generation = state.generation;
    const activityVersion = ++state.activityVersion;
    const quotaError =
      outcome.kind === "failed" &&
      isQuotaFailure((outcome.error.code ?? "") + " " + outcome.error.message);
    if (
      outcome.kind === "canceled" ||
      (outcome.kind === "failed" && !quotaError)
    ) {
      state.ignoreCurrentNotice = true;
      if (state.pending?.noticeId)
        state.handledNoticeId = state.pending.noticeId;
    }
    state.pending = null;
    state.phase = "armed";
    if (!quotaError) {
      state.message =
        outcome.kind === "completed"
          ? "本轮正常完成，不自动续跑；持续保护和窗口检查仍开启。"
          : outcome.kind === "canceled"
            ? "本轮已主动取消，不自动续跑；持续保护和窗口检查仍开启。"
            : "本轮是非额度错误，不自动重试；持续保护和窗口检查仍开启。";
      if (outcome.kind !== "completed" || state.ignoreCurrentNotice) return;
    }
    try {
      const snapshot = (await paseo.agents.ref(agentId).refresh())?.agent;
      if (
        !state.armed ||
        state.generation !== generation ||
        state.activityVersion !== activityVersion
      )
        return;
      if (
        !snapshot ||
        snapshot.provider !== "claude" ||
        snapshot.status === "closed" ||
        snapshot.archivedAt
      ) {
        this.stop(agentId, "Agent 不可用、已关闭或归档，保护停止。");
        return;
      }
      if (snapshot.activeTurn || snapshot.pendingPermissions?.length) return;
      let noticeId: string | undefined;
      if (!quotaError) {
        if (snapshot.lastUsage?.outputTokens !== 0) return;
        const page = await paseo.agents
          .ref(agentId)
          .timeline.refetch({ direction: "tail", limit: 20 });
        if (
          !state.armed ||
          state.generation !== generation ||
          state.activityVersion !== activityVersion
        )
          return;
        const notice = findQuotaNotice(page, snapshot, turnId);
        if (!notice || notice.id === state.handledNoticeId) return;
        noticeId = notice.id;
      }
      state.pending = {
        activityVersion,
        lastUserMessageAt: snapshot.lastUserMessageAt ?? null,
        noticeId,
      };
      state.phase = "waiting";
      state.message =
        "已记录额度错误或原生额度提示；等待计划中的窗口重置检查，中途不查询额度。";
    } catch {
      if (
        !state.armed ||
        state.generation !== generation ||
        state.activityVersion !== activityVersion
      )
        return;
      state.message =
        "无法确认本次额度中断的 Agent 状态，未安排自动续跑；保护仍开启。";
    }
  }

  onTurnStarted(agentId: string): void {
    const state = this.states.get(agentId);
    if (!state?.armed) return;
    state.activityVersion++;
    state.ignoreCurrentNotice = false;
    state.pending = null;
    state.phase = "armed";
    state.message = "新轮次已开始，旧恢复请求已清除；窗口重置检查仍保留。";
  }

  onArchivedOrClosed(agentId: string): void {
    if (this.states.get(agentId)?.armed)
      this.stop(agentId, "Agent 已关闭或归档，保护取消。");
  }

  private schedule(agentId: string, delayMs: number, allowResume = true): void {
    const state = this.state(agentId);
    if (state.timer) clearTimeout(state.timer);
    state.nextCheckAt = new Date(Date.now() + delayMs).toISOString();
    const generation = state.generation;
    state.timer = setTimeout(() => {
      state.timer = null;
      void this.check(agentId, generation, allowResume).catch(() => {
        if (!state.armed || state.generation !== generation) return;
        state.phase = "waiting";
        state.message = "检查失败；15 分钟后重试。未发送继续消息。";
        this.schedule(agentId, CHECK_EVERY_MS);
      });
    }, delayMs);
  }

  private async check(
    agentId: string,
    generation: number,
    allowResume: boolean,
  ): Promise<void> {
    const state = this.state(agentId);
    const current = () => state.armed && state.generation === generation;
    if (!current() || !this.paseo) return;
    const activityVersion = state.activityVersion;
    state.phase = "checking";
    state.nextCheckAt = null;
    const snapshot = (await this.paseo.agents.ref(agentId).refresh())?.agent;
    if (!current()) return;
    if (
      !snapshot ||
      snapshot.provider !== "claude" ||
      snapshot.status === "closed" ||
      snapshot.archivedAt
    ) {
      this.stop(agentId, "Agent 不可用、已关闭或归档，保护停止。");
      return;
    }
    // Reconcile missed/misclassified completion hooks, including when enabling after a pause.
    if (
      !state.ignoreCurrentNotice &&
      snapshot.lastUsage?.outputTokens === 0 &&
      !snapshot.activeTurn &&
      !snapshot.pendingPermissions.length &&
      (snapshot.status === "idle" || snapshot.status === "error")
    ) {
      const page = await this.paseo.agents
        .ref(agentId)
        .timeline.refetch({ direction: "tail", limit: 20 });
      if (!current()) return;
      if (
        state.activityVersion === activityVersion &&
        !state.ignoreCurrentNotice
      ) {
        const notice = findQuotaNotice(page, snapshot);
        if (state.pending?.noticeId && state.pending.noticeId !== notice?.id) {
          state.handledNoticeId = state.pending.noticeId;
          state.pending = null;
        }
        if (notice && notice.id !== state.handledNoticeId) {
          state.pending = {
            activityVersion,
            lastUserMessageAt: notice.lastUserMessageAt,
            noticeId: notice.id,
          };
        }
      }
    }
    let quota;
    try {
      quota = assessClaudeUsage(
        await queryPaseoUsage(agentId),
        Date.now(),
        state.exhaustedWindowIds,
      );
    } catch {
      if (!current()) return;
      state.lastCheckAt = new Date().toISOString();
      state.phase = "waiting";
      state.message =
        "Paseo Usage 查询失败；请检查 daemon 的 paseo CLI，15 分钟后重试。";
      this.schedule(agentId, CHECK_EVERY_MS);
      return;
    }
    if (!current()) return;
    state.lastCheckAt = new Date().toISOString();
    state.usedPct = quota.usedPct;
    state.resetsAt = quota.resetsAt;
    if (quota.reportId && state.reportId && quota.reportId !== state.reportId) {
      this.stop(agentId, "Paseo 返回的账号已改变；为避免错用额度，保护停止。");
      return;
    }
    if (quota.reportId) state.reportId = quota.reportId;
    state.exhaustedWindowIds = [
      ...new Set([...state.exhaustedWindowIds, ...quota.exhaustedWindowIds]),
    ];
    const resetMs = Date.parse(quota.resetsAt ?? "");
    const knownReset = Number.isFinite(resetMs) && resetMs > Date.now();
    this.schedule(
      agentId,
      knownReset ? resetMs - Date.now() + RESET_GRACE_MS : CHECK_EVERY_MS,
    );
    state.phase =
      state.pending || quota.state !== "ready" ? "waiting" : "armed";
    state.message = knownReset
      ? "持续保护已开启；将在五小时窗口重置后约一分钟检查，仅恢复明确的额度中断。"
      : "暂未取得未来重置时间；15 分钟后重试，仅恢复明确的额度中断。";
    if (quota.state !== "ready")
      state.message = quota.reason + "；已安排下次检查。";

    const pending = state.pending;
    if (
      (!allowResume && !pending?.noticeId) ||
      quota.state !== "ready" ||
      !pending ||
      pending.activityVersion !== activityVersion
    )
      return;
    const finalSnapshot = (await this.paseo.agents.ref(agentId).refresh())
      ?.agent;
    // No awaits between this cancellation check, consuming the interruption, and send.
    if (
      !current() ||
      state.pending !== pending ||
      state.activityVersion !== activityVersion
    )
      return;
    if (
      !finalSnapshot ||
      finalSnapshot.provider !== "claude" ||
      finalSnapshot.status === "closed" ||
      finalSnapshot.archivedAt
    ) {
      this.stop(agentId, "Agent 不可用、已关闭或归档，保护停止。");
      return;
    }
    if (
      finalSnapshot.activeTurn ||
      finalSnapshot.status === "running" ||
      finalSnapshot.status === "initializing" ||
      finalSnapshot.pendingPermissions?.length ||
      (pending.noticeId && finalSnapshot.lastUsage?.outputTokens !== 0) ||
      (finalSnapshot.lastUserMessageAt ?? null) !== pending.lastUserMessageAt
    ) {
      if (pending.noticeId) state.handledNoticeId = pending.noticeId;
      state.pending = null;
      state.phase = "armed";
      state.message =
        "检测到新任务、新消息或待处理确认，取消本次恢复；窗口检查仍保留。";
      return;
    }
    if (pending.noticeId) state.handledNoticeId = pending.noticeId;
    state.pending = null;
    state.phase = "resuming";
    state.message = "额度可用；正在向原 Agent 发送一次继续指令。";
    const trigger: TriggerRecord = {
      id: ++state.triggerCount,
      at: new Date().toISOString(),
      prompt: CONTINUE_PROMPT,
      result: "sending",
    };
    state.triggers.unshift(trigger);
    if (state.triggers.length > HISTORY_LIMIT) state.triggers.pop();
    try {
      await this.paseo.agents.ref(agentId).send(CONTINUE_PROMPT);
      // Record the actual acknowledgement even if a turn or off happened meanwhile.
      trigger.result = "submitted";
      state.submittedCount++;
      if (!current() || state.activityVersion !== activityVersion) return;
      state.phase = "armed";
      state.message = "已发送一次继续消息；持续保护仍开启，下个窗口再检查。";
    } catch {
      trigger.result = "unknown";
      state.unknownCount++;
      if (!current() || state.activityVersion !== activityVersion) return;
      state.phase = "armed";
      state.message = "发送失败或结果未知，不重发本次消息；下个窗口仍会检查。";
    }
  }

  dispose(): void {
    for (const agentId of this.states.keys())
      this.stop(agentId, "插件已停止。");
    this.states.clear();
    this.paseo = null;
  }
}
