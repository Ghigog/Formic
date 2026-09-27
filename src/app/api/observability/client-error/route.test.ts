import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./route";
import { resetSpikeTrackingForTests } from "@/lib/observability/error-tracking";

afterEach(() => {
  vi.restoreAllMocks();
  resetSpikeTrackingForTests();
});

function post(body: unknown) {
  return new NextRequest("http://localhost/api/observability/client-error", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("POST /api/observability/client-error", () => {
  it("tracks a well-formed client error", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await POST(post({ message: "click handler threw", route: "/board" }));

    expect(res.status).toBe(204);
    const logged = JSON.parse(error.mock.calls[0]![1] as string);
    expect(logged.message).toBe("click handler threw");
    expect(logged.route).toBe("/board");
    expect(logged.source).toBe("client");
  });

  it("redacts a secret the client accidentally sent", async () => {
    vi.stubEnv("GITHUB_TOKEN", "ghp_SuperSecretTokenValue1234567890");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await POST(post({ message: "failed with ghp_SuperSecretTokenValue1234567890" }));

    const logged = JSON.parse(error.mock.calls[0]![1] as string);
    expect(logged.message).not.toContain("ghp_SuperSecretTokenValue1234567890");
    vi.unstubAllEnvs();
  });

  it("rejects a malformed body without tracking anything", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await POST(post({ stack: "no message field" }));
    expect(res.status).toBe(204);
    expect(error).not.toHaveBeenCalled();
  });
});
