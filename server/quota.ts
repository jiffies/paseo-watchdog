/** Pure, auditable quota checks. Neither file access nor network calls belong here. */

export interface QuotaResult {
  state: "blocked" | "ready" | "unknown";
  reason: string;
  usedPct: number | null;
  resetsAt: string | null;
  reportId: string | null;
  exhaustedWindowIds: string[];
}

export function isQuotaFailure(message: string): boolean {
  return [
    /\b(?:usage|rate)[_ -]?limit(?:\b|[_ -])/i,
    /\bquota\s+(?:exceeded|exhausted|reached|limit)\b/i,
    /\b(?:hit|reached|exceeded)\s+(?:your|the)\s+limit\b/i,
    /\b(?:5[- ]hour|five[- ]hour|session)\s+limit\b/i,
  ].some((pattern) => pattern.test(message));
}

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function parseTime(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function assessClaudeUsage(
  reports: unknown,
  nowMs = Date.now(),
  requiredWindowIds: readonly string[] = [],
): QuotaResult {
  const unknown = (reason: string, usedPct: number | null = null): QuotaResult => ({
    state: "unknown",
    reason,
    usedPct,
    resetsAt: null,
    reportId: null,
    exhaustedWindowIds: [],
  });

  if (!Array.isArray(reports) || reports.length !== 1) {
    return unknown("Paseo 返回的会话账号不唯一或不存在");
  }
  const entry = record(reports[0]);
  if (!entry || entry.sourceId !== "claude") return unknown("额度数据不是 Claude 账号");
  if (typeof entry.id !== "string" || !entry.id) return unknown("账号报告 ID 无效");
  const fetched = parseTime(entry.fetchedAt);
  if (fetched === null || Math.abs(nowMs - fetched) > 10 * 60_000) {
    return unknown("额度数据过期或时间异常");
  }

  const report = record(entry.report);
  if (!report || report.status !== "available") return unknown("Paseo 无法读取账号额度");
  if (!Array.isArray(report.windows)) return unknown("额度窗口格式无效");
  const windows = report.windows.map(record).filter((w): w is UnknownRecord => w !== null);
  const fiveHour = windows.find(
    (w) => typeof w.id === "string" && (w.id === "five_hour" || w.id.endsWith(":five_hour")),
  );
  if (!fiveHour || typeof fiveHour.usedPct !== "number") {
    return unknown("缺少可确认的五小时额度数据");
  }
  const usedPct = fiveHour.usedPct;
  if (!Number.isFinite(usedPct) || usedPct < 0 || usedPct > 100) {
    return unknown("五小时额度百分比无效");
  }

  const windowIds = new Set(windows.map((window) => window.id));
  if (
    windows.length !== report.windows.length || windowIds.size !== windows.length ||
    windows.some((window) =>
      typeof window.id !== "string" || !window.id ||
      typeof window.usedPct !== "number" || !Number.isFinite(window.usedPct) ||
      window.usedPct < 0 || window.usedPct > 100,
    )
  ) {
    return unknown("额度窗口存在未知或无效的数据", usedPct);
  }
  if (requiredWindowIds.some((id) => !windowIds.has(id))) {
    return unknown("此前耗尽的额度窗口缺失，尚无法确认恢复", usedPct);
  }

  // Fail closed if any other reported quota is exhausted (weekly/model limits included).
  const exhausted = windows.filter((w) =>
    typeof w.usedPct === "number" && Number.isFinite(w.usedPct) && w.usedPct >= 99,
  );
  if (exhausted.length > 0) {
    const resetTimes = exhausted.map((w) => parseTime(w.resetsAt)).filter((n): n is number => n !== null);
    const latestReset = resetTimes.length > 0 ? new Date(Math.max(...resetTimes)).toISOString() : null;
    return {
      state: "blocked",
      reason: "五小时额度或其他额度窗口仍已用尽",
      usedPct,
      resetsAt: latestReset,
      reportId: entry.id,
      exhaustedWindowIds: exhausted.map((window) => window.id as string),
    };
  }

  if (usedPct <= 95) {
    return {
      state: "ready",
      reason: "五小时额度低于 95%，其他已知额度未耗尽",
      usedPct,
      resetsAt: typeof fiveHour.resetsAt === "string" ? fiveHour.resetsAt : null,
      reportId: entry.id,
      exhaustedWindowIds: [],
    };
  }
  return unknown("额度接近上限，暂不自动恢复", usedPct);
}
