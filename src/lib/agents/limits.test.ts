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

  it("reads insufficient_quota as a used-up allowance, not a balance", () => {
    const d = diagnose(stepLog("Error: insufficient_quota"), "Claude Code");
    expect(d?.kind).toBe("limit");
  });

  it("does not read the word billing, or a stray 402, as a balance problem", () => {
    expect(diagnose(stepLog("Error: could not parse billing config"), "Claude Code")).toBeNull();
    expect(diagnose(stepLog("402 passing tests"), "Claude Code")).toBeNull();
  });

  it("does not read a line count, or a file number, as a status code", () => {
    // A real loop run: the agent's own `wc -l` came out in the log, and the
    // run's ending was the turn ceiling, not the plan running out.
    const log = stepLog(
      "429 src/lib/db/repository-contract.test.ts\n401 src/lib/db/repository.ts\nThe agent did not converge in 40 turns. This needs a human.",
    );
    expect(diagnose(log, "ClinePass")).toBeNull();
  });

  it("still reads a status code where the log says it is one", () => {
    expect(diagnose(stepLog("Request failed: status code 429"), "ClinePass")?.kind).toBe("limit");
    expect(diagnose(stepLog('{"error":{"code":429}}'), "ClinePass")?.kind).toBe("limit");
    expect(diagnose(stepLog("error 401 from the gateway"), "ClinePass")?.kind).toBe("auth");
  });

  it("does not read the line count inside a streamed envelope as a status code", () => {
    // The same run as above, as the job actually reported it: every line is an
    // envelope, and the number is still the agent's own `wc -l` output.
    const log = stepLog(
      '{"type":"run.log","runId":"r","stream":"stdout","line":"429 src/lib/db/repository-contract.test.ts"}',
    );
    expect(diagnose(log, "ClinePass")).toBeNull();
  });

  it("reads a mention of rate limiting as code, not as a refusal", () => {
    // A real run: the agent was rewriting this test when its turns ran out,
    // and the card said the account was out of usage while it was fine.
    const log = stepLog(
      'expect(onSubmit).toHaveBeenCalledWith("Rate-limit the merge queue", expect.any(String));',
    );
    expect(diagnose(log, "ClinePass")).toBeNull();
    expect(diagnose(stepLog("Rate limit reached for gpt-4 in organization org-1"), "OpenAI")?.kind).toBe(
      "limit",
    );
    expect(diagnose(stepLog('{"error":{"type":"rate_limit_error"}}'), "OpenAI")?.kind).toBe("limit");
    expect(diagnose(stepLog("You've hit your rate limit"), "OpenAI")?.kind).toBe("limit");
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

  it("skips our own exit line, so the reason printed before it stays", () => {
    const log = stepLog(
      "The agent did not converge in 40 turns. This needs a human.\nThe loop stopped (exit 1).",
    );
    expect(lastWords(log)).toBe("The agent did not converge in 40 turns. This needs a human.");
  });

  it("keeps reading to the end when the run's own stream was annotated as errors", () => {
    // A real run: the loop streams to stderr, GitHub annotates each of those
    // lines as an error, and the first marker sat at 17:08 — the point where
    // the agent happened to be running tsc. The reason is printed 90 seconds
    // later, and this is the card that quoted `> tsc --noEmit` instead.
    const log = [
      "2026-09-29T17:06:10.6352459Z ##[group]Run set -euo pipefail",
      "2026-09-29T17:06:10.6400000Z   PROMPT: Paste an image from the clipboard.",
      "2026-09-29T17:06:10.6450000Z ##[endgroup]",
      '2026-09-29T17:08:00.8925768Z ##[error]{"type":"run.log","runId":"r","stream":"stdout","line":"src/components/board/new-item-dialog.tsx(110,7): error TS2304: Cannot find name \'pasteRef\'."}',
      '2026-09-29T17:09:33.9548403Z {"type":"run.log","runId":"r","stream":"stdout","line":"> tsc --noEmit"}',
      "2026-09-29T17:09:33.9386970Z The agent did not converge in 40 turns. This needs a human.",
      "2026-09-29T17:09:33.9552868Z The loop stopped (exit 1).",
      "2026-09-29T17:09:40.9637688Z ##[error]Process completed with exit code 1.",
      "2026-09-29T17:09:41.1439970Z ##[warning]Node.js 20 is deprecated.",
    ].join("\n");
    expect(lastWords(log)).toBe("The agent did not converge in 40 turns. This needs a human.");
  });

  it("prefers the job's own reason to the tool output that followed it", () => {
    const log = stepLog(
      [
        "Ran out of time: this run's budget is 30 minutes. The job's own timeout is the backstop; raise the ticket's budget to give it longer.",
        '{"type":"run.log","runId":"r","stream":"stdout","line":"changed src/lib/db/repository.ts"}',
        "The loop stopped (exit 1).",
      ].join("\n"),
    );
    expect(lastWords(log)).toContain("Ran out of time: this run's budget is 30 minutes.");
  });

  it("never quotes an envelope, only the line it carries", () => {
    const log = stepLog('{"type":"run.log","runId":"r","stream":"stdout","line":"> tsc --noEmit"}');
    expect(lastWords(log)).toBe("> tsc --noEmit");
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

  it("keeps the status code and the provider's own words, so a wrong guess is visible", () => {
    const message = describeProviderError({
      label: "ClinePass",
      status: 402,
      message: "Payment required: this key has no allowance",
    });
    expect(message).toContain("out of credit");
    expect(message).toContain("HTTP 402");
    expect(message).toContain("this key has no allowance");
  });

  it("calls insufficient_quota a limit, not a balance, and says the status", () => {
    const message = describeProviderError({
      label: "ClinePass",
      status: 429,
      message: '{"error":{"code":"insufficient_quota"}}',
    });
    expect(message).toContain("rate limiting");
    expect(message).toContain("HTTP 429");
    expect(message).not.toContain("out of credit");
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
