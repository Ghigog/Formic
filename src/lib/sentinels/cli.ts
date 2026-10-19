import "server-only";

import { z } from "zod";

import { extractJson } from "@/lib/llm/openai-compat";
import { briefFor, finishedRun, reportSchema, type Finished, type Goal } from "./agent";
import type { Sentinel } from "./roster";
import { calibrationSchema } from "./rubric";

/**
 * A sentinel audited by a CLI agent. The agent runs in GitHub Actions on a
 * checkout with the dependencies installed, so it reads the repository and
 * runs what backs its judgement (tests, the build, a coverage run) instead of
 * being handed facts, and hands back the same report an API agent writes.
 */

const files = z.object({
  files: z.array(z.string()).default([]).describe("The repository paths you actually read."),
});

const schemaFor = (goal: Goal) => (goal.kind === "calibrate" ? calibrationSchema : reportSchema).extend(files.shape);

export function cliAuditPrompt(
  s: Sentinel,
  repoFullName: string,
  goal: Goal,
  retry?: { answer: string; problem: string },
): string {
  return [
    briefFor(s, goal),
    "",
    `You are ${goal.kind === "calibrate" ? "calibrating on" : "auditing"} ${repoFullName}, checked out in the current directory with its dependencies installed. Read the code you need for your role with your tools, and run what backs your judgement: the tests, the linter, the type checker, the build, a coverage run, or any check your role calls for. Prefer evidence you ran over evidence you inferred, and say in your report what you ran and what it showed. If something could not run, say why, from its output. Do not change any file in the repository: nothing you change is kept.`,
    "",
    "Your final message is your report, and it must be one JSON object and nothing else (you may write the same object to the file named by the FORMIC_OUTPUT environment variable instead). It must match this JSON Schema:",
    JSON.stringify(z.toJSONSchema(schemaFor(goal))),
    ...(retry
      ? [
          "",
          `You reported already, but Formic could not use it: ${retry.problem}`,
          "",
          "Your previous answer:",
          retry.answer.slice(0, 20_000),
          "",
          "Send the whole report again, as the JSON object only.",
        ]
      : []),
  ].join("\n");
}

export type CliReport = (Finished & { ok: true; files: string[] }) | { ok: false; problem: string };

export function parseCliReport(text: string | null, goal: Goal): CliReport {
  if (!text?.trim()) return { ok: false, problem: "The agent finished without a report." };
  let raw: unknown = null;
  try {
    raw = extractJson(text);
  } catch {
    return { ok: false, problem: "The answer was not the JSON object." };
  }
  const done = finishedRun(goal, raw);
  if (!done.ok) return done;
  const read = files.safeParse(raw);
  return { ok: true, ...done.value, files: read.success ? read.data.files : [] };
}
