import { describe, expect, it } from "vitest";

import { outputLines, readStream, readStreamLine, toolLabel } from "./stream";

const line = (o: object) => JSON.stringify(o);

describe("toolLabel", () => {
  it.each([
    ["Bash", { command: "ls   -la" }, "$ ls -la"],
    ["run_shell_command", { command: "pwd" }, "$ pwd"],
    ["Read", { file_path: "/home/runner/work/a/b/src/x.ts" }, "Reading src/x.ts"],
    ["read_file", { absolute_path: "src/y.ts" }, "Reading src/y.ts"],
    ["Write", { path: "src/z.ts" }, "Writing src/z.ts"],
    ["write_file", { notebook_path: "n.ipynb" }, "Writing n.ipynb"],
    ["Edit", { file_path: "a.ts" }, "Editing a.ts"],
    ["MultiEdit", { file_path: "a.ts" }, "Editing a.ts"],
    ["replace", { file_path: "a.ts" }, "Editing a.ts"],
    ["Glob", { pattern: "**/*.ts" }, "Finding **/*.ts"],
    ["Grep", { pattern: "foo" }, "Searching for foo"],
    ["search_file_content", { pattern: "bar" }, "Searching for bar"],
    ["LS", {}, "Listing files"],
    ["list_directory", { path: "src" }, "Listing src"],
    ["WebFetch", { url: "https://x.dev" }, "Fetching https://x.dev"],
    ["web_fetch", { prompt: "the docs" }, "Fetching the docs"],
    ["WebSearch", { query: "vitest" }, "Searching the web for vitest"],
    ["google_web_search", { query: "next" }, "Searching the web for next"],
    ["Task", { description: "look around" }, "Delegating: look around"],
    ["Agent", { prompt: "go" }, "Delegating: go"],
    ["Mystery", { file_path: "q.ts" }, "Mystery q.ts"],
    ["Mystery", {}, "Mystery"],
    ["Write", { file_path: "/x/_temp/formic-summary.md" }, "Writing up what it did"],
    ["Edit", { file_path: "/x/_temp/formic-answer.md" }, "Writing its answer"],
  ])("labels %s %j", (name, input, label) => {
    expect(toolLabel(name, input)).toBe(label);
  });

  it("shortens a long command to one line", () => {
    expect(toolLabel("Bash", { command: "x".repeat(300) }).length).toBeLessThanOrEqual(102);
  });
});

describe("outputLines", () => {
  it("is empty for empty output, keeps the tail of long output and cuts long lines", () => {
    expect(outputLines("")).toEqual([]);
    const many = outputLines(Array.from({ length: 60 }, (_, i) => `l${i}`).join("\n"), "stderr");
    expect(many[0]).toMatchObject({ line: "… 20 lines above", stream: "stderr" });
    expect(many).toHaveLength(41);
    expect(outputLines("y".repeat(500))[0]).toMatchObject({ line: `${"y".repeat(400)}…` });
  });
});

describe("Claude Code stream-json", () => {
  const assistant = (...content: object[]) => line({ type: "assistant", message: { content } });

  it("reads thoughts, tool calls, plans and command output", () => {
    expect(readStreamLine(assistant({ type: "thinking", thinking: " hm " }, { type: "text", text: "" }, "junk" as never, { type: "other" }))).toEqual([
      { kind: "thought", thought: "thinking", text: "hm" },
    ]);
    expect(readStreamLine(assistant({ type: "tool_use", name: "Bash", input: { command: "ls" } }))).toEqual([
      { kind: "action", label: "$ ls" },
      { kind: "log", stream: "stdout", line: "$ ls" },
    ]);
    expect(readStreamLine(assistant({ type: "tool_use", name: "Read", input: { file_path: "a" } }, { type: "tool_use", name: "Edit" }))).toHaveLength(2);
    const plan = assistant({
      type: "tool_use",
      name: "TodoWrite",
      input: {
        todos: [
          { content: "a", status: "completed" },
          { content: "b", status: "in_progress" },
          { content: "c", status: "pending" },
          { content: "" },
          "junk",
        ],
      },
    });
    expect(readStreamLine(plan)).toEqual([
      {
        kind: "plan",
        steps: [
          { step: "a", status: "done" },
          { step: "b", status: "in_progress" },
          { step: "c", status: "pending" },
        ],
      },
    ]);
    expect(readStreamLine(assistant({ type: "tool_use", name: "TodoWrite", input: { todos: "no" } }))).toEqual([]);
    expect(readStreamLine(line({ type: "user", tool_use_result: { stdout: "out", stderr: "err" } }))).toEqual([
      { kind: "log", stream: "stdout", line: "out" },
      { kind: "log", stream: "stderr", line: "err" },
    ]);
    expect(readStreamLine(line({ type: "user", tool_use_result: { content: "file" } }))).toEqual([]);
    expect(readStreamLine(line({ type: "user" }))).toEqual([]);
    expect(readStreamLine(line({ type: "system" }))).toEqual([]);
    expect(readStreamLine(line({ type: "assistant" }))).toEqual([]);
  });
});

