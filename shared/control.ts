import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const watchdogControl = defineRpc({
  name: "watchdog.control",
  input: z.object({
    agentId: z.string().min(1),
    action: z.enum(["on", "off", "status"]),
  }),
  output: z.object({
    phase: z.enum([
      "off",
      "armed",
      "waiting",
      "checking",
      "resuming",
      "resumed",
      "stopped",
    ]),
    message: z.string(),
    lastCheckAt: z.string().nullable(),
    nextCheckAt: z.string().nullable(),
    resetsAt: z.string().nullable(),
    usedPct: z.number().nullable(),
    triggerCount: z.number().int().nonnegative(),
    submittedCount: z.number().int().nonnegative(),
    unknownCount: z.number().int().nonnegative(),
    triggers: z
      .array(
        z.object({
          id: z.number().int().positive(),
          at: z.string(),
          prompt: z.string(),
          result: z.enum(["sending", "submitted", "unknown"]),
        }),
      )
      .max(20),
  }),
});
