import { z } from "zod";

export const STATUS_KIND = "push-fix-status";
export const STATUS_VERSION = 1;

export const phaseSchema = z.enum([
  "preparing", // agent is running the pre-push instructions
  "pushing",
  "watching", // polling checks
  "fixing", // agent is fixing failures
  "green",
  "failed", // checks failed and no rounds are left
  "stopped",
  "error",
]);
export type Phase = z.output<typeof phaseSchema>;

export const checkStateSchema = z.enum(["pending", "success", "failure", "skipped"]);
export type CheckState = z.output<typeof checkStateSchema>;

export const statusSchema = z.object({
  runId: z.string(),
  round: z.number().int(),
  maxRounds: z.number().int(),
  phase: phaseSchema,
  branch: z.string().nullable(),
  sha: z.string().nullable(),
  message: z.string(),
  checks: z.array(z.object({ name: z.string(), state: checkStateSchema, url: z.string().nullable() })),
  updatedAt: z.string(),
});
export type PushFixStatus = z.output<typeof statusSchema>;

export function isTerminal(phase: Phase): boolean {
  return phase === "green" || phase === "failed" || phase === "stopped" || phase === "error";
}
