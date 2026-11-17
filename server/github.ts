import { execCommand } from "@getpaseo/plugin/server";
import type { CheckState } from "../shared/status";

const MAX_BUFFER = 16 * 1024 * 1024;

export async function run(cmd: string, args: string[], cwd: string, timeoutMs = 60_000): Promise<string> {
  try {
    const { stdout } = await execCommand(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: MAX_BUFFER });
    return stdout.trim();
  } catch (error) {
    const err = error as { stderr?: string; message?: string };
    const detail = (err.stderr || err.message || String(error)).trim();
    throw new Error(`${cmd} ${args.join(" ")} failed: ${detail}`);
  }
}

export const git = (cwd: string, ...args: string[]) => run("git", args, cwd);
export const gh = (cwd: string, ...args: string[]) => run("gh", args, cwd);
export const ghJson = async <T>(cwd: string, ...args: string[]): Promise<T> => JSON.parse(await gh(cwd, ...args)) as T;

/**
 * Every item of a paginated list endpoint. `select` is the jq path to the items in one
 * page (`.[]`, `.check_runs[]`). `--jq` prints one compact JSON item per line; this
 * avoids `--slurp`, which needs gh 2.48 or newer.
 */
export async function ghList<T>(cwd: string, path: string, select = ".[]"): Promise<T[]> {
  const out = await gh(cwd, "api", "--paginate", "--jq", select, path);
  return out.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as T);
}

export interface Check {
  name: string;
  state: CheckState;
  conclusion: string;
  url: string | null;
  checkRunId: number | null;
  summary: string;
}

interface CheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string | null;
  details_url: string | null;
  output?: { title?: string | null; summary?: string | null; text?: string | null };
}

interface CommitStatus {
  id: number;
  context: string;
  state: "pending" | "success" | "failure" | "error";
  target_url: string | null;
  description: string | null;
}

/** All check runs and commit statuses for `sha`, latest attempt per name. */
export async function fetchChecks(cwd: string, repo: string, sha: string): Promise<Check[]> {
  const [runs, statuses] = await Promise.all([
    ghList<CheckRun>(cwd, `repos/${repo}/commits/${sha}/check-runs?per_page=100`, ".check_runs[]"),
    ghJson<{ statuses: CommitStatus[] }>(cwd, "api", `repos/${repo}/commits/${sha}/status?per_page=100`),
  ]);

  const byName = new Map<string, { id: number; check: Check }>();
  const keep = (id: number, check: Check) => {
    const prev = byName.get(check.name);
    if (!prev || prev.id < id) byName.set(check.name, { id, check });
  };

  for (const r of runs) {
    keep(r.id, {
      name: r.name,
      state: checkRunState(r),
      conclusion: r.conclusion ?? r.status,
      url: r.html_url ?? r.details_url,
      checkRunId: r.id,
      summary: [r.output?.title, r.output?.summary, r.output?.text].filter(Boolean).join("\n\n"),
    });
  }
  // The combined-status endpoint already returns the latest status per context.
  for (const s of statuses.statuses) {
    keep(s.id, {
      name: s.context,
      state: s.state === "success" ? "success" : s.state === "pending" ? "pending" : "failure",
      conclusion: s.state,
      url: s.target_url,
      checkRunId: null,
      summary: s.description ?? "",
    });
  }
  return [...byName.values()].map(({ check }) => check).sort((a, b) => a.name.localeCompare(b.name));
}

function checkRunState(r: CheckRun): CheckState {
  if (r.status !== "completed") return "pending";
  switch (r.conclusion) {
    case "success":
    case "neutral":
      return "success";
    case "skipped":
      return "skipped";
    default: // failure, cancelled, timed_out, action_required, stale
      return "failure";
  }
}

/** Failed-step log of a GitHub Actions job, trimmed to the last `maxChars`. */
export async function failedJobLog(cwd: string, check: Check, maxChars: number): Promise<string | null> {
  const job = check.url?.match(/\/actions\/runs\/\d+\/job\/(\d+)/)?.[1];
  if (!job) return null;
  try {
    const log = await run("gh", ["run", "view", "--job", job, "--log-failed"], cwd, 120_000);
    // Lines look like "<job>\t<step>\t<timestamp> <text>"; keep step and text.
    const lines = log.split("\n").map((line) => {
      const parts = line.split("\t");
      return parts.length >= 3 ? `${parts[1]} | ${parts.slice(2).join("\t").replace(/^\S+Z /, "")}` : line;
    });
    return tail(lines.join("\n"), maxChars);
  } catch {
    return null;
  }
}

export interface ReviewNote {
  author: string;
  kind: "review" | "comment" | "inline";
  state?: string;
  path?: string;
  body: string;
  url: string;
  at: string;
}

interface GhUser {
  login: string;
}

interface GhComment {
  user: GhUser;
  body: string;
  html_url: string;
  created_at: string;
  updated_at?: string;
}

const lastEdit = (c: GhComment) => c.updated_at ?? c.created_at;

/**
 * Reviews and comments on the branch's open PR posted or edited at or after `since`.
 *
 * Comments count from their last edit, as GitHub's `since` filter does, so a bot that
 * updates one comment per CI run (for example a review summary) is included.
 */
export async function fetchReviewNotes(
  cwd: string,
  repo: string,
  prNumber: number,
  since: Date,
): Promise<ReviewNote[]> {
  const base = `repos/${repo}`;
  const [reviews, comments, inline] = await Promise.all([
    ghList<{ user: GhUser; state: string; body: string; html_url: string; submitted_at: string }>(
      cwd, `${base}/pulls/${prNumber}/reviews?per_page=100`),
    ghList<GhComment>(cwd, `${base}/issues/${prNumber}/comments?per_page=100&since=${since.toISOString()}`),
    ghList<GhComment & { path: string }>(cwd, `${base}/pulls/${prNumber}/comments?per_page=100&since=${since.toISOString()}`),
  ]);
  const after = (at: string | null | undefined) => !!at && new Date(at) >= since;
  const notes: ReviewNote[] = [
    ...reviews.filter((r) => after(r.submitted_at) && (r.body || r.state === "CHANGES_REQUESTED"))
      .map((r) => ({ author: r.user.login, kind: "review" as const, state: r.state, body: r.body, url: r.html_url, at: r.submitted_at })),
    ...comments.filter((c) => after(lastEdit(c)))
      .map((c) => ({ author: c.user.login, kind: "comment" as const, body: c.body, url: c.html_url, at: lastEdit(c) })),
    ...inline.filter((c) => after(lastEdit(c)))
      .map((c) => ({ author: c.user.login, kind: "inline" as const, path: c.path, body: c.body, url: c.html_url, at: lastEdit(c) })),
  ];
  return notes.sort((a, b) => a.at.localeCompare(b.at));
}

export async function findOpenPr(cwd: string, branch: string): Promise<number | null> {
  const prs = await ghJson<{ number: number }[]>(
    cwd, "pr", "list", "--head", branch, "--state", "open", "--json", "number", "--limit", "1");
  return prs[0]?.number ?? null;
}

export function tail(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `…(truncated)\n${text.slice(text.length - maxChars)}`;
}

/** `*` wildcards, case-insensitive, whole-name match. */
export function matchesAny(name: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => {
    const source = pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
    return new RegExp(`^${source}$`, "i").test(name);
  });
}
