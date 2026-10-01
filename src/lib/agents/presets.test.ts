import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentConfigFor, agentFor, columnLimit, tokensUsedInWindow, runTargetFor, savePreset, sentinelAgent } from "./presets";
import { LoopCoderAgent, LoopReviewerAgent } from "./coder";
import { MockCoderAgent } from "./mock";
import { AnthropicProductAgent } from "./anthropic";
import { OpenAiArchitectAgent, OpenAiProductAgent } from "./openai-agents";
import { resetAgents } from "./registry";
import { repository } from "@/lib/db";
import { resetEnvCache } from "@/lib/secrets/env";

const PROJECT = "project_default";

beforeEach(() => {
  globalThis.__formicMemoryStore = undefined;
  resetAgents();
  vi.stubEnv("AGENT_PROVIDER", "mock");
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  vi.stubEnv("FORMIC_SECRET", "test");
  resetEnvCache();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvCache();
});

const worker = {
  name: "claude-worker",
  provider: "anthropic" as const,
  model: "claude-sonnet-5",
  prompt: "Implement the ticket. Keep it small.",
};

describe("agent templates", () => {
  it("names the saved agent a column's work belongs to, so its tokens are counted to it", async () => {
    const preset = await savePreset({ ...worker, name: "claude-worker" });
    await repository().setColumnAgent(PROJECT, "in_progress", preset.id);

    // Every run is attributed from here: the same lookup that decides model
    // and provider also says which saved agent's plan or key pays for it.
    expect(await runTargetFor(PROJECT, "coder")).toMatchObject({
      model: "claude-sonnet-5",
      presetId: preset.id,
    });
    // A column with no agent of its own has none to count against.
    expect(await runTargetFor(PROJECT, "reviewer")).toMatchObject({ presetId: null });
  });

  it("runs a column's template, with its provider, model, prompt and key", async () => {
    const preset = await savePreset({ ...worker, apiKey: "sk-ant-worker-1234" });
    await repository().setColumnAgent(PROJECT, "in_progress", preset.id);

    expect(preset).toMatchObject({ hasKey: true, keyHint: "1234", provider: "anthropic" });
    expect(JSON.stringify(preset)).not.toContain("sk-ant");

    expect(await agentConfigFor(PROJECT, "in_progress")).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-5",
      brief: worker.prompt,
      apiKey: "sk-ant-worker-1234",
    });
    expect(await agentFor(PROJECT, "coder")).toBeInstanceOf(LoopCoderAgent);
  });

  it("mixes providers across one board", async () => {
    const product = await savePreset({
      name: "po",
      provider: "deepseek",
      model: "deepseek-chat",
      prompt: "p",
      apiKey: "sk-deepseek",
    });
    const architect = await savePreset({
      name: "arch",
      provider: "gemini",
      model: "gemini-2.5-pro",
      prompt: "a",
      apiKey: "AIza-gemini",
    });
    const reviewer = await savePreset({ ...worker, apiKey: "sk-ant-review" });
    await repository().setColumnAgent(PROJECT, "backlog", product.id);
    await repository().setColumnAgent(PROJECT, "todo", architect.id);
    await repository().setColumnAgent(PROJECT, "in_review", reviewer.id);

    expect(await agentFor(PROJECT, "product")).toBeInstanceOf(OpenAiProductAgent);
    expect(await agentFor(PROJECT, "architect")).toBeInstanceOf(OpenAiArchitectAgent);
    expect((await agentConfigFor(PROJECT, "backlog"))?.apiKey).toBe("sk-deepseek");
    expect((await agentConfigFor(PROJECT, "todo"))?.apiKey).toBe("AIza-gemini");
    expect((await agentConfigFor(PROJECT, "in_review"))?.provider).toBe("anthropic");
  });

  it("runs one ClinePass key as all four roles on a board", async () => {
    const flash = {
      provider: "clinepass" as const,
      model: "deepseek/deepseek-v4.1-flash",
      prompt: "Keep it small.",
    };
    const coder = await savePreset({ ...flash, name: "cline-worker", apiKey: "cline-key-1234" });
    const reviewer = await savePreset({ ...flash, name: "cline-reviewer" });
    const product = await savePreset({ ...flash, name: "cline-po" });
    const architect = await savePreset({ ...flash, name: "cline-arch" });
    await repository().setColumnAgent(PROJECT, "in_progress", coder.id);
    await repository().setColumnAgent(PROJECT, "in_review", reviewer.id);
    await repository().setColumnAgent(PROJECT, "backlog", product.id);
    await repository().setColumnAgent(PROJECT, "todo", architect.id);

    // One OpenAI-format provider covers the whole board: the tool loop for
    // the two coding columns, the JSON planners for the other two.
    expect(await agentFor(PROJECT, "coder")).toBeInstanceOf(LoopCoderAgent);
    expect(await agentFor(PROJECT, "reviewer")).toBeInstanceOf(LoopReviewerAgent);
    expect(await agentFor(PROJECT, "product")).toBeInstanceOf(OpenAiProductAgent);
    expect(await agentFor(PROJECT, "architect")).toBeInstanceOf(OpenAiArchitectAgent);
    expect(await agentConfigFor(PROJECT, "in_progress")).toMatchObject({
      provider: "clinepass",
      model: "deepseek/deepseek-v4.1-flash",
      apiKey: "cline-key-1234",
    });
  });

  it("keeps a saved key through an edit that does not mention it", async () => {
    const preset = await savePreset({ ...worker, apiKey: "sk-ant-worker-1234" });
    const edited = await savePreset({ ...worker, id: preset.id, name: "renamed" });
    expect(edited).toMatchObject({ name: "renamed", hasKey: true, keyHint: "1234" });

    const cleared = await savePreset({ ...worker, id: preset.id, apiKey: null });
    expect(cleared).toMatchObject({ hasKey: false, keyHint: null });
  });

  it("in local mode, runs the mock on a column with no template", async () => {
    expect(await agentConfigFor(PROJECT, "in_progress")).toBeNull();
    expect(await agentFor(PROJECT, "coder")).toBeInstanceOf(MockCoderAgent);
  });

  it("in local mode, runs Claude on the server key when there is one", async () => {
    vi.stubEnv("AGENT_PROVIDER", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-server");
    expect(await agentFor(PROJECT, "product")).toBeInstanceOf(AnthropicProductAgent);
  });

  it("unassigns a deleted template", async () => {
    const preset = await savePreset(worker);
    await repository().setColumnAgent(PROJECT, "in_progress", preset.id);
    await repository().deletePreset(preset.id);
    expect(await repository().columnAgents(PROJECT)).toEqual({});
  });
});

