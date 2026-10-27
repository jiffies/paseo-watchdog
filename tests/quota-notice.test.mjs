import assert from "node:assert/strict";
import test from "node:test";
import { findQuotaNotice } from "../server/quota-notice.mjs";

function fixture() {
  const snapshot = {
    provider: "claude",
    status: "idle",
    activeTurn: null,
    pendingPermissions: [],
    lastUsage: { outputTokens: 0 },
    lastUserMessageAt: "2026-01-01T01:07:29.000Z",
  };
  const entry = {
    provider: "claude",
    timestamp: "2026-01-01T01:07:30.000Z",
    turnId: "foreground-turn-7",
    item: {
      type: "assistant_message",
      messageId: "limit-message",
      text: "You've hit your session limit · resets 1:20am (Asia/Taipei)",
    },
  };
  const page = {
    entries: [entry],
    hasNewer: false,
    staleCursor: false,
    gap: null,
  };
  return { snapshot, entry, page };
}

test("recognizes the zero-output native quota notice even when Paseo reports idle/completed", () => {
  const f = fixture();
  assert.deepEqual(findQuotaNotice(f.page, f.snapshot, "foreground-turn-7"), {
    id: "limit-message",
    lastUserMessageAt: f.snapshot.lastUserMessageAt,
  });
});

test("does not classify prose, quotes, tool output or ordinary model replies as a quota pause", () => {
  for (const text of [
    "Task complete.",
    "> You've hit your session limit · resets 1:20am (Asia/Taipei)",
    "The error was: You've hit your session limit · resets 1:20am (Asia/Taipei)",
    "You've hit your session limit · resets 1:20am (Asia/Taipei)\nBut the task is complete.",
  ]) {
    const f = fixture();
    f.entry.item.text = text;
    assert.equal(findQuotaNotice(f.page, f.snapshot), null);
  }
  const f = fixture();
  f.snapshot.lastUsage.outputTokens = 23;
  assert.equal(findQuotaNotice(f.page, f.snapshot), null);
  f.snapshot.lastUsage.outputTokens = 0;
  f.entry.item.type = "tool_call";
  assert.equal(findQuotaNotice(f.page, f.snapshot), null);
});

test("requires the latest message, current user boundary and the expected turn", () => {
  const f = fixture();
  assert.equal(findQuotaNotice(f.page, f.snapshot, "another-turn"), null);
  f.page.entries.push({
    ...f.entry,
    item: { type: "assistant_message", messageId: "done", text: "Done." },
  });
  assert.equal(findQuotaNotice(f.page, f.snapshot), null);
  f.page.entries.pop();
  f.snapshot.lastUserMessageAt = "2026-01-01T02:00:00.000Z";
  assert.equal(findQuotaNotice(f.page, f.snapshot), null);
  f.snapshot.lastUserMessageAt = "2026-01-01T01:07:29.000Z";
  f.page.entries.push({
    ...f.entry,
    item: { type: "user_message", text: "New task" },
  });
  assert.equal(findQuotaNotice(f.page, f.snapshot), null);
});

test("ignores incomplete pages, missing identity, active turns and pending permissions", () => {
  for (const key of ["hasNewer", "staleCursor", "gap", "error"]) {
    const f = fixture();
    f.page[key] = true;
    assert.equal(findQuotaNotice(f.page, f.snapshot), null);
  }
  const f = fixture();
  delete f.entry.item.messageId;
  assert.equal(findQuotaNotice(f.page, f.snapshot), null);
  const active = fixture();
  active.snapshot.activeTurn = { id: "new-turn" };
  assert.equal(findQuotaNotice(active.page, active.snapshot), null);
  active.snapshot.activeTurn = null;
  active.snapshot.pendingPermissions = [{}];
  assert.equal(findQuotaNotice(active.page, active.snapshot), null);
});
