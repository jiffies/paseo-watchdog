import type { PluginClientContext } from "@getpaseo/plugin/client";
import { WatchdogPanel } from "./client/panel";
import { watchdogControl } from "./shared/control";

export default function contribute(client: PluginClientContext) {
  client.addAgentPanel({
    id: "watchdog",
    title: "Paseo Watchdog",
    icon: "Clock",
    Component: WatchdogPanel,
  });
  client.addSlashCommand({
    name: "paseo-watchdog",
    description: "当前 Claude 会话额度耗尽后，一次性自动恢复（零轮询对话）",
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
