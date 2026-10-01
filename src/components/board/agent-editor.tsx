"use client";

import { useEffect, useRef, useState } from "react";
import {
  AGENT_ROLE_LABELS,
  COLUMN_AGENT_ROLE,
  type AgentPreset,
  type AgentPresetInput,
  type ColumnOverride,
} from "@/lib/domain/entities";
import { COLUMN_LABELS, type ColumnId } from "@/lib/domain/status";
import { DEFAULT_BRIEF } from "@/lib/agents/prompts";
import {
  PROVIDERS,
  type ProviderId,
  provider as providerInfo,
} from "@/lib/llm/providers";
import { reasoningNote, reasoningRoleFor, roleReasoning } from "@/lib/agents/reasoning";
import type { ModelInfo } from "@/lib/llm/openai-compat";
import { pricingNote } from "@/lib/budget/limits";
import { compact } from "@/components/ui/compact-number";
import type { AgentTokens, TokenWindowView } from "@/lib/hooks/use-agents";

/** What Formic always adds after a column's prompt, whatever the provider. */
const CONVENTIONS_NOTE: Partial<Record<ColumnId, string>> = {
  backlog:
    "Always added after this: user stories as “As a…, I'd like to…, so that…”, and the product's own vocabulary.",
  todo: "Always added after this: the ticket template (user story, context, description, requirements, Gherkin acceptance criteria) and the engineering practices (TDD, DDD, hexagonal, SOLID, applied where they fit).",
  in_progress:
    "Always added after this: the coding rules (stay in the file scope, no git, verify before finishing) and the engineering practices (TDD, DDD, hexagonal, SOLID, applied where they fit).",
  in_review:
    "Always added after this: the coding rules (stay in the file scope, no git, verify before finishing) and the engineering practices (TDD, DDD, hexagonal, SOLID, applied where they fit).",
};

/** Where the count starts, in words, with dates in the person's own timezone. */
function windowLabel({ kind, since, timezone }: TokenWindowView): string {
  if (kind === "all-time" || !since) return "over everything it has run";
  const date = new Date(since).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    ...(timezone ? { timeZone: timezone } : {}),
  });
  return kind === "reset" ? `since you reset it on ${date}` : `since ${date}`;
}

type LimitAxis = "minutes" | "tokens" | "attempts";

const OVERRIDE_AXES: Array<{ id: LimitAxis; label: string }> = [
  { id: "minutes", label: "Minutes" },
  { id: "tokens", label: "Tokens" },
  { id: "attempts", label: "Attempts" },
];

type ModelList =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "ready"; models: string[]; info: ModelInfo[] }
  | { state: "error"; reason: string };

/**
 * Create or edit a saved agent: a name, a provider, that provider's API key,
 * a model, and the prompt it works from. A new one starts from the built-in
 * prompt for the column it was opened from. The key belongs to this agent
 * alone; nothing else on the board uses it.
 *
 * The providers include CLI agents on a person's own plan (Claude Code,
 * Codex, Gemini CLI), which run in GitHub Actions for any column.
 */
