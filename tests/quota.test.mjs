import assert from "node:assert/strict";
import test from "node:test";
import { assessClaudeUsage, isQuotaFailure } from "../server/quota.ts";

const now = Date.parse("2026-10-27T12:00:00.000Z");

function reports(usedPct, options = {}) {
  return [{
    id: "claude:abc",
    sourceId: "claude",
    fetchedAt: options.fetchedAt ?? new Date(now).toISOString(),
    report: {
      status: "available",
      windows: [
        { id: "five_hour", usedPct, resetsAt: "2026-10-27T14:00:00.000Z" },
        { id: "weekly", usedPct: options.weekly ?? 20, resetsAt: "2026-10-30T15:00:00.000Z" },
      ],
    },
  }];
}

test("detects only explicit quota-related failures", () => {
  for (const message of ["rate_limit_error", "Usage limit reached", "You've hit your limit", "quota exceeded", "5-hour limit exceeded"]) {
    assert.equal(isQuotaFailure(message), true, message);
  }
  for (const message of ["context window exceeded", "network timeout", "permission denied", "tool failed", "HTTP 502"]) {
    assert.equal(isQuotaFailure(message), false, message);
  }
});

test("blocks on exhausted five-hour window", () => {
  const usage = assessClaudeUsage(reports(100), now);
  assert.equal(usage.state, "blocked");
  assert.equal(usage.usedPct, 100);
  assert.equal(usage.resetsAt, "2026-10-27T14:00:00.000Z");
});

test("permits recovery only with plenty of fresh quota", () => {
  assert.equal(assessClaudeUsage(reports(17), now).state, "ready");
  assert.equal(assessClaudeUsage(reports(98), now).state, "unknown");
});

test("does not resume when weekly quota remains exhausted", () => {
  const usage = assessClaudeUsage(reports(10, { weekly: 100 }), now);
  assert.equal(usage.state, "blocked");
  assert.equal(usage.resetsAt, "2026-10-30T15:00:00.000Z");
});

test("fails closed for wrong account, multiple reports or old snapshots", () => {
  assert.equal(assessClaudeUsage([], now).state, "unknown");
  assert.equal(assessClaudeUsage([...reports(10), ...reports(10)], now).state, "unknown");
  assert.equal(assessClaudeUsage([{ ...reports(10)[0], sourceId: "codex" }], now).state, "unknown");
  assert.equal(assessClaudeUsage(reports(10, { fetchedAt: "2026-10-26T11:00:00.000Z" }), now).state, "unknown");
  assert.equal(assessClaudeUsage([{ ...reports(10)[0], report: { status: "error" } }], now).state, "unknown");
});

test("rejects unknown or invalid values in every reported window", () => {
  for (const value of [null, undefined, "100", NaN, Infinity, -1, 101]) {
    const input = reports(10);
    input[0].report.windows[1].usedPct = value;
    assert.equal(assessClaudeUsage(input, now).state, "unknown");
  }
});

test("rejects malformed or duplicate windows instead of silently dropping them", () => {
  for (const extra of [null, [], {}, { id: "weekly", usedPct: 10 }]) {
    const input = reports(10);
    input[0].report.windows.push(extra);
    assert.equal(assessClaudeUsage(input, now).state, "unknown");
  }
});

test("requires previously exhausted windows to explicitly recover", () => {
  const blocked = assessClaudeUsage(reports(10, { weekly: 100 }), now);
  assert.deepEqual(blocked.exhaustedWindowIds, ["weekly"]);
  const missing = reports(10);
  missing[0].report.windows.pop();
  assert.equal(assessClaudeUsage(missing, now, blocked.exhaustedWindowIds).state, "unknown");
  assert.equal(assessClaudeUsage(reports(10), now, blocked.exhaustedWindowIds).state, "ready");
});
