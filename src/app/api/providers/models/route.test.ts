import { beforeEach, describe, expect, it, vi } from "vitest";

const { currentUser, presetForRun, listOpenAiModels, authMode, list } = vi.hoisted(() => ({
  currentUser: vi.fn(),
  presetForRun: vi.fn(),
  listOpenAiModels: vi.fn(),
  authMode: vi.fn(),
  list: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ repository: () => ({ presetForRun }) }));
vi.mock("@/lib/auth/user", () => ({ currentUser, canSee: (u: { id: string }, owner: string) => u.id === owner }));
vi.mock("@/lib/auth/session", () => ({ authMode }));
vi.mock("@/lib/llm/openai-compat", () => ({ listOpenAiModels }));
vi.mock("@/lib/agents/anthropic", () => ({ anthropicClient: () => ({ models: { list } }) }));
vi.mock("@/lib/secrets/vault", () => ({ open: (c: string) => `opened-${c}` }));

const { POST } = await import("./route");

const post = (body: unknown) =>
  POST(new Request("http://localhost/api/providers/models", { method: "POST", body: JSON.stringify(body) }));

beforeEach(() => {
  currentUser.mockReset().mockResolvedValue({ id: "u1" });
  presetForRun.mockReset();
  listOpenAiModels.mockReset().mockResolvedValue([{ id: "gpt-x" }]);
  list.mockReset().mockImplementation(async function* () {
    yield { id: "claude-x" };
  });
  authMode.mockReset().mockReturnValue("github");
});

describe("POST /api/providers/models", () => {
  it("answers 401 when signed out", async () => {
    currentUser.mockResolvedValue(null);
    expect((await post({ provider: "openai" })).status).toBe(401);
  });

  it("answers 400 for an unknown provider", async () => {
    expect((await post({ provider: "nope" })).status).toBe(400);
  });

  it("answers a CLI agent's suggested models without a key", async () => {
    const body = await (await post({ provider: "claude-code" })).json();
    expect(body.ok).toBe(true);
    expect(body.models.length).toBeGreaterThan(0);
  });

  it("lists OpenAI-compatible models with a typed key", async () => {
    const res = await post({ provider: "openai", apiKey: "k" });
    expect(await res.json()).toEqual({ ok: true, models: [{ id: "gpt-x" }] });
    expect(listOpenAiModels).toHaveBeenCalledWith(expect.objectContaining({ kind: "openai" }), "k");
  });

  it("lists Anthropic models", async () => {
    const res = await post({ provider: "anthropic", apiKey: "k" });
    expect(await res.json()).toEqual({ ok: true, models: [{ id: "claude-x" }] });
  });

  it("uses a saved template's key the user can see", async () => {
    presetForRun.mockResolvedValue({ preset: { ownerId: "u1" }, apiKeyCipher: "c" });
    await post({ provider: "openai", presetId: "pr1" });
    expect(listOpenAiModels).toHaveBeenCalledWith(expect.anything(), "opened-c");
  });

  it("ignores a saved key the user cannot see", async () => {
    presetForRun.mockResolvedValue({ preset: { ownerId: "other" }, apiKeyCipher: "c" });
    const body = await (await post({ provider: "openai", presetId: "pr1" })).json();
    expect(body.ok).toBe(false);
    expect(listOpenAiModels).not.toHaveBeenCalled();
  });

  it("asks for a key when there is none", async () => {
    const body = await (await post({ provider: "openai" })).json();
    expect(body).toMatchObject({ ok: false, reason: expect.stringContaining("API key") });
  });

  it("answers the provider's failure as a reason", async () => {
    listOpenAiModels.mockRejectedValue(new Error("Bad key"));
    expect(await (await post({ provider: "openai", apiKey: "k" })).json()).toEqual({ ok: false, reason: "Bad key" });
  });
});
