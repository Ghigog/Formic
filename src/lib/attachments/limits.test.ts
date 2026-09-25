import { describe, expect, it } from "vitest";
import {
  MAX_ATTACHMENTS_PER_REQUEST,
  MAX_ATTACHMENT_BYTES,
  checkAttachment,
  checkBatch,
} from "./limits";

const png = (overrides: Partial<{ name: string; type: string; size: number }> = {}) => ({
  name: "shot.png",
  type: "image/png",
  size: 1024,
  ...overrides,
});

describe("checkAttachment", () => {
  it("allows a file within the type and size limits", () => {
    expect(checkAttachment(png())).toEqual({ ok: true });
  });

  it("allows a file exactly at the size limit", () => {
    expect(checkAttachment(png({ size: MAX_ATTACHMENT_BYTES })).ok).toBe(true);
  });

  it("rejects a file one byte over the size limit, naming the limit it broke", () => {
    const result = checkAttachment(png({ size: MAX_ATTACHMENT_BYTES + 1 }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(413);
      expect(result.error).toMatch(/larger than/i);
    }
  });

  it("rejects a disallowed MIME type, naming the limit it broke", () => {
    const result = checkAttachment(png({ type: "application/zip" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.error).toMatch(/application\/zip/);
    }
  });
});

describe("checkBatch", () => {
  it("allows a file when the request is exactly one under the cap", () => {
    const result = checkBatch(MAX_ATTACHMENTS_PER_REQUEST - 1, [png()]);
    expect(result.ok).toBe(true);
  });

  it("allows a file that lands exactly at the cap", () => {
    const result = checkBatch(MAX_ATTACHMENTS_PER_REQUEST - 1, [png()]);
    expect(result.ok).toBe(true);
  });

  it("rejects a file that would push the request one over the cap", () => {
    const result = checkBatch(MAX_ATTACHMENTS_PER_REQUEST, [png()]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.error).toMatch(new RegExp(String(MAX_ATTACHMENTS_PER_REQUEST)));
    }
  });

  it("still checks each file's own limits under the count cap", () => {
    const result = checkBatch(0, [png({ type: "text/rtf" })]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(400);
  });
});
