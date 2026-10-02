import "server-only";

import { z } from "zod";

import { extractJson } from "@/lib/llm/openai-compat";
import { finishedReport, reportSchema } from "./agent";
import { promptFor, type Sentinel } from "./roster";

/**
 * A sentinel audited by a CLI agent. The agent runs in GitHub Actions on a
 * checkout with the dependencies installed, so it reads the repository and
 * runs what backs its judgement (tests, the build, a coverage run) instead of
 * being handed facts, and hands back the same report an API agent writes.
 */

const cliReportSchema = reportSchema.extend({
  files: z.array(z.string()).default([]).describe("The repository paths you actually read."),
});

export function cliAuditPrompt(
  s: Sentinel,
  repoFullName: string,
  retry?: { answer: string; problem: string },
): string {
  return [
    promptFor(s),
    "",
    `You are auditing ${repoFullName}, checked out in the current directory with its dependencies installed. Read the code you need for your role with your tools, and run what backs your judgement: the tests, the linter, the type checker, the build, a coverage run, or any check your role calls for. Prefer evidence you ran over evidence you inferred, and say in your report what you ran and what it showed. If something could not run, say why, from its output. Do not change any file in the repository: nothing you change is kept.`,
    "",
    "Your final message is your report, and it must be one JSON object and nothing else (you may write the same object to the file named by the FORMIC_OUTPUT environment variable instead). It must match this JSON Schema:",
    JSON.stringify(z.toJSONSchema(cliReportSchema)),
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

export type CliReport =
  | { ok: true; stars: number; quote: string; summary: string; report: ReturnType<typeof finishedReport>["report"]; files: string[] }
  | { ok: false; problem: string };

export function parseCliReport(text: string | null): CliReport {
  if (!text?.trim()) return { ok: false, problem: "The agent finished without a report." };
  let raw: unknown = null;
  try {
    raw = extractJson(text);
  } catch {
    return { ok: false, problem: "The answer was not the JSON object." };
  }
  const parsed = cliReportSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, problem: "The report did not match the expected shape." };
  return { ok: true, ...finishedReport(parsed.data), files: parsed.data.files };
}
