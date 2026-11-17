// Contract test: loads both plugin entries the way Paseo does, against fakes
// typed with the SDK's own context types. A Paseo SDK change that drifts from
// what this plugin relies on fails `npm run typecheck` or these assertions.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";

// Host side effects: every git/gh call goes through this mock.
const exec = vi.hoisted(() => vi.fn());
vi.mock("@getpaseo/plugin/server", () => ({ execCommand: exec }));
// Client UI modules need the app runtime; the contract is in the registrations.
vi.mock("react-native", () => ({ Text: "Text", View: "View", Pressable: "Pressable" }));
vi.mock("@getpaseo/plugin/client/ui", () => ({}));
vi.mock("@getpaseo/plugin/client", () => ({ useSettings: vi.fn(), openExternalUrl: vi.fn() }));

import contributeClient from "../index.client";
import contributeServer from "../index.server";
import { configSchema, pushFixSettings } from "../shared/config";
import { startRun, stopRun } from "../shared/rpc";
import { STATUS_KIND, statusSchema } from "../shared/status";

/** Implements only `impl`; any other member access throws, so new host API usage is caught. */
function strict<T extends object>(name: string, impl: T): T {
  return new Proxy(impl, {
    get(target, key) {
      if (key in target || typeof key === "symbol" || key === "then") return Reflect.get(target, key);
      throw new Error(`${name}.${String(key)} is not implemented by the fake host`);
    },
  });
}

type Handler = (input: unknown, context: PluginHandlerContext) => unknown;
type Hook = (payload: unknown, context: unknown) => Promise<unknown>;

function fakeServer(settings: Partial<ReturnType<typeof configSchema.parse>> = {}) {
  const handlers = new Map<string, Handler>();
  const hooks = new Map<string, Hook>();
  const removedHooks: string[] = [];
  const registeredSettings: unknown[] = [];
  const impl: Pick<PluginServerContext, "handle" | "registerSettings" | "addHook"> = {
    handle(contract, handler) {
      handlers.set(contract.name, handler as Handler);
    },
    registerSettings(definition) {
      registeredSettings.push(definition);
      return {
        read: async () => ({ status: "ready" as const, revision: "1", values: configSchema.parse(settings) }),
        subscribe: () => () => {},
      } as never;
    },
    addHook(name, handler) {
      hooks.set(name, handler as Hook);
      return () => removedHooks.push(name);
    },
  };
  return { server: strict("server", impl) as PluginServerContext, handlers, hooks, removedHooks, registeredSettings };
}

function fakeAgent() {
  const sent: string[] = [];
  const rows = new Map<string, unknown>();
  const agent = {
    cwd: "/repo",
    activeTurn: null,
    refresh: vi.fn(async () => null),
    send: vi.fn(async (text: string) => {
      sent.push(text);
    }),
    timeline: {
      append: vi.fn(async (item: { id: string; data: unknown }) => {
        rows.set(item.id, item.data);
        return {};
      }),
    },
  };
  const paseo = { agents: { ref: (id: string) => (expect(id).toBe("agent-1"), agent) } };
  return { agent, sent, rows, context: { paseo } as unknown as PluginHandlerContext };
}

/** A tiny git + GitHub: HEAD moves when the test commits, checks are set per SHA. */
function fakeRepo() {
  const state = { head: "a".repeat(40), pushed: [] as string[], checks: new Map<string, unknown[]>() };
  exec.mockImplementation(async (cmd: string, args: string[]) => {
    const line = `${cmd} ${args.join(" ")}`;
    const out = (stdout: unknown) => ({ stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout), stderr: "" });
    if (line === "git rev-parse --abbrev-ref HEAD") return out("feat");
    if (line === "git rev-parse HEAD") return out(state.head);
    if (line.startsWith("git rev-parse --abbrev-ref --symbolic-full-name")) return out("origin/feat");
    if (line === "git status --porcelain") return out("");
    if (line.startsWith("git push")) {
      state.pushed.push(state.head);
      return out("");
    }
    if (line.startsWith("gh repo view")) return out("me/repo");
    const runs = line.match(/commits\/(\w+)\/check-runs/);
    // `gh api --paginate --jq '.check_runs[]'` prints one compact JSON item per line.
    if (runs) return out((state.checks.get(runs[1]) ?? []).map((r) => JSON.stringify(r)).join("\n"));
    if (/commits\/\w+\/status/.test(line)) return out({ statuses: [] });
    if (line.startsWith("gh run view")) return out("job\tbuild\t2026-01-01T00:00:00Z error: boom");
    if (line.startsWith("gh pr list")) return out([]);
    throw new Error(`unexpected command: ${line}`);
  });
  return state;
}

