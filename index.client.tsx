import type { PluginClientContext } from "@getpaseo/plugin/client";
import { WatchdogPanel } from "./client/panel";
import { watchdogControl } from "./shared/control";

export default function contribute(client: PluginClientContext) {
  client.addWorkspacePanel({
    id: "watchdog",
    title: "Paseo Watchdog",
    icon: "Clock",
    context: "agent",
    Component: WatchdogPanel,
  });
  client.addSlashCommand({
    name: "paseo-watchdog",
    description: "持续保护当前 Claude 会话，额度刷新后自动恢复长任务",
    argumentHint: "[on|off|status]",
    context: "agent",
    async onSubmit({ args, agent, rpc, openPanel }) {
      const action = args.trim().toLowerCase() || "on";
      if (action !== "on" && action !== "off" && action !== "status") {
        throw new Error("用法：/paseo-watchdog [on|off|status]");
      }
      await rpc(watchdogControl, { agentId: agent.id, action });
      openPanel("watchdog");
    },
  });
  return () => {};
}
