import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

function load(relativePath, modules) {
  const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
    },
  });
  const exports = {};
  new Function("require", "exports", outputText)((name) => {
    assert.ok(
      Object.hasOwn(modules, name),
      `Unexpected runtime import: ${name}`,
    );
    return modules[name];
  }, exports);
  return exports;
}

test("registers an agent panel using the Paseo 0.12 client contract", async () => {
  const WatchdogPanel = () => null;
  const watchdogControl = {};
  const { default: contribute } = load("../index.client.tsx", {
    "./client/panel": { WatchdogPanel },
    "./shared/control": { watchdogControl },
  });
  let panel;
  let command;
  contribute({
    addWorkspacePanel(value) {
      panel = value;
    },
    addSlashCommand(value) {
      command = value;
    },
  });
  assert.equal(panel.context, "agent");
  assert.equal(panel.Component, WatchdogPanel);
  const calls = [];
  await command.onSubmit({
    args: "status",
    agent: { id: "test-agent" },
    rpc: async (contract, input) => {
      assert.equal(contract, watchdogControl);
      calls.push(input);
    },
    openPanel: (id) => calls.push(id),
  });
  assert.deepEqual(calls, [
    { agentId: "test-agent", action: "status" },
    "watchdog",
  ]);
});

function mountPanel(t, control, agentId = "test-agent") {
  const values = [];
  const writes = [];
  let effect;
  const { WatchdogPanel } = load("../client/panel.tsx", {
    react: {
      useEffect: (callback) => {
        effect = callback;
      },
      useState: (initial) => {
        const index = values.length;
        values.push(initial);
        return [
          initial,
          (value) => {
            values[index] =
              typeof value === "function" ? value(values[index]) : value;
            writes.push(index);
          },
        ];
      },
    },
    "react/jsx-runtime": {
      jsx: (type, props) => ({ type, props }),
      jsxs: (type, props) => ({ type, props }),
    },
    "react-native": { Pressable: "Pressable", Text: "Text", View: "View" },
    "@getpaseo/plugin/client": { useRpc: () => control },
    "../shared/control": { watchdogControl: {} },
  });
  const view = WatchdogPanel({ agentId, theme: { colors: {} } });
  const cleanup = effect();
  t.after(cleanup);
  return { values, writes, cleanup, view };
}

const flush = async () => {
  await new Promise((resolve) => setImmediate(resolve));
};

test("a mounted panel replaces stale off after a command without reopening", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls = [];
  let phase = "off";
  const rpc = async (input) => {
    calls.push(input);
    if (input.action === "on") phase = "armed";
    return { phase };
  };
  const panel = mountPanel(t, rpc);
  await flush();
  assert.equal(panel.values[0].phase, "off");
  const { default: contribute } = load("../index.client.tsx", {
    "./client/panel": { WatchdogPanel: () => null },
    "./shared/control": { watchdogControl: {} },
  });
  let command;
  contribute({
    addWorkspacePanel() {},
    addSlashCommand(value) {
      command = value;
    },
  });
  await command.onSubmit({
    args: "",
    agent: { id: "test-agent" },
    rpc: (_, input) => rpc(input),
    openPanel() {},
  });
  t.mock.timers.tick(3_000);
  await flush();
  assert.equal(panel.values[0].phase, "armed");
  assert.deepEqual(calls, [
    { agentId: "test-agent", action: "status" },
    { agentId: "test-agent", action: "on" },
    { agentId: "test-agent", action: "status" },
  ]);
  assert.ok(
    JSON.stringify(panel.view).includes("test-agent"),
    "Panel identifies its agent",
  );
  panel.cleanup();
  t.mock.timers.tick(30_000);
  await flush();
  assert.equal(calls.length, 3);
});

test("slow panel RPCs do not overlap and late results cannot update an unmounted panel", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let resolve;
  let calls = 0;
  const panel = mountPanel(t, () => {
    calls++;
    return new Promise((done) => {
      resolve = done;
    });
  });
  t.mock.timers.tick(30_000);
  await flush();
  assert.equal(calls, 1);
  panel.cleanup();
  const before = panel.writes.length;
  resolve({ phase: "off" });
  await flush();
  assert.equal(panel.writes.length, before);
  t.mock.timers.tick(30_000);
  await flush();
  assert.equal(calls, 1);
});

test("a failed status refresh clears stale success and hides raw error details", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let fail = false;
  const panel = mountPanel(t, async () => {
    if (fail) throw new Error("synthetic-private-error");
    return { phase: "armed" };
  });
  await flush();
  assert.equal(panel.values[0].phase, "armed");
  fail = true;
  t.mock.timers.tick(3_000);
  await flush();
  assert.equal(panel.values[0], null);
  assert.ok(panel.values[1]);
  assert.equal(panel.values[1].includes("synthetic-private-error"), false);
});
