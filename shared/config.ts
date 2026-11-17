import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

const fields = {
  // Check names to watch. `*` is a wildcard; matching is case-insensitive. Empty watches every check.
  checks: z.array(z.string()).default([]),
  // Sent to the agent before each push. The plugin pushes when that turn ends.
  prePushInstructions: z.string().default(""),
  // Run the pre-push instructions before every push, not only the first one.
  prePushEveryRound: z.boolean().default(true),
  // Appended to every fix prompt.
  fixInstructions: z.string().default(""),
  // Fix rounds allowed after the first push. 0 means push and report only.
  maxRounds: z.number().int().min(0).max(20).default(3),
  pollIntervalSec: z.number().int().min(15).max(600).default(45),
  // Give up when watched checks have not all finished this long after a push.
  timeoutMin: z.number().int().min(1).max(360).default(45),
  // Send PR review comments posted since the push along with failed checks, and treat
  // a new "changes requested" review as a failure.
  includeReviews: z.boolean().default(true),
  remote: z.string().min(1).default("origin"),
};

export const configSchema = z.object(fields);
export type PushFixConfig = z.output<typeof configSchema>;

export const partialConfigSchema = z
  .object({
    checks: z.array(z.string()),
    prePushInstructions: z.string(),
    prePushEveryRound: z.boolean(),
    fixInstructions: z.string(),
    maxRounds: fields.maxRounds.removeDefault(),
    pollIntervalSec: fields.pollIntervalSec.removeDefault(),
    timeoutMin: fields.timeoutMin.removeDefault(),
    includeReviews: z.boolean(),
    remote: z.string().min(1),
  })
  .partial();
export type PushFixOverrides = z.output<typeof partialConfigSchema>;

export const pushFixSettings = defineSettings({
  id: "push-fix",
  scope: "host",
  version: 1,
  schema: configSchema,
});

/** Repository-local overrides, read from the agent's working directory. */
export const REPO_CONFIG_PATH = ".paseo/push-fix.json";

/** Splits a free-text list (commas or newlines) into trimmed, non-empty entries. */
export function splitList(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Parses slash-command arguments such as
 * `rounds=5 checks="Docs Review,lint*" no-pre timeout=30`.
 */
export function parseArgs(args: string): PushFixOverrides {
  const overrides: PushFixOverrides = {};
  const tokens = args.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  for (const token of tokens) {
    const eq = token.indexOf("=");
    const key = (eq < 0 ? token : token.slice(0, eq)).toLowerCase();
    const value = eq < 0 ? "" : token.slice(eq + 1).replace(/^["']|["']$/g, "");
    switch (key) {
      case "rounds":
      case "max-rounds":
        overrides.maxRounds = toInt(key, value);
        break;
      case "checks":
        overrides.checks = splitList(value);
        break;
      case "timeout":
        overrides.timeoutMin = toInt(key, value);
        break;
      case "poll":
        overrides.pollIntervalSec = toInt(key, value);
        break;
      case "remote":
        overrides.remote = value;
        break;
      case "no-pre":
        overrides.prePushInstructions = "";
        break;
      case "pre":
        overrides.prePushInstructions = value;
        break;
      case "no-reviews":
        overrides.includeReviews = false;
        break;
      default:
        throw new Error(`Unknown argument "${token}". Use rounds=, checks=, timeout=, poll=, remote=, pre=, no-pre, no-reviews.`);
    }
  }
  return partialConfigSchema.parse(overrides);
}

function toInt(key: string, value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n)) throw new Error(`${key}= needs an integer, got "${value}"`);
  return n;
}
