import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { partialConfigSchema } from "./config";

export const startRun = defineRpc({
  name: "push-fix.start",
  input: z.object({ agentId: z.string(), overrides: partialConfigSchema.default({}) }),
  output: z.object({ runId: z.string() }),
});

export const stopRun = defineRpc({
  name: "push-fix.stop",
  input: z.object({ agentId: z.string() }),
  output: z.object({ stopped: z.boolean() }),
});
