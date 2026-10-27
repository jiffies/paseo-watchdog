import type { PluginServerContext } from "@getpaseo/plugin/server";
import { watchdogControl } from "./shared/control";
import { Watchdog } from "./server/watchdog";

export default function contribute(server: PluginServerContext) {
  const watchdog = new Watchdog();

  server.handle(watchdogControl, ({ agentId, action }, { paseo }) =>
    watchdog.control(agentId, action, paseo),
  );
  server.on("agent.turn_ended", (event, { paseo }) =>
    watchdog.onTurnEnded(event.agent.id, event.agent.provider, event.outcome, paseo),
  );
  server.on("agent.turn_started", (event) => watchdog.onTurnStarted(event.agent.id));
  server.on("agent.closed", (event) => watchdog.onArchivedOrClosed(event.agent.id));
  server.on("agent.archived", (event) => watchdog.onArchivedOrClosed(event.agent.id));

  return () => watchdog.dispose();
}
