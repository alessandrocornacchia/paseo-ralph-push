import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PluginHandlerContext, PluginTurnOutcome } from "@getpaseo/plugin/server";
import {
  type PushFixConfig,
  type PushFixOverrides,
  configSchema,
  partialConfigSchema,
  REPO_CONFIG_PATH,
} from "../shared/config";
import {
  type Phase,
  type PushFixStatus,
  STATUS_KIND,
  STATUS_VERSION,
  isTerminal,
} from "../shared/status";
import {
  type Check,
  failedJobLog,
  fetchChecks,
  fetchReviewNotes,
  findOpenPr,
  git,
  gh,
  matchesAny,
  tail,
} from "./github";

type PaseoApi = PluginHandlerContext["paseo"];

const LOG_CHARS_PER_CHECK = 6_000;
const SUMMARY_CHARS_PER_CHECK = 3_000;
const NOTE_CHARS = 3_000;
const PROMPT_CHARS = 40_000;

interface Run {
  id: string;
  agentId: string;
  cwd: string;
  repo: string;
  branch: string;
  config: PushFixConfig;
  paseo: PaseoApi;
  round: number;
  phase: Phase;
  sha: string | null;
  pushedAt: Date | null;
  awaitingTurn: "prepare" | "fix" | null;
  checks: Check[];
  message: string;
  /** Bumped after every prompt to the agent, so the next status row lands below its reply. */
  rowSeq: number;
  timer: ReturnType<typeof setTimeout> | null;
}

export class PushFixLoops {
  private readonly runs = new Map<string, Run>();

  constructor(private readonly readSettings: () => Promise<PushFixConfig>) {}

  async start(paseo: PaseoApi, agentId: string, overrides: PushFixOverrides): Promise<string> {
    const existing = this.runs.get(agentId);
    if (existing && !isTerminal(existing.phase)) {
      throw new Error("A push & fix loop is already running for this agent. Stop it first.");
    }
    const agent = paseo.agents.ref(agentId);
    await agent.refresh();
    if (agent.activeTurn) throw new Error("The agent is busy. Start push & fix when its turn ends.");
    const cwd = agent.cwd;
    if (!cwd) throw new Error("The agent has no working directory.");

    const branch = await git(cwd, "rev-parse", "--abbrev-ref", "HEAD");
    if (branch === "HEAD") throw new Error("Detached HEAD: check out a branch first.");
    const repo = await gh(cwd, "repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner");
    const config = await this.resolveConfig(cwd, overrides);

    const run: Run = {
      id: `run-${Date.now().toString(36)}`,
      agentId,
      cwd,
      repo,
      branch,
      config,
      paseo,
      round: 0,
      phase: "pushing",
      sha: null,
      pushedAt: null,
      awaitingTurn: null,
      checks: [],
      message: "",
      rowSeq: 0,
      timer: null,
    };
    this.runs.set(agentId, run);
    void this.beginCycle(run);
    return run.id;
  }

  async stop(agentId: string, reason = "Stopped by user."): Promise<boolean> {
    const run = this.runs.get(agentId);
    if (!run || isTerminal(run.phase)) return false;
    await this.finish(run, "stopped", reason);
    return true;
  }

  async onTurnEnded(agentId: string, outcome: PluginTurnOutcome): Promise<void> {
    const run = this.runs.get(agentId);
    if (!run?.awaitingTurn || isTerminal(run.phase)) return;
    const waitedFor = run.awaitingTurn;
    run.awaitingTurn = null;
    if (outcome.kind === "canceled") {
      return this.finish(run, "stopped", "Agent turn was canceled; push & fix stopped.");
    }
    if (outcome.kind === "failed") {
      return this.finish(run, "error", `Agent turn failed: ${outcome.error.message}`);
    }
    if (waitedFor === "fix") run.round += 1;
    await this.beginCycle(run, waitedFor === "prepare");
  }

  dispose(): void {
    for (const run of this.runs.values()) this.clearTimer(run);
    this.runs.clear();
  }

