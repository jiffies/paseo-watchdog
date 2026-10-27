import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import { setImmediate } from "node:timers/promises";
import { promisify } from "node:util";
import test, { after } from "node:test";

let queryUsage;
let usageQueries = 0;
const originalExecFile = childProcess.execFile;
const execFile = () => {
  throw new Error("Real process execution is disabled in tests");
};
execFile[promisify.custom] = async (command, args, options) => {
  usageQueries++;
  const usageArgs = [
    "usage",
    "ls",
    "--agent",
    "test-agent",
    "--json",
    "--refresh",
  ];
  assert.equal(command, process.platform === "win32" ? "cmd.exe" : "paseo");
  assert.deepEqual(
    args,
    process.platform === "win32"
      ? ["/d", "/s", "/c", `paseo ${usageArgs.join(" ")}`]
      : usageArgs,
  );
  assert.equal(options.timeout, 20_000);
  return { stdout: JSON.stringify(await queryUsage()), stderr: "" };
};
childProcess.execFile = execFile;
syncBuiltinESMExports();
assert.equal(promisify(childProcess.execFile), execFile[promisify.custom]);

// Paseo resolves extensionless TS imports; mirror only that import in Node's test runner.
const resolver = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier === "./quota" &&
      context.parentURL ===
        new URL("../server/watchdog.ts", import.meta.url).href
    ) {
      return nextResolve(
        new URL("../server/quota.ts", import.meta.url).href,
        context,
      );
    }
    return nextResolve(specifier, context);
  },
});
const { Watchdog } = await import("../server/watchdog.ts");
resolver.deregister();
after(() => {
  childProcess.execFile = originalExecFile;
  syncBuiltinESMExports();
});

function usage(
  usedPct = 30,
  weekly = 20,
  id = "claude:test-account",
  resetAt = Date.now() + 5 * 3_600_000,
) {
  return [
    {
      id,
      sourceId: "claude",
      fetchedAt: new Date().toISOString(),
      report: {
        status: "available",
        windows: [
          {
            id: "five_hour",
            usedPct,
            resetsAt: resetAt === null ? null : new Date(resetAt).toISOString(),
          },
          {
            id: "weekly",
            usedPct: weekly,
            resetsAt: new Date(Date.now() + 86_400_000).toISOString(),
          },
        ],
      },
    },
  ];
}

const quotaFailure = {
  kind: "failed",
  error: { message: "Usage limit reached" },
};
const flush = () => setImmediate();

function setup(t) {
  usageQueries = 0;
  queryUsage = async () => usage();
  t.mock.timers.enable({
    apis: ["Date", "setTimeout"],
    now: Date.parse("2026-01-01T00:00:00Z"),
  });
  const watchdog = new Watchdog();
  t.after(() => watchdog.dispose());
  const sent = [];
  const snapshot = {
    provider: "claude",
    status: "idle",
    lastError: null,
    activeTurn: null,
    archivedAt: null,
    pendingPermissions: [],
    lastUserMessageAt: "2026-01-01T00:00:00Z",
  };
  const ref = {
    refresh: async () => ({ agent: { ...snapshot } }),
    send: async (text) => {
      sent.push(text);
    },
  };
  const paseo = {
    agents: {
      ref: (id) => {
        assert.equal(id, "test-agent");
        return ref;
      },
    },
  };
  const control = (action) => watchdog.control("test-agent", action, paseo);
  const poll = async () => {
    const status = await control("status");
    assert.ok(status.nextCheckAt, "A check must be scheduled");
    t.mock.timers.tick(
      Math.max(0, Date.parse(status.nextCheckAt) - Date.now()),
    );
    await flush();
  };
  const start = async () => {
    await control("on");
    await poll();
  };
  const fail = async () => {
    snapshot.status = "error";
    snapshot.lastError = quotaFailure.error.message;
    await watchdog.onTurnEnded("test-agent", "claude", quotaFailure, paseo);
  };
  return { watchdog, snapshot, ref, paseo, sent, control, poll, start, fail };
}