describe("the sentinels' agent", () => {
  async function assistantOn(input: Parameters<typeof savePreset>[0]) {
    const preset = await savePreset(input);
    await repository().setAssistantAgent(PROJECT, preset.id);
    return preset;
  }

  it("is the assistant's agent, without its chat prompt", async () => {
    await assistantOn({ ...worker, apiKey: "sk-ant-assistant" });
    // A column's agent is not borrowed any more.
    const other = await savePreset({ ...worker, name: "column-agent", apiKey: "sk-ant-column" });
    await repository().setColumnAgent(PROJECT, "in_review", other.id);

    const agent = await sentinelAgent(PROJECT);
    expect(agent).toEqual({
      kind: "configured",
      config: { provider: "anthropic", model: "claude-sonnet-5", apiKey: "sk-ant-assistant" },
    });
    expect(JSON.stringify(agent)).not.toContain(worker.prompt);
  });

  it("says so when signed in and the assistant has no agent, whatever the columns have", async () => {
    vi.stubEnv("GITHUB_APP_CLIENT_ID", "id");
    vi.stubEnv("GITHUB_APP_CLIENT_SECRET", "secret");
    const other = await savePreset({ ...worker, apiKey: "sk-ant-column" });
    await repository().setColumnAgent(PROJECT, "in_review", other.id);
    expect(await sentinelAgent(PROJECT)).toEqual({
      kind: "none",
      reason: "No agent is set for the assistant. Pick or create one above.",
    });
  });

  it("gives the assistant agent's usage-limit reason", async () => {
    const preset = await assistantOn({ ...worker, apiKey: "sk-ant-assistant" });
    await repository().setPresetLimit(preset.id, { until: new Date(Date.now() + 3_600_000), note: "limit" });
    const agent = await sentinelAgent(PROJECT);
    expect(agent).toMatchObject({ kind: "none", reason: expect.stringContaining("out of usage") });
  });

  it("refuses a CLI agent, which runs in GitHub Actions", async () => {
    await assistantOn({ name: "claude-code", provider: "claude-code", model: "", prompt: "", apiKey: "token" });
    const agent = await sentinelAgent(PROJECT);
    expect(agent).toMatchObject({ kind: "none", reason: expect.stringContaining("CLI agents run in GitHub Actions") });
  });

  it("runs the mock in local mode when the assistant has no agent", async () => {
    expect(await sentinelAgent(PROJECT)).toEqual({ kind: "mock" });
  });
});

describe("token allowance", () => {
  const DAY = 86_400_000;

  async function agentWithAllowance() {
    const preset = await savePreset(worker);
    await repository().setColumnAgent(PROJECT, "in_progress", preset.id);
    await repository().setPresetAllowance(preset.id, { tokens: 1_000_000, windowDays: 30 });
    return preset;
  }

  it("sums tokens in and out over the window", async () => {
    const preset = await agentWithAllowance();
    const spy = vi
      .spyOn(repository(), "agentTokensByPreset")
      .mockResolvedValue({ [preset.id]: { tokensIn: 600_000, tokensOut: 400_000 } });
    const now = Date.now();
    const found = await repository().presetForRun(preset.id);
    expect(await tokensUsedInWindow(found!.preset, now)).toBe(1_000_000);
    expect(spy).toHaveBeenCalledWith(new Date(now - 30 * DAY));
  });

  it("does not start a spent agent and marks it out of usage", async () => {
    const preset = await agentWithAllowance();
    vi.spyOn(repository(), "agentTokensByPreset").mockResolvedValue({
      [preset.id]: { tokensIn: 1_000_000, tokensOut: 0 },
    });
    expect(await columnLimit(PROJECT, "in_progress")).toMatch(/out of usage until/);
    expect((await repository().presetForRun(preset.id))?.preset.limitedUntil).not.toBeNull();
  });

  it("starts again once usage ages out of the window", async () => {
    const preset = await agentWithAllowance();
    const spy = vi.spyOn(repository(), "agentTokensByPreset").mockResolvedValue({
      [preset.id]: { tokensIn: 1_000_000, tokensOut: 0 },
    });
    expect(await columnLimit(PROJECT, "in_progress")).not.toBeNull();
    spy.mockResolvedValue({});
    expect(await columnLimit(PROJECT, "in_progress")).toBeNull();
    expect((await repository().presetForRun(preset.id))?.preset.limitedUntil).toBeNull();
  });
});
