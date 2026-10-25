// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AccessTokensSection } from "./access-tokens-section";

const laptop = { id: "t-1", name: "laptop", lastFour: "wxyz", readOnly: true, expiresAt: "2026-11-24T00:00:00.000Z" };
const fetchMock = vi.fn();
const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AccessTokensSection", () => {
  it("shows the secret once with a copy button, and lists the token without it", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") return json({ id: "t-1", secret: "fmc_secretwxyz" }, 201);
      return json({ tokens: fetchMock.mock.calls.some(([, i]) => i?.method === "POST") ? [laptop] : [] });
    });
    render(<AccessTokensSection />);
    await userEvent.type(screen.getByLabelText("Token name"), "laptop");
    await userEvent.click(screen.getByRole("button", { name: "Create token" }));

    expect(await screen.findByText("fmc_secretwxyz")).toBeInTheDocument();
    const post = fetchMock.mock.calls.find(([, i]) => i?.method === "POST")![1];
    expect(JSON.parse(post.body)).toEqual({ name: "laptop", readOnly: true, expiresInDays: 30 });
    expect(await screen.findByText(/laptop · …wxyz · Read-only/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledWith("fmc_secretwxyz");
  });

  it("on a fresh load shows name, last four, mode and expiry but no secret", async () => {
    render(<AccessTokensSection initial={[laptop]} />);
    expect(await screen.findByText(/laptop · …wxyz · Read-only · Expires 2026-11-24/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();
  });

  it("revokes a token and drops it from the list", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 204 });
    render(<AccessTokensSection initial={[laptop]} />);
    await userEvent.click(await screen.findByRole("button", { name: "Revoke laptop" }));
    expect(fetchMock).toHaveBeenCalledWith("/api/access-tokens/t-1", { method: "DELETE" });
    await waitFor(() => expect(screen.queryByText(/laptop/)).toBeNull());
  });
});
