"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/components/ui/cn";
import {
  AGENT_ROLE_LABELS,
  COLUMN_AGENT_ROLE,
  type AgentPreset,
} from "@/lib/domain/entities";
import { COLUMN_LABELS, type ColumnId } from "@/lib/domain/status";
import { modelLabel } from "@/lib/agents/models";

export interface ColumnAgentControls {
  presets: AgentPreset[];
  /** The preset this column runs, or undefined for the built-in agent. */
  selected: AgentPreset | undefined;
  onAssign: (presetId: string | null) => Promise<void>;
  /** Opens the editor: an existing preset, or null for a new one. */
  onEdit: (preset: AgentPreset | null) => void;
}

/**
 * Which agent works this column. Shows the current one; opens to the saved
 * presets, the built-in agent, and a way to make a new one.
 */
export function AgentSelect({
  column,
  presets,
  selected,
  onAssign,
  onEdit,
}: ColumnAgentControls & { column: ColumnId }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const role = `${AGENT_ROLE_LABELS[COLUMN_AGENT_ROLE[column]]} Agent`;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function pick(presetId: string | null) {
    setOpen(false);
    setError(null);
    try {
      await onAssign(presetId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not change the agent.");
    }
  }

  const item =
    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] hover:bg-cream outline-none focus-visible:bg-cream";

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Agent for ${COLUMN_LABELS[column]}: ${selected?.name ?? `built-in ${role}`}. Change`}
        className="border-line bg-card hover:border-clay flex h-11 w-full items-center gap-1.5 rounded-md border px-2 md:h-8 text-left text-[11px] transition-colors"
      >
        <AgentIcon />
        <span className="text-ink min-w-0 flex-1 truncate font-medium">
          {selected ? selected.name : role}
        </span>
        <span className="text-muted shrink-0 font-mono text-[10px]">
          {selected ? modelLabel(selected.model) : "Built-in"}
        </span>
        <Chevron />
      </button>

      {open && (
        <div
          role="menu"
          aria-label={`Agents for ${COLUMN_LABELS[column]}`}
          className="bg-card border-line shadow-lift absolute top-full right-0 left-0 z-30 mt-1 flex max-h-80 flex-col overflow-y-auto rounded-lg border p-1"
        >
          <button
            type="button"
            role="menuitemradio"
            aria-checked={!selected}
            className={item}
            onClick={() => void pick(null)}
          >
            <span className="min-w-0 flex-1">
              <span className="text-ink block truncate font-medium">{role}</span>
              <span className="text-muted block text-[10px]">Built-in</span>
            </span>
            {!selected && <Check />}
          </button>

          {presets.map((p) => (
            <div key={p.id} className="group flex items-center">
              <button
                type="button"
                role="menuitemradio"
                aria-checked={selected?.id === p.id}
                className={item}
                onClick={() => void pick(p.id)}
              >
                <span className="min-w-0 flex-1">
                  <span className="text-ink block truncate font-medium">{p.name}</span>
                  <span className="text-muted block font-mono text-[10px]">
                    {modelLabel(p.model)}
                    {p.hasKey ? ` · key ••${p.keyHint ?? ""}` : ""}
                  </span>
                </span>
                {selected?.id === p.id && <Check />}
              </button>
              <button
                type="button"
                aria-label={`Edit ${p.name}`}
                onClick={() => {
                  setOpen(false);
                  onEdit(p);
                }}
                className="text-muted hover:text-ink hover:bg-cream ml-0.5 inline-flex size-11 shrink-0 md:size-7 items-center justify-center rounded-md"
              >
                <Pencil />
              </button>
            </div>
          ))}

          <div aria-hidden className="bg-hairline my-1 h-px" />
          <button
            type="button"
            role="menuitem"
            className={cn(item, "text-terracotta font-semibold")}
            onClick={() => {
              setOpen(false);
              onEdit(null);
            }}
          >
            + New agent…
          </button>
        </div>
      )}

      {error && (
        <p role="alert" className="text-crimson-text mt-1 text-[11px]">
          {error}
        </p>
      )}
    </div>
  );
}

function AgentIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true" className="shrink-0">
      <rect x="2" y="3.5" width="8" height="6" rx="1.5" stroke="var(--color-muted)" strokeWidth="1.2" />
      <path d="M6 1.5v2M4.5 6.5h.01M7.5 6.5h.01" stroke="var(--color-muted)" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

function Chevron() {
  return (
    <svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true" className="shrink-0">
      <path d="M3 4.5 6 7.5 9 4.5" stroke="var(--color-muted)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Check() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true" className="shrink-0">
      <path d="M2.5 6.5 5 9l4.5-5.5" stroke="var(--color-jade)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Pencil() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M8 2.5 9.5 4 4.5 9H3V7.5L8 2.5Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}