export function AgentEditor({
  column,
  preset,
  usage,
  window: tokenWindow = { kind: "all-time", since: null, timezone: null },
  onResetWindow,
  override,
  onSaveOverride,
  onClose,
  onSave,
  onDelete,
}: {
  /** The column it was opened from, or the board's assistant. */
  column: ColumnId | "assistant";
  /** Null creates a new agent. */
  preset: AgentPreset | null;
  /** What this agent has used, in tokens, if it has been saved and run. */
  usage?: AgentTokens | undefined;
  /** What the count is measured over. */
  window?: TokenWindowView;
  /** Starts the count again from now; offered only when no renewal day is set. */
  onResetWindow?: () => Promise<void>;
  /** This column's own limits, if it has any. */
  override?: ColumnOverride | null;
  /** Stores the column's override; offered for a column agent only, called after the agent saves. */
  onSaveOverride?: (override: ColumnOverride) => Promise<void>;
  onClose: () => void;
  onSave: (input: Omit<AgentPresetInput, "column">) => Promise<void>;
  onDelete: (presetId: string) => Promise<void>;
}) {
  const forAssistant = column === "assistant";
  const role = forAssistant
    ? "Assistant"
    : `${AGENT_ROLE_LABELS[COLUMN_AGENT_ROLE[column]]} Agent`;
  // The assistant has no built-in brief: it answers whatever it is asked.
  const defaultPrompt = forAssistant ? "" : DEFAULT_BRIEF[column];
  const [name, setName] = useState(preset?.name ?? "");
  const [provider, setProvider] = useState<ProviderId>(
    preset?.provider ?? "anthropic",
  );
  const [model, setModel] = useState(preset?.model ?? "");
  const [prompt, setPrompt] = useState(preset?.prompt ?? defaultPrompt);
  /** Undefined keeps the saved key, null removes it, a string replaces it. */
  const [apiKey, setApiKey] = useState<string | null | undefined>(undefined);
  const [limits, setLimits] = useState<Record<LimitAxis, string>>({
    minutes: override?.minutes?.toString() ?? "",
    tokens: override?.tokens?.toString() ?? "",
    attempts: override?.attempts?.toString() ?? "",
  });
  const [fetched, setFetched] = useState<ModelList>({ state: "idle" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const info = providerInfo(provider)!;
  const cli = info.kind === "cli";
  // Only flat values, and only for an axis this column's path can enforce: a CLI agent
  // reports no tokens, so a token limit would never bind.
  const overrideAxes = OVERRIDE_AXES.filter((a) => a.id !== "tokens" || !cli);

  useEffect(() => {
    requestAnimationFrame(() => nameRef.current?.focus());
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // A saved key belongs to the provider it was saved for.
  const hasSavedKey = !!preset?.hasKey && preset.provider === provider;
  const savedKey = hasSavedKey && apiKey === undefined;
  const typedKey = typeof apiKey === "string" ? apiKey.trim() : "";

  // Ask the provider which models this key can use, once there is a key.
  const noKey = cli || (!typedKey && !savedKey);
  const models: ModelList = noKey ? { state: "idle" } : fetched;
  const advertised = models.state === "ready" ? models.info.find((m) => m.id === model.trim()) : undefined;
  const reasoningRole = forAssistant ? "chat" : reasoningRoleFor(COLUMN_AGENT_ROLE[column]);
  useEffect(() => {
    if (noKey) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setFetched({ state: "loading" });
      fetch("/api/providers/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          ...(typedKey ? { apiKey: typedKey } : { presetId: preset?.id }),
        }),
        signal: controller.signal,
      })
        .then((r) => r.json())
        .then(
          (d: {
            ok: boolean;
            models?: ModelInfo[];
            reason?: string;
          }) =>
            setFetched(
              d.ok
                ? {
                    state: "ready",
                    models: (d.models ?? []).map((m) => m.id),
                    info: d.models ?? [],
                  }
                : {
                    state: "error",
                    reason: d.reason ?? "Could not list models.",
                  },
            ),
        )
        .catch(() => {
          if (!controller.signal.aborted) {
            setFetched({ state: "error", reason: "Could not list models." });
          }
        });
    }, 400);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [provider, noKey, typedKey, preset?.id]);

  async function submit() {
    if (!hasSavedKey && !typedKey) {
      setError(`Add your ${info.keyName}. This agent runs on it.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSave({
        name,
        provider,
        model: model.trim(),
        prompt,
        // An empty box keeps a saved key; Remove clears it; a typed one replaces it.
        ...(apiKey === null
          ? { apiKey: null }
          : typedKey
            ? { apiKey: typedKey }
            : {}),
      });
      if (!forAssistant && onSaveOverride) {
        const count = (axis: LimitAxis) => (limits[axis].trim() === "" ? null : Number(limits[axis]));
        const next = {
          minutes: count("minutes"),
          tokens: cli ? null : count("tokens"),
          attempts: count("attempts"),
        };
        if (Object.values(next).some((n) => n !== null && !(Number.isInteger(n) && n >= 1))) {
          throw new Error("Limits are whole numbers of at least 1, or empty.");
        }
        await onSaveOverride(next);
      }
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the agent.");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!preset) return;
    if (
      !window.confirm(
        `Delete ${preset.name}? Columns running it go back to having no agent.`,
      )
    ) {
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
  const gatewayModels = models.state === "ready" ? models.models : [];
  const options = [
    ...info.suggestedModels,
    ...gatewayModels.filter((m) => !info.suggestedModels.includes(m)),
  ];

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
              : forAssistant
                ? "Answers questions in the top bar once saved."
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

          <label className="flex flex-col gap-1">
            <span className={label}>Provider</span>
            <select
              aria-label="Provider"
              value={provider}
              onChange={(e) => {
                setProvider(e.target.value as ProviderId);
                setModel("");
                setApiKey(undefined);
              }}
              className={`${field} h-9`}
            >
              {PROVIDERS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                  {p.freeTier ? " · free tier" : ""}
                </option>
              ))}
            </select>
            <span className="text-muted text-[11px]">{info.note}</span>
          </label>

          <div className="flex flex-col gap-1">
            <span className={label} id="agent-key-label">
              {cli ? info.keyName : `${info.label} ${info.keyName}`}
            </span>
            {savedKey ? (
              <div className="border-line bg-cream flex h-9 items-center gap-2 rounded-md border px-2.5 text-[13px]">
                <span className="text-ink flex-1 font-mono">
                  ••••••••{preset?.keyHint}
                </span>
                <button
                  type="button"
                  onClick={() => setApiKey("")}
                  className="text-terracotta text-[12px] font-semibold"
                >
                  Replace
                </button>
              </div>
            ) : (
              <input
                type="password"
                autoComplete="off"
                aria-labelledby="agent-key-label"
                value={apiKey ?? ""}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={info.keyPlaceholder}
                className={`${field} h-9 font-mono`}
              />
            )}
            {cli ? (
              <span className="text-muted text-[11px] leading-[1.5]">
                {info.howToGetKey} Stored encrypted, and saved as a secret in
                your repository&apos;s GitHub Actions when the agent runs.{" "}
                <a
                  href={info.keyUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-ink underline"
                >
                  How it works
                </a>
              </span>
            ) : (
              <span className="text-muted text-[11px]">
                Stored encrypted and never shown again.{" "}
                <a
                  href={info.keyUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-ink underline"
                >
                  Get a key from {info.label}
                </a>
              </span>
            )}
          </div>

          <label className="flex flex-col gap-1">
            <span className={label}>Model</span>
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              list="agent-models"
              placeholder={cli ? "Its default" : (options[0] ?? "Model id")}
              aria-label="Model"
              className={`${field} h-9 font-mono`}
            />
            <datalist id="agent-models">
              {options.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
            <span className="text-muted text-[11px]">
              {cli
                ? "Optional. Leave empty for the agent's own default."
                : models.state === "loading"
                  ? "Asking the provider which models your key can use…"
                  : models.state === "ready"
                    ? `${models.models.length} models available on your key. Start typing to filter.`
                    : models.state === "error"
                      ? models.reason
                      : "Add the key above to see the models it can use."}
            </span>
            {!cli && model.trim() && (
              <span className="text-muted text-[11px]">
                {pricingNote(model.trim(), provider)}
              </span>
            )}
            {provider === "deepseek" && reasoningRole && (
              <span className="text-muted text-[11px]" data-testid="reasoning-note">
                {reasoningNote(roleReasoning(reasoningRole, advertised))}
              </span>
            )}
          </label>

          {preset && (
            /*
             * What this agent has used, in tokens, over everything it ran and
             * answered. Tokens rather than money: a flat-rate plan bills none
             * of them, and the prices are a table this repo keeps by hand, so
             * a token count is the one number that means the same on every
             * provider (see docs/token-usage.md).
             */
            <p className="text-muted text-[11px]">
              {cli
                ? "Its provider reports no tokens."
                : `${compact((usage?.tokensIn ?? 0) + (usage?.tokensOut ?? 0))} tokens ${windowLabel(tokenWindow)}`}
              {!cli && tokenWindow.kind !== "renewal" && onResetWindow && (
                <>
                  {" "}
                  <button
                    type="button"
                    onClick={() => void onResetWindow().catch(() => setError("Could not reset the count."))}
                    className="text-terracotta font-semibold"
                  >
                    Reset
                  </button>
                </>
              )}
            </p>
          )}

          {!forAssistant && onSaveOverride && (
            <fieldset className="flex flex-col gap-1">
              <legend className={label}>Limit override</legend>
              <div className="flex gap-2">
                {overrideAxes.map(({ id, label: axis }) => (
                  <input
                    key={id}
                    type="number"
                    min={1}
                    step={1}
                    inputMode="numeric"
                    aria-label={`${axis} override`}
                    placeholder={axis}
                    value={limits[id]}
                    onChange={(e) => setLimits((l) => ({ ...l, [id]: e.target.value }))}
                    className={`${field} h-9 min-w-0 flex-1`}
                  />
                ))}
              </div>
              <span className="text-muted text-[11px]">
                One flat value per run for this column, used instead of the per point rule. Empty keeps the setting.
              </span>
            </fieldset>
          )}

          <label className="flex flex-col gap-1">
            <span className="flex items-center gap-2">
              <span className={label}>Prompt</span>
              <span className="flex-grow" />
              <button
                type="button"
                onClick={() => setPrompt(defaultPrompt)}
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
            {!forAssistant && CONVENTIONS_NOTE[column] && (
              <span className="text-muted text-[11px]">
                {CONVENTIONS_NOTE[column]}
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