test("enable queries immediately, then waits for reset plus one minute without intermediate usage calls", async (t) => {
  const f = setup(t);
  const resetAt = Date.now() + 5 * 3_600_000;
  await f.start();
  const initial = await f.control("status");
  assert.equal(usageQueries, 1);
  assert.equal(initial.usedPct, 30);
  assert.equal(initial.resetsAt, new Date(resetAt).toISOString());
  assert.equal(Date.parse(initial.nextCheckAt), resetAt + 60_000);
  t.mock.timers.tick(2 * 3_600_000);
  await flush();
  await f.fail();
  await f.control("status");
  await f.control("on");
  assert.equal(
    usageQueries,
    1,
    "Commands and quota events must not query usage mid-window",
  );
  assert.equal((await f.control("status")).nextCheckAt, initial.nextCheckAt);
  t.mock.timers.tick(resetAt + 60_000 - Date.now() - 1);
  await flush();
  assert.equal(usageQueries, 1);
  assert.equal(f.sent.length, 0);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(usageQueries, 2);
  assert.deepEqual(f.sent, ["继续当前未完成的任务。"]);
  assert.equal((await f.control("status")).phase, "armed");
});

test("initial check populates status but never sends, even when enabling after a quota failure", async (t) => {
  const f = setup(t);
  f.snapshot.status = "error";
  f.snapshot.lastError = "Usage limit reached";
  await f.start();
  assert.equal(f.sent.length, 0);
  await f.poll();
  assert.equal(f.sent.length, 1);
  await f.poll();
  assert.equal(f.sent.length, 1);
});

test("normal completion, manual cancellation and unrelated errors never become quota recovery", async (t) => {
  const f = setup(t);
  await f.start();
  for (const outcome of [
    { kind: "completed" },
    { kind: "canceled", reason: "user" },
    { kind: "failed", error: { message: "network timeout" } },
  ]) {
    f.watchdog.onTurnStarted("test-agent");
    await f.watchdog.onTurnEnded("test-agent", "claude", outcome, f.paseo);
    await f.poll();
    assert.equal(f.sent.length, 0);
    assert.equal((await f.control("status")).phase, "armed");
  }
});

test("one activation covers more than 48 hours and ten quota windows", async (t) => {
  const f = setup(t);
  await f.start();
  for (let cycle = 0; cycle < 10; cycle++) {
    f.watchdog.onTurnStarted("test-agent");
    await f.fail();
    await f.poll();
    assert.equal(f.sent.length, cycle + 1);
    assert.equal((await f.control("status")).phase, "armed");
  }
  assert.ok(Date.now() - Date.parse("2026-01-01T00:00:00Z") > 48 * 3_600_000);
  assert.equal(usageQueries, 11);
});

test("cancellation clears this recovery while retaining the reset timer and future protection", async (t) => {
  const f = setup(t);
  await f.start();
  await f.fail();
  const planned = (await f.control("status")).nextCheckAt;
  await f.watchdog.onTurnEnded(
    "test-agent",
    "claude",
    { kind: "canceled", reason: "user" },
    f.paseo,
  );
  assert.equal((await f.control("status")).nextCheckAt, planned);
  await f.poll();
  assert.equal(f.sent.length, 0);
  f.watchdog.onTurnStarted("test-agent");
  await f.fail();
  await f.poll();
  assert.equal(f.sent.length, 1);
});

