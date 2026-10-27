import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

function load(relativePath, modules) {
  const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  });
  const exports = {};
  new Function("require", "exports", outputText)((name) => {
    assert.ok(Object.hasOwn(modules, name), `Unexpected runtime import: ${name}`);
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
    addWorkspacePanel(value) { panel = value; },
    addSlashCommand(value) { command = value; },
  });
  assert.equal(panel.context, "agent");
  assert.equal(panel.Component, WatchdogPanel);
  const calls = [];
  await command.onSubmit({
    args: "status",
    agent: { id: "test-agent" },
    rpc: async (contract, input) => { assert.equal(contract, watchdogControl); calls.push(input); },
    openPanel: (id) => calls.push(id),
  });
  assert.deepEqual(calls, [{ agentId: "test-agent", action: "status" }, "watchdog"]);
});

test("reads the flat agentId supplied by a Paseo 0.12 panel", async () => {
  const calls = [];
  const { WatchdogPanel } = load("../client/panel.tsx", {
    react: {
      useCallback: (callback) => callback,
      useEffect: (callback) => callback(),
      useState: (initial) => [initial, () => {}],
    },
    "react/jsx-runtime": { jsx: () => null, jsxs: () => null },
    "react-native": { Pressable: "Pressable", Text: "Text", View: "View" },
    "@getpaseo/plugin/client": { useRpc: () => async (input) => { calls.push(input); return {}; } },
    "../shared/control": { watchdogControl: {} },
  });
  WatchdogPanel({ agentId: "test-agent", theme: { colors: {} } });
  await Promise.resolve();
  assert.deepEqual(calls, [{ agentId: "test-agent", action: "status" }]);
});
