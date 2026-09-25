import { describe, expect, it } from "vitest";

import { describeProviderError, diagnose, lastWords } from "./limits";

/** A failed "Run the agent" step as GitHub logs it. */
function stepLog(output: string, prompt = "Turn these into tickets."): string {
  return [
    "2026-09-23T15:40:38.4614765Z ##[group]Run set -euo pipefail",
    "2026-09-23T15:40:38.4615170Z \u001b[36;1mset -euo pipefail\u001b[0m",
    `2026-09-23T15:40:38.4716567Z   PROMPT: ${prompt}`,
    "2026-09-23T15:40:38.4744084Z ##[endgroup]",
    `2026-09-23T15:41:32.5220071Z ${output}`,
    "2026-09-23T15:41:32.7166259Z ##[error]Process completed with exit code 1.",
    "2026-09-23T15:41:32.7316154Z Post job cleanup.",
    "2026-09-23T15:41:32.9399180Z Cleaning up orphan processes",
  ].join("\n");
}

describe("diagnose", () => {
  it("reads a Claude Code session limit and when it resets", () => {
    const d = diagnose(stepLog("You've hit your session limit · resets 6:30pm (UTC)"), "Claude Code");
    expect(d?.kind).toBe("limit");
    expect(d?.until?.toISOString()).toBe("2026-09-23T18:30:00.000Z");
    expect(d?.message).toContain("Claude Code hit its usage limit");
    expect(d?.message).toContain("6:30 PM UTC");
  });

  it("rolls a reset time already past over to the next day", () => {
    const log = stepLog("You've hit your session limit · resets 3pm (UTC)");
    expect(diagnose(log, "Claude Code")?.until?.toISOString()).toBe("2026-09-24T15:00:00.000Z");
  });

  it("reads a reset in a named time zone", () => {
    const log = stepLog("5-hour limit reached ∙ resets 11am (America/New_York)");
    // 11am EDT is 15:00 UTC; 15:41 has passed, so tomorrow.
    expect(diagnose(log, "Claude Code")?.until?.toISOString()).toBe("2026-09-24T15:00:00.000Z");
  });

  it("reads a weekly reset with a date", () => {
    const log = stepLog("You've hit your weekly limit · resets Oct 2, 5pm (UTC)");
    expect(diagnose(log, "Claude Code")?.until?.toISOString()).toBe("2026-10-02T17:00:00.000Z");
  });

  it("reads the older epoch form", () => {
    const log = stepLog("Claude AI usage limit reached|1790283600");
    expect(diagnose(log, "Claude Code")?.until?.getTime()).toBe(1790283600 * 1000);
  });

  it("reads a Codex limit given as a duration", () => {
    const log = stepLog("You've hit your usage limit. Try again in 2 hours 5 minutes.");
    expect(diagnose(log, "Codex")?.until?.toISOString()).toBe("2026-09-23T17:46:32.522Z");
  });

  it("says so when a limit has no reset time", () => {
    const d = diagnose(stepLog("Quota exceeded for quota metric 'Gemini requests per day'"), "Gemini CLI");
    expect(d).toMatchObject({ kind: "limit", until: null });
    expect(d?.message).toContain("Try again later");
  });

  it("tells a rejected sign-in apart, with how to fix it", () => {
    const d = diagnose(stepLog("Invalid API key · Please run /login"), "Claude Code");
    expect(d?.kind).toBe("auth");
    expect(d?.message).toContain("claude setup-token");
  });

  it("tells an account out of credit apart", () => {
    const d = diagnose(stepLog("Credit balance is too low"), "Claude Code");
    expect(d?.kind).toBe("credit");
  });

  it("never reads the prompt as the agent's words", () => {
    const log = stepLog("Error: something unrelated broke", "Handle the 429 rate limit and usage limit errors");
    expect(diagnose(log, "Claude Code")).toBeNull();
  });

  it("returns nothing for a log without a failed step", () => {
    expect(diagnose("2026-09-23T15:40:38.4614765Z ##[group]Run x\n##[endgroup]", "Claude Code")).toBeNull();
  });
});

describe("lastWords", () => {
  it("is the last line the failing step printed", () => {
    expect(lastWords(stepLog("Error: ENOSPC: no space left on device"))).toBe(
      "Error: ENOSPC: no space left on device",
    );
  });
});

describe("describeProviderError", () => {
  const now = new Date("2026-09-23T12:00:00Z");

  it("names a rejected key", () => {
    expect(describeProviderError({ label: "Anthropic API", status: 401, message: "invalid x-api-key" })).toContain(
      "rejected the API key",
    );
  });

  it("names an account out of credit", () => {
    expect(
      describeProviderError({
        label: "Anthropic API",
        status: 400,
        message: "Your credit balance is too low to access the Anthropic API.",
      }),
    ).toContain("out of credit");
  });

  it("says until when a rate limit lasts", () => {
    expect(
      describeProviderError({ label: "OpenAI", status: 429, message: "Rate limit", retryAfter: "90", now }),
    ).toContain("12:01 PM UTC");
  });

  it("names an overloaded provider", () => {
    expect(describeProviderError({ label: "Anthropic API", status: 529, message: "Overloaded" })).toContain(
      "overloaded",
    );
  });
});