for (const cancel of ["off", "turn", "complete", "archive", "dispose"]) {
  test(`${cancel} before final refresh resolves prevents sending`, async (t) => {
    const f = setup(t);
    await f.start();
    await f.fail();
    let refreshCount = 0;
    f.ref.refresh = () => {
      const result = Promise.resolve({ agent: { ...f.snapshot } });
      if (++refreshCount === 2)
        result.then(() => {
          if (cancel === "off") void f.control("off");
          else if (cancel === "turn") f.watchdog.onTurnStarted("test-agent");
          else if (cancel === "complete")
            void f.watchdog.onTurnEnded(
              "test-agent",
              "claude",
              { kind: "completed" },
              f.paseo,
            );
          else if (cancel === "archive")
            f.watchdog.onArchivedOrClosed("test-agent");
          else f.watchdog.dispose();
        });
      return result;
    };
    await f.poll();
    assert.equal(f.sent.length, 0);
    assert.equal(
      Boolean((await f.control("status")).nextCheckAt),
      ["turn", "complete"].includes(cancel),
    );
  });
}

for (const change of ["message", "activeTurn", "permission", "running"]) {
  test(`a new ${change} prevents resuming old work`, async (t) => {
    const f = setup(t);
    await f.start();
    await f.fail();
    if (change === "message")
      f.snapshot.lastUserMessageAt = "2026-01-01T00:01:00Z";
    if (change === "activeTurn") f.snapshot.activeTurn = { id: "other-turn" };
    if (change === "permission")
      f.snapshot.pendingPermissions = [{ requestId: "test-permission" }];
    if (change === "running") f.snapshot.status = "running";
    await f.poll();
    assert.equal(f.sent.length, 0);
    assert.equal((await f.control("status")).phase, "armed");
  });
}

for (const missing of ["null", "absent"]) {
  test(`previously exhausted weekly quota becoming ${missing} blocks recovery`, async (t) => {
    const f = setup(t);
    queryUsage = async () => usage(10, 100);
    await f.start();
    await f.fail();
    queryUsage = async () => {
      const value = usage(10, null);
      if (missing === "absent") value[0].report.windows.pop();
      return value;
    };
    await f.poll();
    assert.equal(f.sent.length, 0);
    queryUsage = async () => usage(10, 20);
    await f.poll();
    assert.equal(f.sent.length, 1);
  });
}

test("weekly exhaustion blocks sending even after five-hour quota recovers", async (t) => {
  const f = setup(t);
  await f.start();
  await f.fail();
  queryUsage = async () => usage(10, 100);
  await f.poll();
  assert.equal(f.sent.length, 0);
  assert.equal(
    Date.parse((await f.control("status")).nextCheckAt) - Date.now(),
    5 * 3_600_000 + 60_000,
  );
});

test("stale or missing usage cannot authorize resuming", async (t) => {
  const f = setup(t);
  await f.start();
  await f.fail();
  queryUsage = async () => {
    const value = usage();
    value[0].fetchedAt = "2025-01-01T00:00:00Z";
    return value;
  };
  await f.poll();
  assert.equal(f.sent.length, 0);
  assert.equal(
    Date.parse((await f.control("status")).nextCheckAt) - Date.now(),
    15 * 60_000,
  );
});

test("binds the account at enable time even when quota is not exhausted", async (t) => {
  const f = setup(t);
  await f.start();
  await f.fail();
  queryUsage = async () => usage(10, 20, "claude:other-test-account");
  await f.poll();
  assert.equal(f.sent.length, 0);
  assert.equal((await f.control("status")).phase, "stopped");
});

test("no reset timestamp falls back to fifteen minutes", async (t) => {
  const f = setup(t);
  queryUsage = async () => usage(30, 20, "claude:test-account", null);
  await f.start();
  assert.equal(
    Date.parse((await f.control("status")).nextCheckAt) - Date.now(),
    15 * 60_000,
  );
});

test("an imminent reset is checked one minute after reset", async (t) => {
  const f = setup(t);
  const resetAt = Date.now() + 60_000;
  queryUsage = async () => usage(30, 20, "claude:test-account", resetAt);
  await f.start();
  assert.equal(
    Date.parse((await f.control("status")).nextCheckAt),
    resetAt + 60_000,
  );
});

