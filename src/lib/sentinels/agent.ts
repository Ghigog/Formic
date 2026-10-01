import "server-only";

import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type Anthropic from "@anthropic-ai/sdk";
import { anthropicClient, describeError, usageFrom } from "@/lib/agents/anthropic";
import { requestShape } from "@/lib/agents/models";
import type { AgentConfig, Usage } from "@/lib/agents/ports";
import { chat, extractJson } from "@/lib/llm/openai-compat";
import { provider } from "@/lib/llm/providers";
import type { AuditReport } from "@/lib/db/repository";
import { promptFor, type Sentinel } from "./roster";

/**
 * One sentinel's audit, in two calls: it picks what to read from the file
 * list, then reads those files and writes its report. Two calls rather than
 * a tool loop keep an audit to a known cost and inside one function's time.
 */

/** Sonnet reads fast and cheap enough for twelve audits in a row. */
export const SENTINEL_MODEL = "claude-sonnet-5";

/** Paths shown when choosing: plenty for any repository a board works on. */
const MAX_TREE = 4000;
/** Files a sentinel may ask for. */
export const MAX_PICKS = 40;
/** Per file and in total, in characters: about 60k tokens of code. */
const FILE_CAP = 16_000;
const TOTAL_CAP = 240_000;

const NOISE =
  /(^|\/)(node_modules|dist|build|out|\.next|coverage|vendor|\.git)\/|(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb)$|\.(png|jpe?g|gif|webp|ico|svg|woff2?|ttf|otf|eot|mp3|mp4|wav|ogg|pdf|zip|gz|min\.js|map)$/i;

/** The files worth showing a sentinel, most relevant to its role first. */
export function candidateFiles(all: string[], s: Sentinel): string[] {
  const files = all.filter((f) => !NOISE.test(f));
  const hit = (f: string) => s.focus.some((r) => r.test(f));
  const depth = (f: string) => f.split("/").length;
  return [...files]
    .sort((a, b) => Number(hit(b)) - Number(hit(a)) || depth(a) - depth(b) || a.localeCompare(b))
    .slice(0, MAX_TREE);
}

/** Top-level files every role should see: the README and the manifest. */
function always(files: string[]): string[] {
  return files.filter((f) => /^(README\.md|package\.json|pyproject\.toml|go\.mod|Cargo\.toml)$/i.test(f));
}

const pickSchema = z.object({
  paths: z.array(z.string()).describe(`Up to ${MAX_PICKS} repository paths, most important first, copied exactly from the list.`),
});

const point = z.object({
  text: z.string().describe("One specific, factual sentence."),
  ref: z
    .string()
    .nullable()
    .describe("The repository path it is about, with :line when known, or null."),
});

export const reportSchema = z.object({
  stars: z.number().describe("A whole number from 1 to 5, for this role only."),
  quote: z.string().describe("One line in character, under 140 characters."),
  summary: z.string().describe("Two plain sentences: the verdict and the biggest reason for it."),
  likes: z.array(point).describe("What works, for this role."),
  dislikes: z.array(point).describe("What works but is done badly."),
  wrong: z.array(point).describe("Bugs, risks and outright mistakes."),
  missing: z.array(point).describe("What this role expects and cannot find."),
});

export type SentinelReport = z.infer<typeof reportSchema>;

/** A report as the page stores it: the stars clamped, the text trimmed. */
export function finishedReport(r: SentinelReport) {
  return {
    stars: Math.min(5, Math.max(1, Math.round(r.stars))),
    quote: r.quote.trim(),
    summary: r.summary.trim(),
    report: { likes: r.likes, dislikes: r.dislikes, wrong: r.wrong, missing: r.missing } satisfies AuditReport,
  };
}

export interface AuditRun {
  sentinel: Sentinel;
  repoFullName: string;
  files: string[];
  read: (path: string) => Promise<string | null>;
  log: (step: string) => Promise<void>;
  signal: AbortSignal;
}

export type AuditOutcome =
  | {
      ok: true;
      stars: number;
      quote: string;
      summary: string;
      report: AuditReport;
      files: string[];
      usage: Usage;
    }
  | { ok: false; error: string; usage: Usage };

