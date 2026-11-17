# Push & fix

Push the agent's branch, watch the CI checks you choose, and hand any failure back to the same agent as a new prompt. The agent fixes and commits, the plugin pushes again, and the loop ends when the watched checks are green or the fix-round cap is reached.

## How it works

Start a run with the **Push (Ralph)** button in the workspace header. With one agent in the workspace, one press starts; with several, pick the agent that should fix failures. The same action is on each agent's composer pill, in `/push-fix`, and in the Command Center ("Push & fix until CI is green"). For each round the plugin:

1. Optionally sends your pre-push instructions to the agent (for example "run the tests and lint, commit") and waits for that turn to end.
2. Runs `git push` in the agent's working directory. It never force-pushes.
3. Polls the GitHub check runs and commit statuses of the pushed commit with `gh`.
4. When every watched check has finished: if all passed, the run ends. If any failed, it sends the agent the check summaries, the failed-step logs of GitHub Actions jobs, and (optionally) PR reviews posted since the push and comments posted or edited since then, such as a bot summary it updates on every run, then waits for the agent's turn to end and starts the next round.

A status row in the agent's timeline shows the branch, commit, round, and each watched check. The loop stops when the agent ends a fix turn without a new commit, when a turn is canceled, when checks time out, or with `/push-fix-stop` or Stop on the composer pill.

## Setup

Requires `git` and an authenticated `gh` CLI on the daemon machine, and a GitHub remote.

## Settings

Open them from Settings, Plugins, or "Push & fix settings" in the Command Center.

- Watched checks: check names, one per line, with `*` wildcards. Empty watches every check.
- Before push: instructions the agent runs before each push, or only the first one.
- Extra fix instructions: appended to every fix prompt.
- Max fix rounds, poll interval, check timeout, and the remote.
- Include PR reviews: adds review comments to fix prompts and treats a new "changes requested" review as a failure.

A repository can override any of these in `.paseo/push-fix.json`, for example `{ "checks": ["Letta Docs Review"], "maxRounds": 2 }`. Arguments to `/push-fix` override both: `rounds=N`, `checks="a,b*"`, `timeout=MIN`, `poll=SEC`, `remote=NAME`, `pre="…"`, `no-pre`, `no-reviews`.

## Limits

Polling, not webhooks. Runs live in the plugin process, so a plugin reload or daemon restart ends them. Only pushes started by the plugin are watched.
