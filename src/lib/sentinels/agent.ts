import "server-only";

import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type Anthropic from "@anthropic-ai/sdk";
import { anthropicClient, describeError, usageFrom } from "@/lib/agents/anthropic";
import { requestShape } from "@/lib/agents/models";
import type { AgentConfig, Usage } from "@/lib/agents/ports";
import { chat, extractJson } from "@/lib/llm/openai-compat";
import { provider } from "@/lib/llm/providers";
import type { AuditReport, Rubric } from "@/lib/db/repository";
import { promptFor, type Sentinel } from "./roster";
import {
  CALIBRATE_RULES,
  SCORE_RULES,
  calibrationSchema,
  finishedRubric,
  rubricText,
  scoredReport,
  type Goal,
} from "./rubric";

export type { Goal } from "./rubric";
import { outline } from "./analysis";
import type { Evidence } from "./gather";

/**
 * One sentinel's audit, in three calls: it picks what to read from the file
 * list, reads those and asks for what they point at (more files, or the rest
 * of one that was cut), then writes its report. Fixed calls rather than a
 * tool loop keep an audit to a known cost and inside one function's time.
 */

/** Sonnet reads fast and cheap enough for twelve audits in a row. */
export const SENTINEL_MODEL = "claude-sonnet-5";

/** Paths shown when choosing: plenty for any repository a board works on. */
const MAX_TREE = 4000;
/** Files a sentinel may ask for. */
export const MAX_PICKS = 40;
/** Files or line ranges it may ask for once it has read the first lot. */
export const MAX_MORE = 15;
/** Per file and in total, in characters: about 60k tokens of code. */
const FILE_CAP = 16_000;
const TOTAL_CAP = 240_000;
/** What the first read may spend, keeping the rest for the follow-up. */
const FIRST_CAP = 180_000;

/**
 * An API sentinel only reads. Said outright, because without it a model
 * explains a test run it never could have made with a reason it made up.
 */
const READ_ONLY =
  "You cannot run anything: you judge only from the files and facts in this message. Where your brief needs something you were not given, say it was not available, and do not guess why.";

const NOISE =
  /(^|\/)(node_modules|dist|build|out|\.next|coverage|vendor|\.git)\/|(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb)$|\.(png|jpe?g|gif|webp|ico|svg|woff2?|ttf|otf|eot|mp3|mp4|wav|ogg|pdf|zip|gz|min\.js|map)$/i;

