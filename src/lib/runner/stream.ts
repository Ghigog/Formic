import type { PlanStep } from "@/lib/domain/entities";

/**
 * What a CLI agent working in GitHub Actions is doing, read from the event
 * stream its CLI prints: Claude Code's `stream-json`, Codex's `exec --json`
 * and Gemini CLI's `stream-json`. The workflow posts the lines as they come;
 * this turns each into what a ticket shows: a thought, an action, its plan,
 * or lines for the terminal. A line that is not one of theirs is terminal
 * output as it stands.
 *
 * No server imports: it is pure, and tested as such.
 */

export type StreamItem =
  | { kind: "thought"; thought: "thinking" | "text"; text: string }
  | { kind: "action"; label: string }
  | { kind: "plan"; steps: PlanStep[] }
  | { kind: "log"; stream: "stdout" | "stderr"; line: string };

const MAX_THOUGHT = 4_000;
const MAX_LOG_LINES = 40;
const MAX_LOG_LINE = 400;

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function thought(kind: "thinking" | "text", text: string): StreamItem[] {
  const t = text.trim();
  return t ? [{ kind: "thought", thought: kind, text: t.slice(0, MAX_THOUGHT) }] : [];
}

/** A command's output as terminal lines: its tail, which is where results are. */
export function outputLines(text: string, stream: "stdout" | "stderr" = "stdout"): StreamItem[] {
  const lines = text.replace(/\s+$/, "").split("\n");
  if (lines.length === 1 && lines[0] === "") return [];
  const kept = lines.length > MAX_LOG_LINES ? lines.slice(-MAX_LOG_LINES) : lines;
  const items: StreamItem[] = kept.map((line) => ({
    kind: "log",
    stream,
    line: line.length > MAX_LOG_LINE ? `${line.slice(0, MAX_LOG_LINE)}…` : line,
  }));
  if (kept.length < lines.length) {
    items.unshift({ kind: "log", stream, line: `… ${lines.length - kept.length} lines above` });
  }
  return items;
}

