"use client";

import { useCallback, useState } from "react";
import type { AgentPreset, AgentPresetInput, ColumnAgents } from "@/lib/domain/entities";
import type { ColumnId } from "@/lib/domain/status";

async function send<T>(url: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(data?.error ?? "That did not save. Try again.");
  }
  return (res.status === 204 ? null : await res.json()) as T;
}

/** What one agent has used, in tokens, over its runs and the answers it gave. */
export interface AgentTokens {
  tokensIn: number;
  tokensOut: number;
}

export type AgentUsage = Record<string, AgentTokens | undefined>;

/** Saved agent presets and which column runs which, for the active board. */
export function useAgents(
  initialPresets: AgentPreset[],
  initialColumns: ColumnAgents,
  initialUsage: AgentUsage = {},
) {
  const [presets, setPresets] = useState(initialPresets);
  const [columns, setColumns] = useState(initialColumns);
  const [usage, setUsage] = useState(initialUsage);

  /**
   * Asks again what each agent has used. A run or an answer anyone started
   * since this page loaded has moved the numbers, and a person opening an
   * agent's settings is the moment it matters.
   */
  const refreshUsage = useCallback(async () => {
    const next = await send<{ usage?: AgentUsage }>("/api/agents", "GET").catch(() => null);
    if (next?.usage) setUsage(next.usage);
  }, []);

  const assign = useCallback(async (column: ColumnId, presetId: string | null) => {
    const { columns } = await send<{ columns: ColumnAgents }>(
      `/api/agents/columns/${column}`,
      "PUT",
      { presetId },
    );
    setColumns(columns);
  }, []);

  /**
   * Creates or updates a preset. A new one is scoped to `column` and put on
   * it straight away; `column` is never sent on an update, which keeps
   * whatever column the preset already had.
   */
  const save = useCallback(
    async (input: Omit<AgentPresetInput, "column">, options: { id?: string; column?: ColumnId }) => {
      const { preset } = options.id
        ? await send<{ preset: AgentPreset }>(`/api/agents/presets/${options.id}`, "PATCH", input)
        : await send<{ preset: AgentPreset }>("/api/agents/presets", "POST", {
            ...input,
            column: options.column ?? null,
          });
      setPresets((prev) =>
        prev.some((p) => p.id === preset.id)
          ? prev.map((p) => (p.id === preset.id ? preset : p))
          : [...prev, preset],
      );
      if (!options.id && options.column) await assign(options.column, preset.id);
      return preset;
    },
    [assign],
  );

  const remove = useCallback(async (presetId: string) => {
    await send(`/api/agents/presets/${presetId}`, "DELETE");
    setPresets((prev) => prev.filter((p) => p.id !== presetId));
    setColumns((prev) =>
      Object.fromEntries(Object.entries(prev).filter(([, id]) => id !== presetId)),
    );
  }, []);

  /** An agent ran out of usage on its plan, or got it back. */
  const markLimited = useCallback((presetId: string, until: string | null, note: string | null) => {
    setPresets((prev) =>
      prev.map((p) => (p.id === presetId ? { ...p, limitedUntil: until, limitNote: note } : p)),
    );
  }, []);

  return { presets, columns, usage, assign, save, remove, markLimited, refreshUsage };
}
