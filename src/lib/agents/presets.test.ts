import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentConfigFor, agentFor, savePreset } from "./presets";
import { LoopCoderAgent } from "./coder";
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