const checkRun = (id: number, name: string, conclusion: string | null) => ({
  id,
  name,
  status: conclusion ? "completed" : "in_progress",
  conclusion,
  html_url: `https://github.com/me/repo/actions/runs/1/job/${id}`,
  details_url: null,
  output: { title: conclusion, summary: null, text: null },
});

describe("server entry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    exec.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it("registers its settings, RPCs and hooks, and removes hooks on cleanup", () => {
    const { server, handlers, hooks, removedHooks, registeredSettings } = fakeServer();
    const cleanup = contributeServer(server);
    expect(registeredSettings).toEqual([pushFixSettings]);
    expect([...handlers.keys()].sort()).toEqual([startRun.name, stopRun.name].sort());
    expect([...hooks.keys()].sort()).toEqual(["agent.archive.after", "agent.turn.after"]);
    expect(typeof cleanup).toBe("function");
    void (cleanup as () => void)();
    expect(removedHooks.sort()).toEqual(["agent.archive.after", "agent.turn.after"]);
  });

  it("stop without a run satisfies its contract", async () => {
    const { server, handlers } = fakeServer();
    contributeServer(server);
    const result = await handlers.get(stopRun.name)!(stopRun.input.parse({ agentId: "agent-1" }), fakeAgent().context);
    expect(stopRun.output.parse(result)).toEqual({ stopped: false });
  });

  it("pushes, sends watched failures to the agent, re-pushes its fix, and stops when green", async () => {
    const repo = fakeRepo();
    const { server, handlers, hooks } = fakeServer({ checks: ["Docs*"], maxRounds: 2, pollIntervalSec: 30 });
    contributeServer(server);
    const { sent, rows, context } = fakeAgent();

    const started = await handlers.get(startRun.name)!(startRun.input.parse({ agentId: "agent-1" }), context);
    expect(startRun.output.parse(started).runId).toMatch(/^run-/);
    await vi.waitFor(() => expect(repo.pushed).toEqual([repo.head]));

    // An unwatched check failing does not count; the watched one failing does.
    repo.checks.set(repo.head, [checkRun(1, "Docs Review", "failure"), checkRun(2, "lint", "failure")]);
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toContain("Round 1/2");
    expect(sent[0]).toContain("Docs Review");
    expect(sent[0]).not.toContain("### lint");
    expect(sent[0]).toContain("error: boom");

    // The agent commits a fix and its turn ends: the plugin pushes the new HEAD.
    repo.head = "b".repeat(40);
    repo.checks.set(repo.head, [checkRun(3, "Docs Review", "success")]);
    await hooks.get("agent.turn.after")!({ agent: { id: "agent-1" }, turnId: "t1", outcome: { kind: "completed" } }, context);
    expect(repo.pushed).toEqual(["a".repeat(40), "b".repeat(40)]);

    await vi.advanceTimersByTimeAsync(10_000);
    const last = statusSchema.parse([...rows.values()].at(-1));
    expect(last).toMatchObject({ phase: "green", round: 1, sha: "b".repeat(40) });
    expect(sent).toHaveLength(1);
  });

  it("stops at the round cap without prompting the agent again", async () => {
    const repo = fakeRepo();
    const { server, handlers } = fakeServer({ maxRounds: 0 });
    contributeServer(server);
    const { sent, rows, context } = fakeAgent();
    repo.checks.set(repo.head, [checkRun(1, "test", "failure")]);

    await handlers.get(startRun.name)!(startRun.input.parse({ agentId: "agent-1" }), context);
    await vi.waitFor(() => expect(repo.pushed).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(statusSchema.parse([...rows.values()].at(-1)).phase).toBe("failed");
    expect(sent).toEqual([]);
  });
});

