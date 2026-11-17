import { beforeEach, describe, expect, it, vi } from "vitest";

const exec = vi.hoisted(() => vi.fn());
vi.mock("@getpaseo/plugin/server", () => ({ execCommand: exec }));

import { fetchReviewNotes } from "../server/github";

const since = new Date("2026-11-17T10:00:00Z");
const user = { login: "github-actions[bot]" };

function respond(byPath: Record<string, unknown[]>) {
  exec.mockImplementation(async (_cmd: string, args: string[] = []) => {
    const path = args.find((arg) => arg.startsWith("repos/")) ?? "";
    const key = Object.keys(byPath).find((suffix) => path.includes(suffix));
    // `gh api --paginate --jq '.[]'` prints one compact JSON item per line.
    return { stdout: (key ? byPath[key] : []).map((item) => JSON.stringify(item)).join("\n") };
  });
}

describe("fetchReviewNotes", () => {
  beforeEach(() => exec.mockReset());

  it("includes a comment created before the push but edited after it", async () => {
    respond({
      "/issues/7/comments": [
        { user, body: "review: FAIL", html_url: "u1", created_at: "2026-11-16T17:00:00Z", updated_at: "2026-11-17T10:30:00Z" },
        { user, body: "stale", html_url: "u2", created_at: "2026-11-16T17:00:00Z", updated_at: "2026-11-16T18:00:00Z" },
      ],
    });
    const notes = await fetchReviewNotes("/repo", "o/r", 7, since);
    expect(notes).toEqual([
      { author: user.login, kind: "comment", body: "review: FAIL", url: "u1", at: "2026-11-17T10:30:00Z" },
    ]);
  });

  it("falls back to created_at and keeps reviews by submission time", async () => {
    respond({
      "/pulls/7/reviews": [
        { user, state: "CHANGES_REQUESTED", body: "", html_url: "r1", submitted_at: "2026-11-17T10:05:00Z" },
        { user, state: "COMMENTED", body: "old", html_url: "r2", submitted_at: "2026-11-17T09:00:00Z" },
      ],
      "/pulls/7/comments": [
        { user, body: "nit", html_url: "c1", created_at: "2026-11-17T10:10:00Z", path: "a.md" },
      ],
    });
    const notes = await fetchReviewNotes("/repo", "o/r", 7, since);
    expect(notes.map((n) => [n.kind, n.url])).toEqual([
      ["review", "r1"],
      ["inline", "c1"],
    ]);
  });
});
