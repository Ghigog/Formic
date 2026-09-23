"use client";

import { useEffect, useRef, useState } from "react";
import {
  AGENT_ROLE_LABELS,
  COLUMN_AGENT_ROLE,
  type AgentPreset,
  type AgentPresetInput,
} from "@/lib/domain/entities";
import { COLUMN_LABELS, type ColumnId } from "@/lib/domain/status";
import { AGENT_MODELS } from "@/lib/agents/models";
import { DEFAULT_BRIEF } from "@/lib/agents/prompts";

/** Columns whose agent writes code, and so always gets the platform rules. */
const CODING_COLUMNS: ReadonlySet<ColumnId> = new Set(["in_progress", "in_review"]);

/**
 * Create or edit a saved agent: a name, a Claude model, an optional API key
 * of its own, and the prompt it works from. A new one starts from the
 * built-in prompt for the column it was opened from.
 */
export function AgentEditor({
  column,
  preset,
  onClose,
  onSave,
  onDelete,
}: {
  column: ColumnId;
  /** Null creates a new agent. */
  preset: AgentPreset | null;
  onClose: () => void;
  onSave: (input: AgentPresetInput) => Promise<void>;
  onDelete: (presetId: string) => Promise<void>;
}) {
  const role = `${AGENT_ROLE_LABELS[COLUMN_AGENT_ROLE[column]]} Agent`;
  const [name, setName] = useState(preset?.name ?? "");
  const [model, setModel] = useState(preset?.model ?? AGENT_MODELS[0]!.id);
  const [prompt, setPrompt] = useState(preset?.prompt ?? DEFAULT_BRIEF[column]);
  /** Undefined keeps the saved key, null removes it, a string replaces it. */
  const [apiKey, setApiKey] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    requestAnimationFrame(() => nameRef.current?.focus());
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const savedKey = preset?.hasKey && apiKey === undefined;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await onSave({
        name,
        model,
        prompt,
        // An empty box changes nothing; only Remove clears a saved key.
        ...(apiKey === null
          ? { apiKey: null }
          : apiKey?.trim()
            ? { apiKey: apiKey.trim() }
            : {}),
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the agent.");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!preset) return;
    if (!window.confirm(`Delete ${preset.name}? Columns running it go back to their built-in agent.`)) {
      return;
    }
    setBusy(true);
    try {
      await onDelete(preset.id);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not delete the agent.");
      setBusy(false);
    }
  }

  const label = "text-ink text-[12px] font-semibold";
  const field =
    "border-line bg-cream text-ink focus:border-clay w-full rounded-md border px-2.5 text-[13px] outline-none";

  return (
    <div
      role="dialog"
      aria-modal
      aria-label={preset ? `Edit ${preset.name}` : "New agent"}
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center sm:p-4"
      onClick={onClose}
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="bg-card border-line flex max-h-[92dvh] w-full max-w-xl flex-col overflow-hidden rounded-t-xl border sm:rounded-xl"
      >
        <div className="border-hairline border-b px-4 pt-4 pb-3">
          <h2 className="font-serif text-[18px] font-semibold">
            {preset ? "Edit agent" : "New agent"}
          </h2>
          <p className="text-muted mt-0.5 text-[12px]">
            {preset
              ? "Changes apply to every column running this agent, from its next run."
              : `Runs as the ${role} in ${COLUMN_LABELS[column]} once saved.`}
          </p>
        </div>

        <div className="flex flex-col gap-3.5 overflow-y-auto px-4 py-3.5">
          <label className="flex flex-col gap-1">
            <span className={label}>Name</span>
            <input
              ref={nameRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="claude-worker"
              maxLength={60}
              className={`${field} h-9`}
            />
          </label>

          <div className="grid gap-3.5 sm:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className={label}>Provider</span>
              <select disabled className={`${field} h-9 opacity-80`} value="anthropic">
                <option value="anthropic">Claude (Anthropic)</option>
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className={label}>Model</span>
              <select
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className={`${field} h-9`}
              >
                {AGENT_MODELS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label} · {m.note}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="flex flex-col gap-1">
            <span className={label} id="agent-key-label">
              API key
            </span>
            {savedKey ? (
              <div className="border-line bg-cream flex h-9 items-center gap-2 rounded-md border px-2.5 text-[13px]">
                <span className="text-ink flex-1 font-mono">••••••••{preset?.keyHint}</span>
                <button
                  type="button"
                  onClick={() => setApiKey("")}
                  className="text-terracotta text-[12px] font-semibold"
                >
                  Replace
                </button>
                <button
                  type="button"
                  onClick={() => setApiKey(null)}
                  className="text-muted hover:text-ink text-[12px] font-medium"
                >
                  Remove
                </button>
              </div>
            ) : (
              <input
                type="password"
                autoComplete="off"
                aria-labelledby="agent-key-label"
                value={apiKey ?? ""}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-ant-…"
                className={`${field} h-9 font-mono`}
              />
            )}
            <span className="text-muted text-[11px]">
              {apiKey === null
                ? "The saved key will be removed. Runs will use your key from Settings."
                : "Stored encrypted and never shown again. Leave empty to use your key from Settings."}
            </span>
          </div>

          <label className="flex flex-col gap-1">
            <span className="flex items-center gap-2">
              <span className={label}>Prompt</span>
              <span className="flex-grow" />
              <button
                type="button"
                onClick={() => setPrompt(DEFAULT_BRIEF[column])}
                className="text-muted hover:text-ink text-[11px] font-medium"
              >
                Reset to built-in
              </button>
            </span>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={10}
              className={`${field} resize-y py-2 font-mono text-[12px] leading-[1.5]`}
            />
            {CODING_COLUMNS.has(column) && (
              <span className="text-muted text-[11px]">
                The platform&apos;s coding rules (stay in the file scope, no git, verify
                before finishing) are always added after this.
              </span>
            )}
          </label>

          {error && (
            <p role="alert" className="text-crimson-text text-[12px]">
              {error}
            </p>
          )}
        </div>

        <div className="border-hairline flex items-center gap-2 border-t px-4 py-3">
          {preset && (
            <button
              type="button"
              onClick={() => void remove()}
              disabled={busy}
              className="text-crimson-text text-[12px] font-semibold disabled:opacity-50"
            >
              Delete
            </button>
          )}
          <span className="flex-grow" />
          <button
            type="button"
            onClick={onClose}
            className="text-muted hover:text-ink px-2 py-1 text-[12px] font-medium"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy}
            className="bg-terracotta-cta inline-flex h-9 items-center rounded-lg px-3.5 text-[13px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {busy ? "Saving…" : preset ? "Save" : "Create agent"}
          </button>
        </div>
      </form>
    </div>
  );
}
