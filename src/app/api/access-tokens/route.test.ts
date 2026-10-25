import { beforeEach, describe, expect, it, vi } from "vitest";

const { currentUser, createToken, listTokens, revokeToken } = vi.hoisted(() => ({
  currentUser: vi.fn(),
  createToken: vi.fn(),
  listTokens: vi.fn(),
  revokeToken: vi.fn(),
}));

vi.mock("@/lib/auth/user", () => ({ currentUser, asSignedIn: <T,>(handler: T) => handler }));
vi.mock("@/lib/access-tokens", () => ({ createToken, listTokens, revokeToken }));

const route = await import("./route");
const item = await import("./[id]/route");

const post = (body: unknown) =>
  route.POST(new Request("http://localhost/api/access-tokens", { method: "POST", body: JSON.stringify(body) }));
const del = () => item.DELETE(new Request("http://localhost"), { params: Promise.resolve({ id: "t-1" }) });

beforeEach(() => {
  vi.clearAllMocks();
  currentUser.mockResolvedValue({ id: "u-1" });
});

describe("access token API", () => {
  it("responds 401 to everything when nobody is signed in", async () => {
    currentUser.mockResolvedValue(null);
    expect((await route.GET()).status).toBe(401);
    expect((await post({ name: "x", readOnly: true })).status).toBe(401);
    expect((await del()).status).toBe(401);
    expect(createToken).not.toHaveBeenCalled();
  });

  it("creates a read-only token with an expiry and returns the secret", async () => {
    createToken.mockResolvedValue({ id: "t-1", secret: "fmc_abc" });
    const res = await post({ name: "laptop", readOnly: true, expiresInDays: 30 });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: "t-1", secret: "fmc_abc" });
    const input = createToken.mock.calls[0]![1];
    expect(input).toMatchObject({ name: "laptop", readOnly: true });
    expect(input.expiresAt.getTime() - Date.now()).toBeGreaterThan(29.9 * 86400000);
  });

  it("rejects a nameless token", async () => {
    expect((await post({ name: " ", readOnly: false })).status).toBe(400);
  });

  it("lists only live tokens, without secrets", async () => {
    listTokens.mockResolvedValue([
      { id: "a", name: "a", lastFour: "1234", revokedAt: null },
      { id: "b", name: "b", lastFour: "5678", revokedAt: new Date() },
    ]);
    const body = await (await route.GET()).json();
    expect(body.tokens.map((t: { id: string }) => t.id)).toEqual(["a"]);
  });

  it("revokes, or 404s on a token that is not theirs", async () => {
    revokeToken.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect((await del()).status).toBe(204);
    expect((await del()).status).toBe(404);
    expect(revokeToken).toHaveBeenCalledWith("u-1", "t-1");
  });
});
