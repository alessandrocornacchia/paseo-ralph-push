import type {
  PluginButton,
  PluginButtonMenuEntry,
  PluginButtonRegistration,
  PluginClientContext,
} from "@getpaseo/plugin/client";

export const BUTTON_LABEL = "Push (Ralph)";
const ICON = "GitPullRequestArrow";

export interface ButtonActions {
  start(agentId: string): Promise<unknown>;
  stop(agentId: string): Promise<unknown>;
  openSettings(): void;
}

interface AgentEntry {
  id: string;
  workspaceId: string;
  title: string;
}

type ButtonClient = Pick<PluginClientContext, "addHeaderButton" | "addComposerPill" | "paseo">;

/**
 * Follows the agent directory and keeps two kinds of buttons in sync:
 * a "Push (Ralph)" header button per workspace and a composer pill per agent.
 */
export function contributeButtons(client: ButtonClient, actions: ButtonActions): () => void {
  const agents = new Map<string, AgentEntry>();
  const pills = new Map<string, { workspaceId: string; pill: PluginButtonRegistration }>();
  const headers = new Map<string, { signature: string; button: PluginButtonRegistration }>();
  const lifetime = new AbortController();

  const run = (fn: () => Promise<unknown>) => async () => {
    await fn();
  };

  const pillButton = (agentId: string): PluginButton => ({
    title: "Push, watch CI, and fix until green",
    icon: ICON,
    label: BUTTON_LABEL,
    behavior: {
      kind: "menu",
      items: [
        { kind: "item", id: "start", title: "Push and fix until green", icon: "Upload", behavior: { kind: "action", onPress: run(() => actions.start(agentId)) } },
        { kind: "item", id: "stop", title: "Stop", icon: "CircleStop", behavior: { kind: "action", onPress: run(() => actions.stop(agentId)) } },
        { kind: "separator", id: "sep" },
        { kind: "item", id: "settings", title: "Settings", icon: "Settings", behavior: { kind: "action", onPress: actions.openSettings } },
      ],
    },
  });

  // One agent: a single press starts. Several: pick the agent that should fix failures.
  const headerButton = (members: AgentEntry[]): PluginButton => {
    const title = "Push, watch CI, and send failures back to the agent until green";
    if (members.length === 1) {
      return { title, icon: ICON, label: BUTTON_LABEL, visible: true, behavior: { kind: "action", onPress: run(() => actions.start(members[0].id)) } };
    }
    const items: PluginButtonMenuEntry[] = members.map((agent, index) => ({
      kind: "item",
      id: `agent-${index}`,
      title: `Push with ${agent.title}`,
      behavior: { kind: "action", onPress: run(() => actions.start(agent.id)) },
    }));
    items.push(
      { kind: "separator", id: "sep" },
      { kind: "item", id: "settings", title: "Settings", icon: "Settings", behavior: { kind: "action", onPress: actions.openSettings } },
    );
    return { title, icon: ICON, label: BUTTON_LABEL, visible: members.length > 0, behavior: { kind: "menu", items } };
  };

  const syncHeader = (workspaceId: string) => {
    const members = [...agents.values()].filter((a) => a.workspaceId === workspaceId);
    const existing = headers.get(workspaceId);
    if (!members.length) {
      existing?.button.remove();
      headers.delete(workspaceId);
      return;
    }
    // Agent updates are frequent; updating the button closes an open menu, so only do it on change.
    const signature = JSON.stringify(members.map((a) => [a.id, a.title]));
    if (existing?.signature === signature) return;
    const button = headerButton(members);
    if (existing) {
      existing.button.update(button);
      existing.signature = signature;
    } else {
      headers.set(workspaceId, { signature, button: client.addHeaderButton({ id: "push-ralph", workspaceId, button }) });
    }
  };

  const removeAgent = (agentId: string) => {
    const previous = agents.get(agentId);
    agents.delete(agentId);
    pills.get(agentId)?.pill.remove();
    pills.delete(agentId);
    if (previous) syncHeader(previous.workspaceId);
  };

  const upsertAgent = (agent: {
    id: string;
    workspaceId?: string | null;
    title?: string | null;
    archivedAt?: string | null;
    internal?: boolean;
  }) => {
    if (lifetime.signal.aborted) return;
    if (!agent.workspaceId || agent.archivedAt || agent.internal) return removeAgent(agent.id);
    const workspaceId = agent.workspaceId;
    const previous = agents.get(agent.id);
    agents.set(agent.id, { id: agent.id, workspaceId, title: agent.title || agent.id.slice(0, 8) });

    if (pills.get(agent.id)?.workspaceId !== workspaceId) {
      pills.get(agent.id)?.pill.remove();
      pills.set(agent.id, {
        workspaceId,
        pill: client.addComposerPill({ id: "push-ralph", workspaceId, agentId: agent.id, button: pillButton(agent.id) }),
      });
    }
    if (previous && previous.workspaceId !== workspaceId) syncHeader(previous.workspaceId);
    syncHeader(workspaceId);
  };

  const removeAll = () => {
    for (const { pill } of pills.values()) pill.remove();
    for (const { button } of headers.values()) button.remove();
    pills.clear();
    headers.clear();
    agents.clear();
  };

  void client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal })
    .then(({ subscription }) => {
      subscription.subscribe({
        snapshot: ({ entries }) => {
          removeAll();
          for (const { agent } of entries) upsertAgent(agent);
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "upsert") upsertAgent(update.agent);
          else removeAgent(update.agentId);
        },
      });
      return undefined;
    })
    .catch((error) => {
      if (!lifetime.signal.aborted) console.error("[push-fix] agent observation failed", error);
    });

  return () => {
    lifetime.abort();
    removeAll();
  };
}
