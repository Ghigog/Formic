import { describe, expect, it } from "vitest";

import { readStream, readStreamLine, toolLabel } from "./stream";

const line = (event: unknown) => JSON.stringify(event);

describe("reading a CLI agent's stream", () => {
  it("reads Claude Code: thoughts, tools, its todo list and command output", () => {
    const items = readStream([
      line({ type: "system", subtype: "init" }),
      line({
        type: "assistant",
        message: {
          content: [
            { type: "thinking", thinking: "The schema first." },
            { type: "text", text: "Now let's check the CI." },
            { type: "tool_use", id: "1", name: "Bash", input: { command: "npm test" } },
            {
              type: "tool_use",
              id: "2",
              name: "TodoWrite",
              input: {
                todos: [
                  { content: "Add the model", status: "completed" },
                  { content: "Write tests", status: "in_progress" },
                  { content: "Run checks", status: "pending" },
                ],
              },
            },
          ],
        },
      }),
      line({ type: "user", message: { content: [] }, tool_use_result: { stdout: "PASS\nok", stderr: "warn" } }),
      line({ type: "user", message: { content: [] }, tool_use_result: { type: "text", file: { content: "secret" } } }),
      line({ type: "result", result: "Done." }),
    ]);
    expect(items).toEqual([
      { kind: "thought", thought: "thinking", text: "The schema first." },
      { kind: "thought", thought: "text", text: "Now let's check the CI." },
      { kind: "action", label: "$ npm test" },
      { kind: "log", stream: "stdout", line: "$ npm test" },
      {
        kind: "plan",
        steps: [
          { step: "Add the model", status: "done" },
          { step: "Write tests", status: "in_progress" },
          { step: "Run checks", status: "pending" },
        ],
      },
      { kind: "log", stream: "stdout", line: "PASS" },
      { kind: "log", stream: "stdout", line: "ok" },
      { kind: "log", stream: "stderr", line: "warn" },
    ]);
  });

  it("reads Codex: reasoning, commands and their output, file changes and its todo list", () => {
    const items = readStream([
      line({ type: "thread.started", thread_id: "t" }),
      line({ type: "item.completed", item: { type: "reasoning", text: "Look at the db layer." } }),
      line({ type: "item.started", item: { type: "command_execution", command: "bash -lc 'ls src'" } }),
      line({ type: "item.completed", item: { type: "command_execution", command: "ls", aggregated_output: "lib\n" } }),
      line({ type: "item.completed", item: { type: "file_change", changes: [{ path: "src/a.ts", kind: "update" }] } }),
      line({
        type: "item.updated",
        item: { type: "todo_list", items: [{ text: "One", completed: true }, { text: "Two", completed: false }, { text: "Three", completed: false }] },
      }),
      line({ type: "item.completed", item: { type: "agent_message", text: "All done." } }),
    ]);
    expect(items).toEqual([
      { kind: "thought", thought: "thinking", text: "Look at the db layer." },
      { kind: "action", label: "$ ls src" },
      { kind: "log", stream: "stdout", line: "$ ls src" },
      { kind: "log", stream: "stdout", line: "lib" },
      { kind: "action", label: "Editing src/a.ts" },
      {
        kind: "plan",
        steps: [
          { step: "One", status: "done" },
          { step: "Two", status: "in_progress" },
          { step: "Three", status: "pending" },
        ],
      },
      { kind: "thought", thought: "text", text: "All done." },
    ]);
  });

  it("reads Gemini CLI, joining the pieces of what it says", () => {
    const items = readStream([
      line({ type: "init", model: "gemini" }),
      line({ type: "message", role: "assistant", content: "I will read ", delta: true }),
      line({ type: "message", role: "assistant", content: "the file.", delta: true }),
      line({ type: "tool_use", tool_name: "read_file", tool_id: "1", parameters: { absolute_path: "/home/runner/work/app/app/src/x.ts" } }),
      line({ type: "tool_result", tool_id: "1", status: "success", output: "file body" }),
    ]);
    expect(items).toEqual([
      { kind: "thought", thought: "text", text: "I will read the file." },
      { kind: "action", label: "Reading src/x.ts" },
    ]);
  });

  it("passes anything else through to the terminal as it is", () => {
    expect(readStreamLine("npm warn deprecated thing")).toEqual([
      { kind: "log", stream: "stdout", line: "npm warn deprecated thing" },
    ]);
    expect(readStreamLine("{not json")).toEqual([{ kind: "log", stream: "stdout", line: "{not json" }]);
    expect(readStreamLine("   ")).toEqual([]);
  });

  it("keeps the tail of long output, where the result is", () => {
    const stdout = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
    const items = readStreamLine(line({ type: "user", tool_use_result: { stdout, stderr: "" } }));
    expect(items[0]).toEqual({ kind: "log", stream: "stdout", line: "… 60 lines above" });
    expect(items.at(-1)).toEqual({ kind: "log", stream: "stdout", line: "line 99" });
  });

  it("says what a tool does in words", () => {
    expect(toolLabel("Grep", { pattern: "boardCards" })).toBe("Searching for boardCards");
    expect(toolLabel("Edit", { file_path: "/home/runner/work/Formic/Formic/src/a.ts" })).toBe("Editing src/a.ts");
    expect(toolLabel("mcp__thing", {})).toBe("mcp__thing");
  });
});
