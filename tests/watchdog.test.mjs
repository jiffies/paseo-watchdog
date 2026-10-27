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

function usage(usedPct, weekly = 20, id = "claude:test-account") {
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
            resetsAt: new Date(Date.now() + 3_600_000).toISOString(),
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

function setup(t) {
  usageQueries = 0;
  t.mock.timers.enable({
    apis: ["Date", "setTimeout"],
    now: Date.parse("2026-01-01T00:00:00Z"),
  });
  const watchdog = new Watchdog();
  t.after(() => watchdog.dispose());
  const sent = [];
  const snapshot = {
    provider: "claude",
    status: "error",
    lastError: "Usage limit reached",
    activeTurn: null,
    archivedAt: null,
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
    await setImmediate();
  };
  return { watchdog, snapshot, ref, paseo, sent, control, poll };
}

test("recovery sends once for this interruption and keeps protection enabled", async (t) => {
  const f = setup(t);
  await f.control("on");
  queryUsage = async () => usage(100);
  await f.poll();
  queryUsage = async () => usage(10);
  await f.poll();
  assert.deepEqual(f.sent, ["继续当前未完成的任务。"]);
  assert.equal((await f.control("status")).phase, "armed");
  t.mock.timers.tick(7 * 86_400_000);
  await setImmediate();
  assert.equal(f.sent.length, 1);
});

test("ready quota without prior exhaustion never resumes", async (t) => {
  const f = setup(t);
  await f.control("on");
  queryUsage = async () => usage(10);
  await f.poll();
  assert.equal(f.sent.length, 0);
  assert.equal((await f.control("status")).phase, "waiting");
});

for (const cancel of ["off", "turn", "archive", "dispose"]) {
  test(`${cancel} in the final refresh/send gap prevents sending`, async (t) => {
    const f = setup(t);
    await f.control("on");
    queryUsage = async () => usage(100);
    await f.poll();
    let refreshCount = 0;
    f.ref.refresh = () => {
      const result = Promise.resolve({ agent: { ...f.snapshot } });
      if (++refreshCount === 2) {
        result.then(() =>
          queueMicrotask(() => {
            if (cancel === "off") void f.control("off");
            else if (cancel === "turn") f.watchdog.onTurnStarted("test-agent");
            else if (cancel === "archive")
              f.watchdog.onArchivedOrClosed("test-agent");
            else f.watchdog.dispose();
          }),
        );
      }
      return result;
    };
    queryUsage = async () => usage(10);
    await f.poll();
    assert.equal(f.sent.length, 0);
    assert.equal((await f.control("status")).nextCheckAt, null);
  });
}

for (const missing of ["null", "absent"]) {
  test(`previously exhausted weekly quota becoming ${missing} blocks recovery`, async (t) => {
    const f = setup(t);
    await f.control("on");
    queryUsage = async () => usage(10, 100);
    await f.poll();
    queryUsage = async () => {
      const result = usage(10, null);
      if (missing === "absent") result[0].report.windows.pop();
      return result;
    };
    await f.poll();
    assert.equal(f.sent.length, 0);
    assert.equal((await f.control("status")).phase, "waiting");
    queryUsage = async () => usage(10, 20);
    await f.poll();
    assert.equal(f.sent.length, 1);
  });
}

test("remembers earlier exhausted windows across later blocked reports", async (t) => {
  const f = setup(t);
  await f.control("on");
  queryUsage = async () => usage(10, 100);
  await f.poll();
  queryUsage = async () => usage(100, 10);
  await f.poll();
  queryUsage = async () => {
    const result = usage(10);
    result[0].report.windows.pop();
    return result;
  };
  await f.poll();
  assert.equal(f.sent.length, 0);
});

test("checks one minute after a near reset instead of waiting fifteen minutes", async (t) => {
  const f = setup(t);
  await f.control("on");
  const resetAt = Date.now() + 60_000;
  queryUsage = async () => {
    const result = usage(100);
    result[0].report.windows[0].resetsAt = new Date(resetAt).toISOString();
    return result;
  };
  await f.poll();
  assert.equal(
    Date.parse((await f.control("status")).nextCheckAt),
    resetAt + 60_000,
  );
});

test("manual off wins while usage is being fetched", async (t) => {
  const f = setup(t);
  await f.control("on");
  queryUsage = async () => usage(100);
  await f.poll();
  queryUsage = async () => {
    await f.control("off");
    return usage(10);
  };
  await f.poll();
  assert.equal(f.sent.length, 0);
  assert.equal((await f.control("status")).phase, "stopped");
});

test("manual off wins while initial arming refresh is pending", async (t) => {
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
});

test("a new user message cancels this recovery but keeps protection enabled", async (t) => {
  const f = setup(t);
  await f.control("on");
  queryUsage = async () => usage(100);
  await f.poll();
  f.snapshot.lastUserMessageAt = "2026-01-01T00:01:00Z";
  queryUsage = async () => usage(10);
  await f.poll();
  assert.equal(f.sent.length, 0);
  assert.equal((await f.control("status")).phase, "armed");
});

test("an account change cancels recovery", async (t) => {
  const f = setup(t);
  await f.control("on");
  queryUsage = async () => usage(100);
  await f.poll();
  queryUsage = async () => usage(10, 20, "claude:other-test-account");
  await f.poll();
  assert.equal(f.sent.length, 0);
  assert.equal((await f.control("status")).phase, "stopped");
});

test("CLI errors wait without disclosing the raw error or sending", async (t) => {
  const f = setup(t);
  await f.control("on");
  queryUsage = async () => {
    throw Object.assign(new Error("synthetic-private-error"), {
      code: "ENOENT",
    });
  };
  await f.poll();
  const status = await f.control("status");
  assert.equal(f.sent.length, 0);
  assert.equal(status.phase, "waiting");
  assert.equal(status.message.includes("synthetic-private-error"), false);
  assert.equal(Date.parse(status.nextCheckAt) - Date.now(), 15 * 60_000);
});

test("a send error never automatically retries", async (t) => {
  const f = setup(t);
  await f.control("on");
  queryUsage = async () => usage(100);
  await f.poll();
  let attempts = 0;
  f.ref.send = async () => {
    attempts++;
    throw new Error("Synthetic send failure");
  };
  queryUsage = async () => usage(10);
  await f.poll();
  t.mock.timers.tick(7 * 86_400_000);
  await setImmediate();
  assert.equal(attempts, 1);
  assert.equal((await f.control("status")).phase, "armed");
});

test("agent refresh failures retry without exposing private error details", async (t) => {
  const f = setup(t);
  await f.control("on");
  const logs = [];
  t.mock.method(console, "error", (...args) => logs.push(args.join(" ")));
  const refresh = f.ref.refresh;
  f.ref.refresh = async () => {
    throw new Error("synthetic-private-error");
  };
  await f.poll();
  const status = await f.control("status");
  assert.equal(status.phase, "waiting");
  assert.equal(Date.parse(status.nextCheckAt) - Date.now(), 15 * 60_000);
  assert.equal(f.sent.length, 0);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].includes("synthetic-private-error"), false);
  f.ref.refresh = refresh;
  queryUsage = async () => usage(100);
  await f.poll();
  queryUsage = async () => usage(10);
  await f.poll();
  assert.equal(f.sent.length, 1);
});

