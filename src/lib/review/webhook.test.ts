import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import { interpret, verifySignature } from "./webhook";

const SECRET = "shhh";

function sign(body: string, secret = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

describe("verifySignature", () => {
  const body = JSON.stringify({ action: "completed" });

  it("accepts a delivery signed with the configured secret", () => {
    expect(verifySignature(body, sign(body), SECRET)).toBe(true);
  });

  it("rejects a delivery signed with a different secret", () => {
    expect(verifySignature(body, sign(body, "wrong"), SECRET)).toBe(false);
  });

  it("rejects a delivery whose body was altered after signing", () => {
    const signature = sign(body);
    expect(verifySignature(`${body} `, signature, SECRET)).toBe(false);
  });

  it("rejects a missing or malformed signature without throwing", () => {
    expect(verifySignature(body, null, SECRET)).toBe(false);
    expect(verifySignature(body, "sha256=short", SECRET)).toBe(false);
    expect(verifySignature(body, "garbage", SECRET)).toBe(false);
  });
});

describe("interpret", () => {
  it("reads a completed check run", () => {
    const signals = interpret("check_run", {
      action: "completed",
      check_run: {
        name: "ci / test",
        head_sha: "abc123",
        pull_requests: [{ number: 7 }],
      },
    });

    expect(signals).toEqual([
      {
        kind: "ci",
        prNumber: 7,
        headSha: "abc123",
        checkName: "ci / test",
        key: "7:abc123:ci / test",
      },
    ]);
  });

  it("ignores a check run that has not finished", () => {
    expect(
      interpret("check_run", {
        action: "created",
        check_run: { name: "ci", head_sha: "abc", pull_requests: [{ number: 7 }] },
      }),
    ).toEqual([]);
  });

  it("keys on the result, so a redelivery produces the same key", () => {
    const payload = {
      action: "completed",
      check_run: { name: "ci", head_sha: "abc", pull_requests: [{ number: 7 }] },
    };

    const first = interpret("check_run", payload);
    const second = interpret("check_run", payload);

    expect(first[0]!.key).toBe(second[0]!.key);
  });

  it("gives two checks on one commit distinct keys", () => {
    const lint = interpret("check_run", {
      action: "completed",
      check_run: { name: "lint", head_sha: "abc", pull_requests: [{ number: 7 }] },
    });
    const test = interpret("check_run", {
      action: "completed",
      check_run: { name: "test", head_sha: "abc", pull_requests: [{ number: 7 }] },
    });

    expect(lint[0]!.key).not.toBe(test[0]!.key);
  });

  it("reads check suites and workflow runs", () => {
    expect(
      interpret("check_suite", {
        action: "completed",
        check_suite: { id: 99, head_sha: "def", pull_requests: [{ number: 3 }] },
      })[0],
    ).toMatchObject({ prNumber: 3, headSha: "def", checkName: "suite:99" });

    expect(
      interpret("workflow_run", {
        action: "completed",
        workflow_run: { name: "CI", head_sha: "def", pull_requests: [{ number: 3 }] },
      })[0],
    ).toMatchObject({ prNumber: 3, checkName: "workflow:CI" });
  });

  it("notices a pull request a human merged", () => {
    expect(
      interpret("pull_request", {
        action: "closed",
        pull_request: { number: 12, merged: true, merge_commit_sha: "aaa" },
      }),
    ).toEqual([{ kind: "merged", prNumber: 12, key: "12:merged:aaa" }]);
  });

  it("ignores a pull request that was closed without merging", () => {
    expect(
      interpret("pull_request", {
        action: "closed",
        pull_request: { number: 12, merged: false },
      }),
    ).toEqual([]);
  });

  it("ignores events it has no opinion about", () => {
    expect(interpret("push", { ref: "refs/heads/main" })).toEqual([]);
    expect(interpret("check_run", {})).toEqual([]);
  });

  it("ignores a check run attached to no pull request", () => {
    expect(
      interpret("check_run", {
        action: "completed",
        check_run: { name: "ci", head_sha: "abc", pull_requests: [] },
      }),
    ).toEqual([]);
  });
});
