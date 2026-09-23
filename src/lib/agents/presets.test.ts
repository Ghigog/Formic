import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentConfigFor, agentFor, savePreset } from "./presets";
import { AnthropicCoderAgent } from "./coder";
import { MockCoderAgent } from "./mock";
import { resetAgents } from "./registry";
import { repository } from "@/lib/db";

const PROJECT = "project_default";

beforeEach(() => {
  globalThis.__formicMemoryStore = undefined;
  resetAgents();
  vi.stubEnv("AGENT_PROVIDER", "mock");
  vi.stubEnv("FORMIC_SECRET", "test");
});

const worker = {
  name: "claude-worker",
  model: "claude-sonnet-5",
  prompt: "Implement the ticket. Keep it small.",
};

describe("agent presets", () => {
  it("runs a column's preset, with its model, prompt and key", async () => {
    const preset = await savePreset({ ...worker, apiKey: "sk-ant-worker-1234" });
    await repository().setColumnAgent(PROJECT, "in_progress", preset.id);

    expect(preset).toMatchObject({ hasKey: true, keyHint: "1234" });
    expect(JSON.stringify(preset)).not.toContain("sk-ant");

    expect(await agentConfigFor(PROJECT, "in_progress")).toEqual({
      model: "claude-sonnet-5",
      brief: worker.prompt,
      apiKey: "sk-ant-worker-1234",
    });
    expect(await agentFor(PROJECT, "coder")).toBeInstanceOf(AnthropicCoderAgent);
  });

  it("leaves every other column on its built-in agent", async () => {
    const preset = await savePreset(worker);
    await repository().setColumnAgent(PROJECT, "in_progress", preset.id);

    expect(await agentConfigFor(PROJECT, "todo")).toBeNull();
    expect(await agentFor(PROJECT, "reviewer")).not.toBeInstanceOf(AnthropicCoderAgent);
  });

  it("falls back to the server key when the preset has none", async () => {
    const preset = await savePreset(worker);
    await repository().setColumnAgent(PROJECT, "in_progress", preset.id);
    expect((await agentConfigFor(PROJECT, "in_progress"))?.apiKey).toBeNull();
  });

  it("keeps a saved key through an edit that does not mention it", async () => {
    const preset = await savePreset({ ...worker, apiKey: "sk-ant-worker-1234" });
    const edited = await savePreset({ ...worker, id: preset.id, name: "renamed" });
    expect(edited).toMatchObject({ name: "renamed", hasKey: true, keyHint: "1234" });

    const cleared = await savePreset({ ...worker, id: preset.id, apiKey: null });
    expect(cleared).toMatchObject({ hasKey: false, keyHint: null });
  });

  it("unassigns a deleted preset, so the column goes back to its default", async () => {
    const preset = await savePreset(worker);
    await repository().setColumnAgent(PROJECT, "in_progress", preset.id);
    await repository().deletePreset(preset.id);

    expect(await repository().columnAgents(PROJECT)).toEqual({});
    expect(await agentFor(PROJECT, "coder")).toBeInstanceOf(MockCoderAgent);
  });
});