test("ordinary completion, cancellation and other failures keep protection without sending", async (t) => {
  const f = setup(t);
  f.snapshot.status = "idle";
  await f.control("on");
  for (const outcome of [
    { kind: "completed" },
    { kind: "canceled", reason: "user" },
    { kind: "failed", error: { message: "network timeout" } },
  ]) {
    f.watchdog.onTurnStarted("test-agent");
    await f.watchdog.onTurnEnded("test-agent", "claude", outcome, f.paseo);
    assert.equal((await f.control("status")).phase, "armed");
  }
  assert.equal(f.sent.length, 0);
  assert.equal(usageQueries, 0);
});

const quotaFailure = {
  kind: "failed",
  error: { message: "Usage limit reached" },
};

test("protection remains after 48 hours and resumes a later quota interruption", async (t) => {
  const f = setup(t);
  f.snapshot.status = "idle";
  await f.control("on");
  await f.watchdog.onTurnEnded(
    "test-agent",
    "claude",
    { kind: "completed" },
    f.paseo,
  );
  t.mock.timers.tick(48 * 3_600_000);
  await setImmediate();
  assert.equal((await f.control("status")).phase, "armed");
  assert.equal(usageQueries, 0);
  f.watchdog.onTurnStarted("test-agent");
  f.snapshot.status = "error";
  await f.watchdog.onTurnEnded("test-agent", "claude", quotaFailure, f.paseo);
  queryUsage = async () => usage(100);
  await f.poll();
  queryUsage = async () => usage(10);
  await f.poll();
  assert.equal(f.sent.length, 1);
  assert.equal((await f.control("status")).phase, "armed");
});