function short(text: string, max = 80): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** A tool call as one line: what it does, in words. */
export function toolLabel(name: string, input: Json): string {
  const path = str(input.file_path) || str(input.path) || str(input.absolute_path) || str(input.notebook_path);
  const rel = path.replace(/^\/home\/runner\/work\/[^/]+\/[^/]+\//, "");
  // Its report to Formic, written outside the repository.
  if (/\/_temp\/formic-(summary|answer)\.md$/.test(path) && /^(Write|write_file|Edit|replace)$/.test(name)) {
    return path.endsWith("summary.md") ? "Writing up what it did" : "Writing its answer";
  }
  switch (name) {
    case "Bash":
    case "run_shell_command":
      return `$ ${short(str(input.command), 100)}`;
    case "Read":
    case "read_file":
      return `Reading ${rel}`;
    case "Write":
    case "write_file":
      return `Writing ${rel}`;
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
    case "replace":
      return `Editing ${rel}`;
    case "Glob":
    case "glob":
      return `Finding ${short(str(input.pattern))}`;
    case "Grep":
    case "search_file_content":
      return `Searching for ${short(str(input.pattern))}`;
    case "LS":
    case "list_directory":
      return `Listing ${rel || "files"}`;
    case "WebFetch":
    case "web_fetch":
      return `Fetching ${short(str(input.url) || str(input.prompt))}`;
    case "WebSearch":
    case "google_web_search":
      return `Searching the web for ${short(str(input.query))}`;
    case "Task":
    case "Agent":
      return `Delegating: ${short(str(input.description) || str(input.prompt))}`;
    default:
      return rel ? `${name} ${rel}` : name;
  }
}

function claudePlan(input: Json): PlanStep[] | null {
  if (!Array.isArray(input.todos)) return null;
  const steps = input.todos.flatMap((t): PlanStep[] => {
    if (!isObject(t)) return [];
    const step = short(str(t.content), 300);
    const status = t.status === "completed" ? "done" : t.status === "in_progress" ? "in_progress" : "pending";
    return step ? [{ step, status }] : [];
  });
  return steps.length ? steps : null;
}

function codexPlan(items: unknown): PlanStep[] | null {
  if (!Array.isArray(items)) return null;
  let current = false;
  const steps = items.flatMap((t): PlanStep[] => {
    if (!isObject(t)) return [];
    const step = short(str(t.text), 300);
    if (!step) return [];
    if (t.completed === true) return [{ step, status: "done" }];
    // Codex marks only done or not; the first one not done is in hand.
    const status = current ? "pending" : "in_progress";
    current = true;
    return [{ step, status }];
  });
  return steps.length ? steps : null;
}

function geminiPlan(input: Json): PlanStep[] | null {
  if (!Array.isArray(input.todos)) return null;
  const steps = input.todos.flatMap((t): PlanStep[] => {
    if (!isObject(t) || t.status === "cancelled") return [];
    const step = short(str(t.description), 300);
    const status = t.status === "completed" ? "done" : t.status === "in_progress" ? "in_progress" : "pending";
    return step ? [{ step, status }] : [];
  });
  return steps.length ? steps : null;
}

function claudeLine(event: Json): StreamItem[] {
  const message = isObject(event.message) ? event.message : null;
  const content = Array.isArray(message?.content) ? message.content : [];

  if (event.type === "assistant") {
    return content.flatMap((block): StreamItem[] => {
      if (!isObject(block)) return [];
      if (block.type === "thinking") return thought("thinking", str(block.thinking));
      if (block.type === "text") return thought("text", str(block.text));
      if (block.type === "tool_use") {
        const input = isObject(block.input) ? block.input : {};
        const name = str(block.name);
        if (name === "TodoWrite") {
          const steps = claudePlan(input);
          return steps ? [{ kind: "plan", steps }] : [];
        }
        const label = toolLabel(name, input);
        return [{ kind: "action", label }, ...(label.startsWith("$ ") ? [{ kind: "log" as const, stream: "stdout" as const, line: label }] : [])];
      }
      return [];
    });
  }

  if (event.type === "user") {
    // Only a command's output goes to the terminal; a file it read does not.
    const result = isObject(event.tool_use_result) ? event.tool_use_result : null;
    if (result && typeof result.stdout === "string") {
      return [...outputLines(result.stdout), ...outputLines(str(result.stderr), "stderr")];
    }
    return [];
  }
  return [];
}

function codexLine(event: Json): StreamItem[] {
  const item = isObject(event.item) ? event.item : null;
  if (!item) return [];
  const type = str(item.type);

  if (type === "todo_list") {
    const steps = codexPlan(item.items);
    return steps ? [{ kind: "plan", steps }] : [];
  }
  if (event.type === "item.started" && type === "command_execution") {
    const label = `$ ${short(str(item.command).replace(/^bash -lc ['"]?|['"]$/g, ""), 100)}`;
    return [{ kind: "action", label }, { kind: "log", stream: "stdout", line: label }];
  }
  if (event.type !== "item.completed") return [];
  switch (type) {
    case "reasoning":
      return thought("thinking", str(item.text));
    case "agent_message":
      return thought("text", str(item.text));
    case "command_execution":
      return outputLines(str(item.aggregated_output));
    case "file_change": {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      return changes.flatMap((c): StreamItem[] =>
        isObject(c) && str(c.path) ? [{ kind: "action", label: `Editing ${str(c.path)}` }] : [],
      );
    }
    case "web_search":
      return [{ kind: "action", label: `Searching the web for ${short(str(item.query))}` }];
    case "error":
      return [{ kind: "log", stream: "stderr", line: short(str(item.message), MAX_LOG_LINE) }];
    default:
      return [];
  }
}

function geminiLine(event: Json): StreamItem[] {
  if (event.type === "message" && event.role === "assistant") {
    // A piece of a longer message keeps its spaces; readStream joins them.
    const content = str(event.content);
    return event.delta === true
      ? content ? [{ kind: "thought", thought: "text", text: content }] : []
      : thought("text", content);
  }
  if (event.type === "tool_use") {
    const input = isObject(event.parameters) ? event.parameters : {};
    if (str(event.tool_name) === "write_todos") {
      const steps = geminiPlan(input);
      return steps ? [{ kind: "plan", steps }] : [];
    }
    const label = toolLabel(str(event.tool_name), input);
    return [{ kind: "action", label }, ...(label.startsWith("$ ") ? [{ kind: "log" as const, stream: "stdout" as const, line: label }] : [])];
  }
  if (event.type === "tool_result") {
    const output = str(event.output);
    // Shell output is worth the terminal; a file it read is not.
    return event.status === "error"
      ? outputLines(output || str(isObject(event.error) ? event.error.message : ""), "stderr")
      : [];
  }
  if (event.type === "error") {
    return [{ kind: "log", stream: "stderr", line: short(str(event.message), MAX_LOG_LINE) }];
  }
  return [];
}

/** One line of a CLI agent's output, as what a ticket shows. */
export function readStreamLine(line: string): StreamItem[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  let event: unknown;
  try {
    event = trimmed.startsWith("{") ? JSON.parse(trimmed) : null;
  } catch {
    event = null;
  }
  if (!isObject(event)) {
    return [{ kind: "log", stream: "stdout", line: short(line, MAX_LOG_LINE) }];
  }
  const type = str(event.type);
  if (type === "assistant" || type === "user" || type === "system" || type === "result") {
    return claudeLine(event);
  }
  if (type.startsWith("item.") || type.startsWith("turn.") || type.startsWith("thread.")) {
    return codexLine(event);
  }
  return geminiLine(event);
}

/**
 * A batch of lines. Gemini streams what it says in small pieces; pieces in a
 * row are joined into one thought here, so the feed does not show fragments.
 */
export function readStream(lines: string[]): StreamItem[] {
  const out: StreamItem[] = [];
  for (const line of lines) {
    let isDelta = false;
    try {
      const parsed: unknown = JSON.parse(line);
      isDelta = isObject(parsed) && parsed.type === "message" && parsed.delta === true;
    } catch {
      // Not JSON: not a piece of anything.
    }
    for (const item of readStreamLine(line)) {
      const last = out.at(-1);
      if (isDelta && item.kind === "thought" && last?.kind === "thought" && last.thought === item.thought) {
        last.text = `${last.text}${item.text}`.slice(0, MAX_THOUGHT);
        continue;
      }
      if (isDelta && item.kind === "thought" && !item.text.trim()) continue;
      out.push(item);
    }
  }
  for (const item of out) if (item.kind === "thought") item.text = item.text.trim();
  return out
    .filter((item) => item.kind !== "thought" || item.text)
    .flatMap((item) => {
      if (item.kind !== "thought" || item.thought !== "text") return [item];
      const steps = checklistPlan(item.text);
      return steps ? [item, { kind: "plan" as const, steps }] : [item];
    });
}

/**
 * A plan written as a checklist in what the agent says, for an agent with no
 * todo tool: "- [ ] step", "- [x] step". The first step not done is in hand.
 */
export function checklistPlan(text: string): PlanStep[] | null {
  let current = false;
  const steps = text.split("\n").flatMap((line): PlanStep[] => {
    const m = /^\s*(?:[-*]|\d+[.)])\s+\[([ xX~])\]\s+(.+)$/.exec(line);
    if (!m) return [];
    const step = short((m[2] ?? "").trim(), 300);
    if ((m[1] ?? "").toLowerCase() === "x") return [{ step, status: "done" }];
    const status = current ? "pending" : "in_progress";
    current = true;
    return [{ step, status }];
  });
  return steps.length ? steps : null;
}