/** The files worth showing a sentinel, most relevant to its role first. */
export function candidateFiles(all: string[], s: Sentinel): string[] {
  const files = all.filter((f) => !NOISE.test(f) || s.include?.some((r) => r.test(f)));
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

const moreSchema = z.object({
  more: z
    .array(
      z.object({
        path: z.string().describe("A repository path, copied exactly."),
        from: z.number().nullable().describe("First line wanted, or null for the start."),
        to: z.number().nullable().describe("Last line wanted, or null for the end."),
      }),
    )
    .describe(`Up to ${MAX_MORE} files or line ranges, most important first; empty when you have enough.`),
});

const point = z.object({
  text: z.string().describe("One specific, factual sentence."),
  ref: z
    .string()
    .nullable()
    .describe("The repository path it is about, with :line when known, or null."),
});

/**
 * An audit's answer. Each check's evidence comes before its verdict, so the
 * verdict follows from what was seen; the stars are worked out from the
 * checks (see ./rubric), never asked for.
 */
export const reportSchema = z.object({
  checks: z
    .array(
      z.object({
        id: z.string().describe("The check's id from the rubric, such as \"3b\"."),
        evidence: z.string().describe("What you read or ran for it, and what that showed."),
        met: z.boolean().describe("Whether the evidence shows the check passes. Not verified means false."),
      }),
    )
    .describe("Every check in the rubric, in its order."),
  quote: z.string().describe("One line in character, under 140 characters."),
  summary: z.string().describe("Two plain sentences: the verdict and the biggest reason for it."),
  likes: z.array(point).describe("What works, for this role."),
  dislikes: z.array(point).describe("What works but is done badly."),
  wrong: z.array(point).describe("Bugs, risks and outright mistakes."),
  missing: z.array(point).describe("What this role expects and cannot find."),
});

export type SentinelReport = z.infer<typeof reportSchema>;

/** What a finished run stores. */
export interface Finished {
  stars?: number;
  quote?: string;
  summary?: string;
  report?: AuditReport;
  rubric?: Rubric;
}

/** A report as the page stores it: the text trimmed, the stars from its checks. */
export function finishedReport(rubric: Rubric, r: SentinelReport): Finished {
  const { checks, quote, summary, ...points } = r;
  return { ...scoredReport(rubric, points, checks), quote: quote.trim(), summary: summary.trim() };
}

/** A run's answer as the page stores it, or why it cannot be used. */
export function finishedRun(goal: Goal, raw: unknown): { ok: true; value: Finished } | { ok: false; problem: string } {
  if (goal.kind === "calibrate") {
    const c = calibrationSchema.safeParse(raw);
    if (!c.success) return { ok: false, problem: "The rubric did not match the expected shape." };
    const r = finishedRubric(c.data);
    return r.ok ? { ok: true, value: { rubric: r.rubric, summary: r.rubric.context } } : r;
  }
  const r = reportSchema.safeParse(raw);
  return r.success
    ? { ok: true, value: finishedReport(goal.rubric, r.data) }
    : { ok: false, problem: "The report did not match the expected shape." };
}

/** The full brief for the last call: the role, then what this run is for. */
export function briefFor(s: Sentinel, goal: Goal): string {
  return goal.kind === "calibrate"
    ? `${s.persona} ${s.task} ${CALIBRATE_RULES}`
    : `${promptFor(s)} ${SCORE_RULES}\n\n${rubricText(goal.rubric)}`;
}

export interface AuditRun {
  sentinel: Sentinel;
  goal: Goal;
  repoFullName: string;
  files: string[];
  read: (path: string) => Promise<string | null>;
  /** Facts gathered for this role (see ./gather), or none. */
  evidence?: Evidence;
  log: (step: string) => Promise<void>;
  signal: AbortSignal;
}

export type AuditOutcome =
  | (Finished & {
      ok: true;
      files: string[];
      usage: Usage;
    })
  | { ok: false; error: string; usage: Usage };

export async function runAudit(config: AgentConfig, run: AuditRun): Promise<AuditOutcome> {
  const { sentinel: s, goal } = run;
  const doing = goal.kind === "calibrate" ? "calibrate on" : "audit";
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
    system: `${s.persona} ${s.task}\n\nYou are about to ${doing} ${run.repoFullName}. Pick the files you most need to read for your role. Prefer source over generated files.`,
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
  const texts: Read[] = [];
  let budget = FIRST_CAP;
  for (let i = 0; i < paths.length && budget > 0; i += 8) {
    if (run.signal.aborted) return { ok: false, error: "Stopped.", usage };
    const batch = await Promise.all(
      paths.slice(i, i + 8).map(async (path) => ({ path, text: await run.read(path).catch(() => null) })),
    );
    for (const { path, text } of batch) {
      if (text === null || budget <= 0) continue;
      const read = cut(path, text, 0, null, Math.min(FILE_CAP, budget));
      budget -= read.text.length;
      texts.push(read);
    }
  }
  if (texts.length === 0) return { ok: false, error: "Could not read any files from the repository.", usage };

  // What the first lot points at: the rest of a file that was cut, or a
  // file it leans on. Asked from paths and outlines, not the code again.
  await run.log("Reading more");
  const unread = shown.filter((p) => !texts.some((t) => t.path === p)).slice(0, 800);
  const followed = await ask(config, model, run.signal, {
    system: `${s.persona} ${s.task}\n\nYou are about to ${doing} ${run.repoFullName} and have read the files below. Ask for what you still need to judge it for your role: the rest of a file that was cut short, or a file the ones you read depend on.`,
    user: [
      "What you read:",
      ...texts.map((t) => `- ${t.path} (${t.note})${t.outline.length ? `; not shown:\n${t.outline.map((l) => `    ${l}`).join("\n")}` : ""}`),
      "",
      "Files you have not read:",
      unread.join("\n"),
    ].join("\n"),
    schema: moreSchema,
    effort: "low",
  });
  if (followed.usage) add(followed.usage);
  let rest = TOTAL_CAP - (FIRST_CAP - budget);
  // Only paths that exist, and not a file it already has whole.
  const whole = new Set(texts.filter((t) => t.outline.length === 0 && !t.note.startsWith("lines")).map((t) => t.path));
  const allowed = new Set([...shown, ...texts.map((t) => t.path)]);
  const asks = followed.ok ? followed.value.more.filter((m) => allowed.has(m.path) && !whole.has(m.path)).slice(0, MAX_MORE) : [];
  for (const m of asks) {
    if (rest <= 0 || run.signal.aborted) break;
    const text = await run.read(m.path).catch(() => null);
    if (text === null) continue;
    const from = Math.max(0, (m.from ?? 1) - 1);
    const read = cut(m.path, text, from, m.to, Math.min(FILE_CAP, rest));
    if (read.note.startsWith("lines") && read.text.startsWith("…")) continue; // An empty range.
    rest -= read.text.length;
    texts.push(read);
  }

  await run.log(goal.kind === "calibrate" ? "Writing the rubric" : `Scoring as ${s.name}`);
  const sections = run.evidence?.sections ?? [];
  const images = run.evidence?.images ?? [];
  const answer = await ask(config, model, run.signal, {
    system: `${briefFor(s, goal)}\n\n${READ_ONLY}`,
    user: [
      `Repository: ${run.repoFullName} (${run.files.length} files).`,
      "",
      ...(sections.length ? ["Facts gathered for your role:", ...sections.map((x) => `${x}\n`), ""] : []),
      "All paths, for knowing what exists:",
      shown.slice(0, 1500).join("\n"),
      "",
      "The files you asked to read:",
      ...texts.map((t) => `\n=== ${t.path} (${t.note}) ===\n${t.text}`),
    ].join("\n"),
    images,
    schema: goal.kind === "calibrate" ? (calibrationSchema as z.ZodType<unknown>) : (reportSchema as z.ZodType<unknown>),
    effort: "medium",
  });
  if (answer.usage) add(answer.usage);
  if (!answer.ok) return { ok: false, error: answer.error, usage };
  const done = finishedRun(goal, answer.value);
  if (!done.ok) return { ok: false, error: done.problem, usage };

  await run.log(goal.kind === "calibrate" ? "Saving the rubric" : "Writing report");
  return { ok: true, ...done.value, files: [...new Set(texts.map((t) => t.path))], usage };
}

interface Read {
  path: string;
  text: string;
  /** Which lines were shown, as the prompt says it. */
  note: string;
  /** Declarations in the lines not shown, for asking for them. */
  outline: string[];
}

/** Lines `from` to `to` of a file, cut to `limit` characters on a line break. */
export function cut(path: string, text: string, from: number, to: number | null, limit: number): Read {
  const all = text.split("\n");
  const end = Math.min(all.length, to ?? all.length);
  let shown = "";
  let last = from;
  for (; last < end; last++) {
    const next = `${all[last]}\n`;
    if (shown.length + next.length > limit) {
      // One line longer than the whole share, as minified code is: show what fits of it.
      if (shown === "") shown = `${next.slice(0, limit)}\n`;
      break;
    }
    shown += next;
  }
  const whole = from === 0 && last >= all.length;
  const note = whole ? `${all.length} lines` : `lines ${from + 1}-${last} of ${all.length}`;
  return {
    path,
    text: whole ? shown : `${shown}… (cut at line ${last}; ask for more by line range)`,
    note,
    outline: last < all.length ? outline(text, last) : [],
  };
}

type Asked<T> = { ok: true; value: T; usage?: Usage } | { ok: false; error: string; usage?: Usage };

/** One structured answer, from Claude or any OpenAI-compatible provider. */
async function ask<T>(
  config: AgentConfig,
  model: string,
  signal: AbortSignal,
  req: {
    system: string;
    user: string;
    schema: z.ZodType<T>;
    effort: "low" | "medium";
    images?: Evidence["images"];
  },
): Promise<Asked<T>> {
  const info = provider(config.provider ?? "anthropic");
  if (info?.kind === "openai") {
    if (!config.apiKey) return { ok: false, error: `This agent has no ${info.label} API key.` };
    const messages = [
      {
        role: "system" as const,
        content: `${req.system}\n\nRespond with a single JSON object and nothing else, matching this JSON Schema:\n${JSON.stringify(z.toJSONSchema(req.schema))}`,
      },
      {
        role: "user" as const,
        content: req.images?.length ? `${req.user}\n\n(The screenshots were not sent: images go to Claude only.)` : req.user,
      },
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
        messages: [
          {
            role: "user",
            content: [
              ...(req.images ?? []).map((i) => ({
                type: "image" as const,
                source: { type: "base64" as const, media_type: i.mediaType, data: i.data.toString("base64") },
              })),
              { type: "text" as const, text: req.user },
            ],
          },
        ],
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