describe("Codex exec --json", () => {
  const item = (type: string, o: object, event = "item.completed") => line({ type: event, item: { type, ...o } });

  it("reads plans, commands, file changes, searches and errors", () => {
    expect(readStreamLine(item("todo_list", { items: [{ text: "a", completed: true }, { text: "b" }, { text: "c" }, { text: "" }, 3] }))).toEqual([
      {
        kind: "plan",
        steps: [
          { step: "a", status: "done" },
          { step: "b", status: "in_progress" },
          { step: "c", status: "pending" },
        ],
      },
    ]);
    expect(readStreamLine(item("todo_list", { items: [] }))).toEqual([]);
    expect(readStreamLine(item("todo_list", { items: "x" }))).toEqual([]);
    expect(readStreamLine(item("command_execution", { command: `bash -lc 'npm test'` }, "item.started"))).toEqual([
      { kind: "action", label: "$ npm test" },
      { kind: "log", stream: "stdout", line: "$ npm test" },
    ]);
    expect(readStreamLine(item("command_execution", { aggregated_output: "ok" }))).toEqual([{ kind: "log", stream: "stdout", line: "ok" }]);
    expect(readStreamLine(item("reasoning", { text: "think" }))[0]).toMatchObject({ thought: "thinking" });
    expect(readStreamLine(item("agent_message", { text: "said" }))[0]).toMatchObject({ thought: "text" });
    expect(readStreamLine(item("file_change", { changes: [{ path: "a.ts" }, { path: "" }, 1] }))).toEqual([{ kind: "action", label: "Editing a.ts" }]);
    expect(readStreamLine(item("file_change", {}))).toEqual([]);
    expect(readStreamLine(item("web_search", { query: "q" }))).toEqual([{ kind: "action", label: "Searching the web for q" }]);
    expect(readStreamLine(item("error", { message: "bad" }))).toEqual([{ kind: "log", stream: "stderr", line: "bad" }]);
    expect(readStreamLine(item("unknown", {}))).toEqual([]);
    expect(readStreamLine(item("agent_message", { text: "x" }, "item.started"))).toEqual([]);
    expect(readStreamLine(line({ type: "turn.completed" }))).toEqual([]);
  });
});

