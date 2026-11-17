import type { PluginServerContext } from "@getpaseo/plugin/server";
import { configSchema, pushFixSettings } from "./shared/config";
import { startRun, stopRun } from "./shared/rpc";
import { PushFixLoops } from "./server/loop";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(pushFixSettings);
  const loops = new PushFixLoops(async () => {
    const state = await settings.read();
    if (state.status !== "ready") throw new Error(`Push & fix settings are invalid: ${state.error}`);
    return configSchema.parse(state.values);
  });

  server.handle(startRun, async ({ agentId, overrides }, { paseo }) => ({
    runId: await loops.start(paseo, agentId, overrides),
  }));
  server.handle(stopRun, async ({ agentId }) => ({ stopped: await loops.stop(agentId) }));

  const removers = [
    server.addHook("agent.turn.after", async ({ agent, outcome }) => {
      await loops.onTurnEnded(agent.id, outcome);
    }),
    server.addHook("agent.archive.after", async ({ agent }) => {
      await loops.stop(agent.id, "Agent was archived.");
    }),
  ];

  return () => {
    for (const remove of removers) remove();
    loops.dispose();
  };
}
