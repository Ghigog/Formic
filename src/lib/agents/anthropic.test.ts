import { describe, expect, it } from "vitest";

import { billedInputTokens, cachedToHere } from "./anthropic";

describe("prompt caching", () => {
  it("marks only the last block of the conversation it sends", () => {
    const messages = [
      { role: "user", content: "Implement T-1." },
      { role: "assistant", content: [{ type: "text", text: "Reading." }] },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "a", content: "one" },
          { type: "tool_result", tool_use_id: "b", content: "two" },
        ],
      },
    ];
    const sent = cachedToHere(messages);

    expect(sent[2]!.content).toEqual([
      { type: "tool_result", tool_use_id: "a", content: "one" },
      { type: "tool_result", tool_use_id: "b", content: "two", cache_control: { type: "ephemeral" } },
    ]);
    expect(sent[0]).toBe(messages[0]);
    // The transcript kept for the next turn carries no marker.
    expect(JSON.stringify(messages)).not.toContain("cache_control");
  });

  it("turns a plain first prompt into a block it can mark", () => {
    expect(cachedToHere([{ role: "user", content: "Implement T-1." }])[0]!.content).toEqual([
      { type: "text", text: "Implement T-1.", cache_control: { type: "ephemeral" } },
    ]);
  });

  it("bills cache writes and reads at their own rates", () => {
    expect(
      billedInputTokens({
        input_tokens: 100,
        cache_creation_input_tokens: 1_000,
        cache_read_input_tokens: 10_000,
      }),
    ).toEqual({ tokensIn: 11_100, costTokensIn: 100 + 1_250 + 1_000 });
  });
});
