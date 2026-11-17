import type { PluginClientContext } from "@getpaseo/plugin/client";
import { contributeButtons } from "./client/buttons";
import { SettingsScreen } from "./client/settings";
import { StatusRow } from "./client/status-row";
import { parseArgs } from "./shared/config";
import { startRun, stopRun } from "./shared/rpc";
import { STATUS_KIND, STATUS_VERSION, statusSchema } from "./shared/status";

export default function contribute(client: PluginClientContext) {
  const removers: (() => void)[] = [];
  const start = (agentId: string, args = "") => client.rpc(startRun, { agentId, overrides: parseArgs(args) });
  const stop = (agentId: string) => client.rpc(stopRun, { agentId });

  removers.push(
    client.addSettingsScreen({ id: "settings", title: "Push & fix", icon: "GitPullRequestArrow", Component: SettingsScreen }),
    client.addTimelineRenderer({ kind: STATUS_KIND, version: STATUS_VERSION, schema: statusSchema, Component: StatusRow }),
    client.addSlashCommand({
      name: "push-fix",
      description: "Push, watch CI, and send failures back to this agent until green",
      argumentHint: '[rounds=N] [checks="a,b*"] [timeout=MIN] [pre="…"|no-pre] [no-reviews]',
      context: "agent",
      async onSubmit({ args, agent }) {
        await start(agent.id, args);
      },
    }),
    client.addSlashCommand({
      name: "push-fix-stop",
      description: "Stop the push & fix loop for this agent",
      argumentHint: "",
      context: "agent",
      async onSubmit({ agent }) {
        await stop(agent.id);
      },
    }),
    client.addCommandCenterItem({
      id: "push-fix",
      title: "Push & fix until CI is green",
      icon: "GitPullRequestArrow",
      keywords: ["push", "ci", "checks", "ralph"],
      context: "agent",
      async onSelect({ agent }) {
        await start(agent.id);
      },
    }),
    client.addCommandCenterItem({
      id: "push-fix-stop",
      title: "Stop push & fix",
      icon: "CircleStop",
      keywords: ["push", "ci", "ralph"],
      context: "agent",
      async onSelect({ agent }) {
        await stop(agent.id);
      },
    }),
    client.addCommandCenterItem({
      id: "push-fix-settings",
      title: "Push & fix settings",
      icon: "Settings",
      context: "global",
      onSelect({ openSettings }) {
        openSettings("settings");
      },
    }),
  );

  removers.push(
    contributeButtons(client, {
      start: (agentId) => start(agentId),
      stop: (agentId) => stop(agentId),
      openSettings: () => client.openSettings("settings"),
    }),
  );

  return () => {
    for (const remove of removers) remove();
  };
}