export async function runAudit(config: AgentConfig, run: AuditRun): Promise<AuditOutcome> {
  const { sentinel: s } = run;
  const model = config.model ?? SENTINEL_MODEL;
  let usage: Usage = { model, tokensIn: 0, tokensOut: 0, costCents: 0 };
  const add = (u: Usage) => {
    usage = {
      model,
      tokensIn: usage.tokensIn + u.tokensIn,
      tokensOut: usage.tokensOut + u.tokensOut,
      costCents: usage.costCents + u.costCents,
    };
  };

  const shown = candidateFiles(run.files, s);
  if (shown.length === 0) return { ok: false, error: "The repository has no files to read.", usage };

  await run.log(`Choosing what a ${s.name} reads`);
  const picked = await ask(config, model, run.signal, {
    system: `${s.persona} ${s.task}\n\nYou are about to audit ${run.repoFullName}. Pick the files you most need to read for your role. Prefer source over generated files.`,
    user: `Files in the repository${shown.length < run.files.length ? " (the most relevant, trimmed)" : ""}:\n${shown.join("\n")}`,
    schema: pickSchema,
    effort: "low",
  });
  if (picked.usage) add(picked.usage);
  const known = new Set(shown);
  const chosen = picked.ok ? picked.value.paths.filter((p) => known.has(p)) : [];
  // A pick that failed or named nothing real falls back to the role's own focus.
  const paths = [...new Set([...always(shown), ...(chosen.length ? chosen : shown)])].slice(0, MAX_PICKS);

  await run.log(`Reading ${paths.length} files`);
  const texts: Array<{ path: string; text: string }> = [];
  let budget = TOTAL_CAP;
  for (let i = 0; i < paths.length && budget > 0; i += 8) {
    if (run.signal.aborted) return { ok: false, error: "Stopped.", usage };
    const batch = await Promise.all(
      paths.slice(i, i + 8).map(async (path) => ({ path, text: await run.read(path).catch(() => null) })),
    );
    for (const { path, text } of batch) {
      if (text === null || budget <= 0) continue;
      const cut = text.slice(0, Math.min(FILE_CAP, budget));
      budget -= cut.length;
      texts.push({ path, text: cut.length < text.length ? `${cut}\n… (truncated)` : cut });
    }
  }
  if (texts.length === 0) return { ok: false, error: "Could not read any files from the repository.", usage };

  await run.log(`Scoring as ${s.name}`);
  const answer = await ask(config, model, run.signal, {
    system: promptFor(s),
    user: [
      `Repository: ${run.repoFullName} (${run.files.length} files).`,
      "",
      "All paths, for knowing what exists:",
      shown.slice(0, 1500).join("\n"),
      "",
      "The files you asked to read:",
      ...texts.map((t) => `\n=== ${t.path} ===\n${t.text}`),
    ].join("\n"),
    schema: reportSchema,
    effort: "medium",
  });
  if (answer.usage) add(answer.usage);
  if (!answer.ok) return { ok: false, error: answer.error, usage };

  await run.log("Writing report");
  return { ok: true, ...finishedReport(answer.value), files: texts.map((t) => t.path), usage };
}

type Asked<T> = { ok: true; value: T; usage?: Usage } | { ok: false; error: string; usage?: Usage };

/** One structured answer, from Claude or any OpenAI-compatible provider. */
async function ask<T>(
  config: AgentConfig,
  model: string,
  signal: AbortSignal,
  req: { system: string; user: string; schema: z.ZodType<T>; effort: "low" | "medium" },
): Promise<Asked<T>> {
  const info = provider(config.provider ?? "anthropic");
  if (info?.kind === "openai") {
    if (!config.apiKey) return { ok: false, error: `This agent has no ${info.label} API key.` };
    const messages = [
      {
        role: "system" as const,
        content: `${req.system}\n\nRespond with a single JSON object and nothing else, matching this JSON Schema:\n${JSON.stringify(z.toJSONSchema(req.schema))}`,
      },
      { role: "user" as const, content: req.user },
    ];
    try {
      const res = await chat(info, config.apiKey, { model, messages, json: true, signal });
      const u = usageFrom(model, { input_tokens: res.tokensIn, output_tokens: res.tokensOut });
      const parsed = req.schema.safeParse(safeJson(res.message.content ?? ""));
      return parsed.success
        ? { ok: true, value: parsed.data, usage: u }
        : { ok: false, error: "The sentinel's report did not match the expected shape.", usage: u };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  const shape = requestShape(model, { effort: req.effort });
  try {
    const message = await anthropicClient(config.apiKey).beta.messages.create(
      {
        model,
        max_tokens: 16_000,
        system: req.system,
        ...(shape.thinking ? { thinking: shape.thinking } : {}),
        ...(shape.fallbacks ? { fallbacks: shape.fallbacks } : {}),
        output_config: { ...shape.outputConfig, format: zodOutputFormat(req.schema) },
        betas: shape.betas,
        messages: [{ role: "user", content: req.user }],
      },
      { signal },
    );
    const u = usageFrom(model, message.usage);
    if (message.stop_reason === "refusal") return { ok: false, error: "The model declined this audit.", usage: u };
    const text = message.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    const parsed = req.schema.safeParse(safeJson(text));
    return parsed.success
      ? { ok: true, value: parsed.data, usage: u }
      : { ok: false, error: "The sentinel's report did not match the expected shape.", usage: u };
  } catch (e) {
    return { ok: false, error: describeError(e) };
  }
}

function safeJson(text: string): unknown {
  try {
    return extractJson(text);
  } catch {
    return null;
  }
}