test("off during initial agent refresh wins", async (t) => {
  const f = setup(t);
  let finish;
  f.ref.refresh = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const arming = f.control("on");
  await f.control("off");
  finish({ agent: { ...f.snapshot } });
  await arming;
  assert.equal((await f.control("status")).phase, "stopped");
  assert.equal(usageQueries, 0);
});

test("off during usage query prevents send and rescheduling", async (t) => {
  const f = setup(t);
  await f.start();
  await f.fail();
  queryUsage = async () => {
    await f.control("off");
    return usage();
  };
  await f.poll();
  assert.equal(f.sent.length, 0);
  assert.equal((await f.control("status")).nextCheckAt, null);
});

test("turn events do not discard the initial usage query or move its reset timer", async (t) => {
  const f = setup(t);
  queryUsage = async () => {
    f.watchdog.onTurnStarted("test-agent");
    return usage(42);
  };
  await f.start();
  assert.equal((await f.control("status")).usedPct, 42);
  assert.equal(usageQueries, 1);
});

test("a stale quota event cannot attach to a newer turn", async (t) => {
  const f = setup(t);
  await f.start();
  let finish;
  const original = f.ref.refresh;
  f.ref.refresh = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const ending = f.fail();
  f.watchdog.onTurnStarted("test-agent");
  finish({ agent: { ...f.snapshot } });
  await ending;
  f.ref.refresh = original;
  await f.poll();
  assert.equal(f.sent.length, 0);
});

test("query errors and refresh errors retry without exposing private details", async (t) => {
  const f = setup(t);
  await f.start();
  await f.fail();
  queryUsage = async () => {
    throw new Error("synthetic-private-error");
  };
  await f.poll();
  assert.equal(
    (await f.control("status")).message.includes("synthetic-private-error"),
    false,
  );
  assert.equal(
    Date.parse((await f.control("status")).nextCheckAt) - Date.now(),
    15 * 60_000,
  );
  const original = f.ref.refresh;
  f.ref.refresh = async () => {
    throw new Error("synthetic-private-error");
  };
  await f.poll();
  assert.equal(
    (await f.control("status")).message.includes("synthetic-private-error"),
    false,
  );
  f.ref.refresh = original;
  queryUsage = async () => usage();
  await f.poll();
  assert.equal(f.sent.length, 1);
});

test("uncertain send is never retried for the same interruption", async (t) => {
  const f = setup(t);
  await f.start();
  await f.fail();
  let attempts = 0;
  f.ref.send = async () => {
    attempts++;
    throw new Error("synthetic-private-error");
  };
  await f.poll();
  await f.poll();
  await f.poll();
  assert.equal(attempts, 1);
  assert.equal((await f.control("status")).phase, "armed");
});

test("late send acknowledgement cannot override off", async (t) => {
  const f = setup(t);
  await f.start();
  await f.fail();
  let acknowledge;
  f.ref.send = async () => {
    await new Promise((resolve) => {
      acknowledge = resolve;
    });
  };
  await f.poll();
  assert.equal((await f.control("status")).phase, "resuming");
  await f.control("off");
  acknowledge();
  await flush();
  assert.equal((await f.control("status")).phase, "stopped");
  assert.equal((await f.control("status")).nextCheckAt, null);
});

test("a new quota failure before the old send acknowledgement keeps its own pending recovery", async (t) => {
  const f = setup(t);
  await f.start();
  await f.fail();
  f.ref.send = async (text) => {
    f.sent.push(text);
    f.watchdog.onTurnStarted("test-agent");
    await f.fail();
  };
  await f.poll();
  assert.equal(f.sent.length, 1);
  assert.equal((await f.control("status")).phase, "waiting");
  await f.poll();
  assert.equal(f.sent.length, 2);
});

test("unavailable or archived agent stops protection", async (t) => {
  const f = setup(t);
  await f.start();
  f.snapshot.archivedAt = new Date().toISOString();
  await f.poll();
  assert.equal((await f.control("status")).phase, "stopped");
  assert.equal(f.sent.length, 0);
});