describe("client entry", () => {
  it("registers its surfaces and a Push (Ralph) header button per workspace", async () => {
    const headers: Parameters<PluginClientContext["addHeaderButton"]>[0][] = [];
    const pills: unknown[] = [];
    const slash: string[] = [];
    const commands: string[] = [];
    const rpcCalls: { name: string; input: unknown }[] = [];
    const removed = vi.fn();
    const release = vi.fn();
    let timelineKind = "";

    const impl: Pick<
      PluginClientContext,
      | "rpc"
      | "openSettings"
      | "addSettingsScreen"
      | "addTimelineRenderer"
      | "addSlashCommand"
      | "addCommandCenterItem"
      | "addHeaderButton"
      | "addComposerPill"
    > & { paseo: { agents: Pick<PluginClientContext["paseo"]["agents"], "list"> } } = {
      async rpc(contract, input) {
        rpcCalls.push({ name: contract.name, input });
        return contract.output.parse({ runId: "run-x" });
      },
      openSettings: vi.fn(),
      addSettingsScreen: () => removed,
      addTimelineRenderer(contribution) {
        timelineKind = contribution.kind;
        return removed;
      },
      addSlashCommand(contribution) {
        slash.push(contribution.name);
        return removed;
      },
      addCommandCenterItem(contribution) {
        commands.push(contribution.id);
        return removed;
      },
      addHeaderButton(contribution) {
        const entry = { ...contribution };
        headers.push(entry);
        return { update: (patch) => void (entry.button = { ...entry.button, ...patch }), remove: removed };
      },
      addComposerPill(contribution) {
        pills.push(contribution);
        return { update: vi.fn(), remove: removed };
      },
      paseo: {
        agents: {
          list: (async () => ({
            subscription: {
              release,
              subscribe({ snapshot }: { snapshot: (s: unknown) => void }) {
                snapshot({
                  entries: [
                    { agent: { id: "agent-1", workspaceId: "ws1", title: "Fixer" } },
                    { agent: { id: "agent-2", workspaceId: "ws2", title: "A" } },
                    { agent: { id: "agent-3", workspaceId: "ws2", title: "B" } },
                    { agent: { id: "agent-4", workspaceId: "ws2", title: "Old", archivedAt: "2026-01-01" } },
                  ],
                });
              },
            },
          })) as unknown as PluginClientContext["paseo"]["agents"]["list"],
        },
      },
    };

    const cleanup = contributeClient(strict("client", impl) as unknown as PluginClientContext);
    await vi.waitFor(() => expect(headers).toHaveLength(2));

    expect(timelineKind).toBe(STATUS_KIND);
    expect(slash.sort()).toEqual(["push-fix", "push-fix-stop"]);
    expect(commands.sort()).toEqual(["push-fix", "push-fix-settings", "push-fix-stop"]);
    expect(pills).toHaveLength(3);

    const [single, multi] = headers.sort((a, b) => a.workspaceId.localeCompare(b.workspaceId));
    expect(single.button.label).toBe("Push (Ralph)");
    expect(multi.button.label).toBe("Push (Ralph)");
    if (single.button.behavior.kind !== "action") throw new Error("one agent: expected a one-press action");
    await single.button.behavior.onPress();
    expect(rpcCalls).toEqual([{ name: startRun.name, input: { agentId: "agent-1", overrides: {} } }]);

    if (multi.button.behavior.kind !== "menu") throw new Error("several agents: expected a menu");
    const titles = multi.button.behavior.items.flatMap((e) => (e.kind === "item" ? [e.title] : []));
    expect(titles).toEqual(["Push with A", "Push with B", "Settings"]);
    // Paseo rejects menu entry ids outside /^[a-z][a-z0-9-]*$/.
    for (const entry of multi.button.behavior.items) expect(entry.id).toMatch(/^[a-z][a-z0-9-]*$/);

    (cleanup as () => void)();
    expect(removed).toHaveBeenCalled();
  });
});