test("one activation recovers across multiple quota windows", async (t) => {
  const f = setup(t);
  await f.control("on");
  for (let cycle = 0; cycle < 3; cycle++) {
    queryUsage = async () => usage(100);
    await f.poll();
    queryUsage = async () => usage(10);
    await f.poll();
    assert.equal(f.sent.length, cycle + 1);
    assert.equal((await f.control("status")).phase, "armed");
    if (cycle < 2) {
      f.watchdog.onTurnStarted("test-agent");
      await f.watchdog.onTurnEnded(
        "test-agent",
        "claude",
        { kind: "completed" },
        f.paseo,
      );
      t.mock.timers.tick(12 * 3_600_000);
      await setImmediate();
      await f.watchdog.onTurnEnded(
        "test-agent",
        "claude",
        quotaFailure,
        f.paseo,
      );
    }
  }
});

test("manual cancellation cancels a pending resume but permits future quota recovery", async (t) => {
  const f = setup(t);
  await f.control("on");
  queryUsage = async () => usage(100);
  await f.poll();
  await f.watchdog.onTurnEnded(
    "test-agent",
    "claude",
    { kind: "canceled", reason: "user" },
    f.paseo,
  );
  t.mock.timers.tick(7 * 86_400_000);
  await setImmediate();
  assert.equal(f.sent.length, 0);
  assert.equal((await f.control("status")).phase, "armed");
  assert.equal((await f.control("status")).nextCheckAt, null);
  f.watchdog.onTurnStarted("test-agent");
  await f.watchdog.onTurnEnded("test-agent", "claude", quotaFailure, f.paseo);
  queryUsage = async () => usage(100);
  await f.poll();
  queryUsage = async () => usage(10);
  await f.poll();
  assert.equal(f.sent.length, 1);
});

test("an old send acknowledgement cannot override a manual off", async (t) => {
  const f = setup(t);
  await f.control("on");
  queryUsage = async () => usage(100);
  await f.poll();
  let acknowledge;
  f.ref.send = async (text) => {
    f.sent.push(text);
    await new Promise((resolve) => {
      acknowledge = resolve;
    });
  };
  queryUsage = async () => usage(10);
  await f.poll();
  assert.equal((await f.control("status")).phase, "resuming");
  await f.control("off");
  acknowledge();
  await setImmediate();
  assert.equal((await f.control("status")).phase, "stopped");
  assert.equal(f.sent.length, 1);
  await f.watchdog.onTurnEnded("test-agent", "claude", quotaFailure, f.paseo);
  assert.equal((await f.control("status")).nextCheckAt, null);
});

test("a new quota failure before send acknowledgement retains its own recovery state", async (t) => {
  const f = setup(t);
  await f.control("on");
  queryUsage = async () => usage(100);
  await f.poll();
  f.ref.send = async (text) => {
    f.sent.push(text);
    f.watchdog.onTurnStarted("test-agent");
    await f.watchdog.onTurnEnded("test-agent", "claude", quotaFailure, f.paseo);
  };
  queryUsage = async () => usage(10);
  await f.poll();
  assert.equal(f.sent.length, 1);
  assert.equal((await f.control("status")).phase, "waiting");
  await f.poll();
  assert.equal(
    f.sent.length,
    1,
    "A new interruption must observe exhaustion again",
  );
});

test("a new turn invalidates an older quota failure while its refresh is pending", async (t) => {
  const f = setup(t);
  f.snapshot.status = "idle";
  await f.control("on");
  let finish;
  f.ref.refresh = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const waiting = f.watchdog.onTurnEnded(
    "test-agent",
    "claude",
    quotaFailure,
    f.paseo,
  );
  f.watchdog.onTurnStarted("test-agent");
  finish({ agent: { ...f.snapshot } });
  await waiting;
  assert.equal((await f.control("status")).phase, "armed");
  assert.equal((await f.control("status")).nextCheckAt, null);
});

test("pending permissions prevent a resume while retaining future protection", async (t) => {
  const f = setup(t);
  await f.control("on");
  queryUsage = async () => usage(100);
  await f.poll();
  f.snapshot.pendingPermissions = [{ requestId: "test-permission" }];
  queryUsage = async () => usage(10);
  await f.poll();
  assert.equal(f.sent.length, 0);
  assert.equal((await f.control("status")).phase, "armed");
  assert.equal((await f.control("status")).nextCheckAt, null);
});