describe("Gemini stream-json", () => {
  it("reads messages, tools, plans, results and errors", () => {
    expect(readStreamLine(line({ type: "message", role: "assistant", content: " hi ", delta: true }))).toEqual([
      { kind: "thought", thought: "text", text: " hi " },
    ]);
    expect(readStreamLine(line({ type: "message", role: "assistant", content: "", delta: true }))).toEqual([]);
    expect(readStreamLine(line({ type: "message", role: "assistant", content: " full " }))).toEqual([
      { kind: "thought", thought: "text", text: "full" },
    ]);
    expect(readStreamLine(line({ type: "tool_use", tool_name: "run_shell_command", parameters: { command: "ls" } }))).toHaveLength(2);
    expect(readStreamLine(line({ type: "tool_use", tool_name: "mystery" }))).toEqual([{ kind: "action", label: "mystery" }]);
    expect(
      readStreamLine(
        line({
          type: "tool_use",
          tool_name: "write_todos",
          parameters: { todos: [{ description: "a", status: "completed" }, { description: "b", status: "cancelled" }, { description: "c", status: "in_progress" }, { description: "d" }, { description: "" }] },
        }),
      ),
    ).toEqual([
      {
        kind: "plan",
        steps: [
          { step: "a", status: "done" },
          { step: "c", status: "in_progress" },
          { step: "d", status: "pending" },
        ],
      },
    ]);
    expect(readStreamLine(line({ type: "tool_use", tool_name: "write_todos", parameters: {} }))).toEqual([]);
    expect(readStreamLine(line({ type: "tool_result", status: "error", output: "boom" }))).toEqual([{ kind: "log", stream: "stderr", line: "boom" }]);
    expect(readStreamLine(line({ type: "tool_result", status: "error", error: { message: "bad" } }))).toEqual([{ kind: "log", stream: "stderr", line: "bad" }]);
    expect(readStreamLine(line({ type: "tool_result", status: "error" }))).toEqual([]);
    expect(readStreamLine(line({ type: "tool_result", status: "ok", output: "x" }))).toEqual([]);
    expect(readStreamLine(line({ type: "error", message: "oops" }))).toEqual([{ kind: "log", stream: "stderr", line: "oops" }]);
    expect(readStreamLine(line({ type: "init" }))).toEqual([]);
  });

  it("joins streamed pieces of a message, and finds a checklist in what is said", () => {
    const piece = (content: string) => line({ type: "message", role: "assistant", content, delta: true });
    const items = readStream([piece("- [ ] one\n"), piece("- [x] "), piece("two"), piece("  "), "not json", "{bad"]);
    expect(items[0]).toMatchObject({ kind: "thought", thought: "text" });
    expect(items.some((i) => i.kind === "plan")).toBe(true);
    expect(items.filter((i) => i.kind === "log")).toHaveLength(2);
  });
});

describe("Formic's own events", () => {
  it.each([
    [{ type: "run.thought", kind: "thinking", text: "t" }, [{ kind: "thought", thought: "thinking", text: "t" }]],
    [{ type: "run.thought", text: "t" }, [{ kind: "thought", thought: "text", text: "t" }]],
    [{ type: "run.progress", label: "l" }, [{ kind: "action", label: "l" }]],
    [{ type: "run.progress" }, []],
    [{ type: "run.log", stream: "stderr", line: "e" }, [{ kind: "log", stream: "stderr", line: "e" }]],
    [{ type: "run.log", line: "o" }, [{ kind: "log", stream: "stdout", line: "o" }]],
    [{ type: "run.diff", path: "a.ts" }, [{ kind: "action", label: "Changed a.ts" }]],
    [{ type: "run.diff" }, []],
    [{ type: "run.other" }, []],
    [{ type: "repo.note", text: " n " }, [{ kind: "share", text: "n" }]],
    [{ type: "repo.note", text: " " }, []],
    [{ type: "repo.note.rated", noteSeq: 3, verdict: "helped" }, [{ kind: "rate", noteSeq: 3, verdict: "helped" }]],
    [{ type: "repo.note.rated", noteSeq: 0, verdict: "helped" }, []],
    [{ type: "repo.note.rated", noteSeq: 2, verdict: "meh" }, []],
    [{ type: "ticket.plan", steps: [{ step: "a", status: "done" }] }, [{ kind: "plan", steps: [{ step: "a", status: "done" }] }]],
    [{ type: "ticket.plan" }, []],
  ])("reads %j", (event, expected) => {
    expect(readStreamLine(line(event))).toEqual(expected);
  });

  it("treats blank and plain lines", () => {
    expect(readStreamLine("   ")).toEqual([]);
    expect(readStreamLine("plain text")).toEqual([{ kind: "log", stream: "stdout", line: "plain text" }]);
    expect(readStreamLine("[1,2]")).toEqual([{ kind: "log", stream: "stdout", line: "[1,2]" }]);
  });
});