  private async resolveConfig(cwd: string, overrides: PushFixOverrides): Promise<PushFixConfig> {
    const base = await this.readSettings();
    let repoOverrides: PushFixOverrides = {};
    try {
      const text = await readFile(join(cwd, REPO_CONFIG_PATH), "utf8");
      repoOverrides = partialConfigSchema.parse(JSON.parse(text));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(`Invalid ${REPO_CONFIG_PATH}: ${(error as Error).message}`);
      }
    }
    return configSchema.parse({ ...base, ...repoOverrides, ...overrides });
  }

  /** Runs the pre-push instructions when due, then pushes. */
  private async beginCycle(run: Run, prepared = false): Promise<void> {
    try {
      const { prePushInstructions, prePushEveryRound } = run.config;
      const due = prePushInstructions.trim() && (run.round === 0 || prePushEveryRound);
      if (due && !prepared) {
        run.awaitingTurn = "prepare";
        await this.publish(run, "preparing", "Asked the agent to run the pre-push instructions.");
        await run.paseo.agents.ref(run.agentId).send(
          `[push-fix] Before I push \`${run.branch}\`, do the following:\n\n${prePushInstructions.trim()}\n\n` +
            "Commit everything that should be pushed. Do not push; the push-fix plugin pushes when your turn ends.",
        );
        run.rowSeq += 1;
        return;
      }
      await this.push(run);
    } catch (error) {
      await this.finish(run, "error", (error as Error).message);
    }
  }

  private async push(run: Run): Promise<void> {
    const head = await git(run.cwd, "rev-parse", "HEAD");
    if (run.round > 0 && head === run.sha) {
      return this.finish(run, "stopped", "The agent made no new commit after the fix prompt; nothing to push.");
    }
    const dirty = await git(run.cwd, "status", "--porcelain");
    await this.publish(run, "pushing", `Pushing ${short(head)}…`, head);

    const hasUpstream = await git(run.cwd, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}")
      .then(() => true, () => false);
    await git(run.cwd, "push", ...(hasUpstream ? [] : ["-u"]), run.config.remote, `HEAD:refs/heads/${run.branch}`);

    run.sha = head;
    run.pushedAt = new Date();
    run.checks = [];
    const note = dirty ? " (uncommitted changes were not pushed)" : "";
    await this.publish(run, "watching", `Pushed ${short(head)}${note} · waiting for checks…`);
    this.schedulePoll(run, 10_000);
  }

  private schedulePoll(run: Run, delayMs = run.config.pollIntervalSec * 1000): void {
    this.clearTimer(run);
    run.timer = setTimeout(() => void this.poll(run), delayMs);
  }

  private async poll(run: Run): Promise<void> {
    run.timer = null;
    if (run.phase !== "watching" || !run.sha || !run.pushedAt) return;
    try {
      const all = await fetchChecks(run.cwd, run.repo, run.sha);
      const patterns = run.config.checks;
      const watched = patterns.length ? all.filter((c) => matchesAny(c.name, patterns)) : all;
      run.checks = watched;

      const missing = patterns.filter((p) => !watched.some((c) => matchesAny(c.name, [p])));
      const pending = watched.filter((c) => c.state === "pending");
      const failed = watched.filter((c) => c.state === "failure");
      const elapsedMin = (Date.now() - run.pushedAt.getTime()) / 60_000;

      if (pending.length || missing.length || !watched.length) {
        if (elapsedMin >= run.config.timeoutMin) {
          const waitingOn = [...pending.map((c) => c.name), ...missing].join(", ") || "any check";
          return this.finish(run, "error", `Timed out after ${run.config.timeoutMin} min waiting for ${waitingOn}.`);
        }
        const parts = [`${watched.length - pending.length}/${watched.length} checks done`];
        if (failed.length) parts.push(`${failed.length} failed`);
        if (missing.length) parts.push(`waiting for ${missing.join(", ")} to start`);
        await this.publish(run, "watching", `Pushed ${short(run.sha)} · ${parts.join(" · ")}`);
        return this.schedulePoll(run);
      }

      const pr = run.config.includeReviews ? await findOpenPr(run.cwd, run.branch) : null;
      const notes = pr ? await fetchReviewNotes(run.cwd, run.repo, pr, run.pushedAt) : [];
      const blocking = notes.filter((n) => n.state === "CHANGES_REQUESTED");

      if (!failed.length && !blocking.length) {
        return this.finish(run, "green", `All ${watched.length} watched checks passed on ${short(run.sha)}.`);
      }
      if (run.round >= run.config.maxRounds) {
        return this.finish(
          run,
          "failed",
          `${failed.length} check(s) failed on ${short(run.sha)} and the cap of ${run.config.maxRounds} fix round(s) is reached.`,
        );
      }
      await this.requestFix(run, failed, notes);
    } catch (error) {
      // gh/network hiccups should not end the loop; retry on the next tick.
      console.error(`[push-fix] poll failed for ${run.agentId}:`, error);
      await this.publish(run, "watching", `Pushed ${short(run.sha)} · poll failed, retrying: ${(error as Error).message}`);
      this.schedulePoll(run);
    }
  }

  private async requestFix(run: Run, failed: Check[], notes: Awaited<ReturnType<typeof fetchReviewNotes>>) {
    const sections: string[] = [];
    for (const check of failed) {
      const log = await failedJobLog(run.cwd, check, LOG_CHARS_PER_CHECK);
      const body = [check.summary && tail(check.summary, SUMMARY_CHARS_PER_CHECK), log && `Failed log:\n${log}`]
        .filter(Boolean)
        .join("\n\n");
      sections.push(`### ${check.name} — ${check.conclusion}${check.url ? `\n${check.url}` : ""}\n\n${fence(body || "(no details available)")}`);
    }
    const noteLines = notes.map((n) => {
      const where = n.path ? ` on \`${n.path}\`` : "";
      const state = n.state ? ` [${n.state}]` : "";
      return `### ${n.author} (${n.kind}${state})${where}\n${n.url}\n\n${tail(n.body, NOTE_CHARS)}`;
    });

    const round = run.round + 1;
    let prompt =
      `[push-fix] Round ${round}/${run.config.maxRounds}: CI on \`${run.branch}\` @ ${short(run.sha!)} needs fixes.\n\n` +
      (sections.length ? `## Failed checks\n\n${sections.join("\n\n")}\n\n` : "") +
      (noteLines.length ? `## Review feedback since the push\n\n${noteLines.join("\n\n")}\n\n` : "") +
      "Fix the problems, verify locally where you can, and commit the fix. Do not push: the push-fix plugin pushes " +
      "and re-checks when your turn ends. If a failure cannot be fixed in code (flaky infra, missing secret), say so " +
      "and do not commit; that stops the loop.";
    if (run.config.fixInstructions.trim()) prompt += `\n\n${run.config.fixInstructions.trim()}`;
    prompt = tail(prompt, PROMPT_CHARS);

    run.awaitingTurn = "fix";
    const what = [failed.length && `${failed.length} failed check(s)`, notes.length && `${notes.length} review note(s)`]
      .filter(Boolean)
      .join(", ");
    await this.publish(run, "fixing", `Sent ${what} to the agent · fix round ${round}/${run.config.maxRounds}`);
    await run.paseo.agents.ref(run.agentId).send(prompt);
    run.rowSeq += 1;
  }

  private async finish(run: Run, phase: Phase, message: string): Promise<void> {
    this.clearTimer(run);
    run.awaitingTurn = null;
    await this.publish(run, phase, message);
  }

  private clearTimer(run: Run): void {
    if (run.timer) clearTimeout(run.timer);
    run.timer = null;
  }

  private async publish(run: Run, phase: Phase, message: string, sha = run.sha): Promise<void> {
    run.phase = phase;
    run.message = message;
    const data: PushFixStatus = {
      runId: run.id,
      round: run.round,
      maxRounds: run.config.maxRounds,
      phase,
      branch: run.branch,
      sha,
      message,
      checks: run.checks.slice(0, 50).map((c) => ({ name: c.name, state: c.state, url: c.url })),
      updatedAt: new Date().toISOString(),
    };
    try {
      // Re-appending the same id updates the row in place.
      await run.paseo.agents.ref(run.agentId).timeline.append({
        type: "plugin",
        id: `${run.id}-${run.rowSeq}`,
        kind: STATUS_KIND,
        version: STATUS_VERSION,
        data,
      });
    } catch (error) {
      console.error("[push-fix] timeline append failed:", error);
    }
  }
}

const short = (sha: string) => sha.slice(0, 8);
const fence = (text: string) => `\`\`\`\n${text.replace(/```/g, "ˋˋˋ")}\n\`\`\``;
