"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { Board } from "./board";
import { NewItemDialog, type CaptureColumn } from "./new-item-dialog";
import { EpicDrawer } from "./epic-drawer";
import { TicketDrawer, type SubscribeToEvents } from "./ticket-drawer";
import type { FormicEvent } from "@/lib/domain/events";
import {
  AmbientDrawer,
  type AmbientStats,
} from "@/components/ui/ambient-drawer";
import type { ExtrasMap } from "./card";
import type { BoardCard } from "@/lib/domain/entities";
import { useBoard } from "@/lib/hooks/use-board";
import { useAgents, type AgentUsage } from "@/lib/hooks/use-agents";
import { useAssistant } from "@/lib/hooks/use-assistant";
import { AgentEditor } from "./agent-editor";
import { SetupDialog, type KeylessAgent } from "./setup-dialog";
import { useRunnerSetup } from "@/lib/hooks/use-runner-setup";
import { provider } from "@/lib/llm/providers";
import type { AgentPreset, ColumnAgents } from "@/lib/domain/entities";
import type { ColumnId } from "@/lib/domain/status";
import type { Account } from "./account-menu";
import { ColonyProvider, useColony } from "@/components/colony/colony";
import { ColonyTimeline } from "@/components/colony/timeline";
import { SentinelsPage } from "@/components/sentinels/sentinels";
import { SentinelsProvider } from "@/components/sentinels/store";
import type { SentinelStates } from "@/lib/sentinels/view";
import { ColonyPopover, NestButton } from "@/components/colony/nest";
import { ColonyToast, EpicWinDialog, RerouteToast, type RerouteNotice } from "@/components/colony/overlays";

/**
 * Client shell: owns the live board state, the capture dialog and the ambient
 * bar. Everything it renders is driven by the server plus the event stream.
 *
 * The shell is a fixed-height flex column — header, board, ambient drawer —
 * so the columns scroll inside their wells rather than the page scrolling
 * under a floating bar.
 */
export function BoardShell({
  initialCards,
  initialExtras = {},
  projectName,
  repoFullName,
  baseBranch,
  initialStats,
  initialPresets = [],
  initialColumnAgents = {},
  initialAgentUsage = {},
  initialSentinels = {},
  account,
}: {
  initialCards: BoardCard[];
  /** Demo detail for the mock board: elapsed times, CI counts, commits. */
  initialExtras?: ExtrasMap;
  projectName: string;
  repoFullName: string;
  baseBranch: string;
  initialStats: AmbientStats;
  initialPresets?: AgentPreset[];
  initialColumnAgents?: ColumnAgents;
  /** What each saved agent has used, in tokens, as of this render. */
  initialAgentUsage?: AgentUsage;
  /** Each sentinel's last report on this project. */
  initialSentinels?: SentinelStates;
  account?: Account;
}) {
  const agentState = useAgents(initialPresets, initialColumnAgents, initialAgentUsage);
  // Views that follow the event stream themselves, such as an open ticket.
  const listeners = useRef(new Set<(event: FormicEvent, seq: number) => void>());
  const subscribe = useCallback<SubscribeToEvents>((listener) => {
    listeners.current.add(listener);
    return () => listeners.current.delete(listener);
  }, []);
  const [rerouteToast, setRerouteToast] = useState<RerouteNotice | null>(null);
  const rerouteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { cards: boardCards, extras, stats, prdStreams, connection, transition, createEpic, createTicket, refetch } =
    useBoard(initialCards, initialStats, (event, seq) => {
      if (event.type === "agent.limited") agentState.markLimited(event.presetId, event.until, event.note);
      if (event.type === "card.rerouted") {
        if (rerouteTimer.current) clearTimeout(rerouteTimer.current);
        setRerouteToast({ key: seq, to: event.to, reason: event.reason });
        rerouteTimer.current = setTimeout(() => setRerouteToast(null), 3200);
      }
      for (const listener of listeners.current) listener(event, seq);
    });
  // Tickets archived from this board. The server leaves them out of the next
  // fetch; this hides them in the meantime.
  const [archivedIds, setArchivedIds] = useState<Set<string>>(new Set());
  const cards = useMemo(
    () => boardCards.filter((c) => !c.archived && !archivedIds.has(c.id)),
    [boardCards, archivedIds],
  );
  const runner = useRunnerSetup(subscribe);
  const [dialog, setDialog] = useState<{ column: CaptureColumn } | null>(null);
  const [openEpicId, setOpenEpicId] = useState<string | null>(null);
  const [openTicketId, setOpenTicketId] = useState<string | null>(null);
  /** The agent editor: which column it was opened from, and what it edits. */
  const [editing, setEditing] = useState<{
    column: ColumnId | "assistant";
    preset: AgentPreset | null;
  } | null>(null);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [assistantUsed, setAssistantUsed] = useState(false);
  const assistant = useAssistant(assistantUsed);
  const openAssistant = (open: boolean) => {
    if (open) setAssistantUsed(true);
    setAssistantOpen(open);
  };

  const stopAll = async () => {
    await fetch("/api/runs/stop", { method: "POST" });
  };

  // Live detail from the event stream wins over the seeded demo detail.
  const merged: ExtrasMap = { ...initialExtras };
  for (const [id, live] of Object.entries(extras)) {
    merged[id] = { ...merged[id], ...live };
  }

  const repoName = repoFullName.split("/")[1] ?? repoFullName;

  // CLI agents on a column that have no key yet: the other half of setup.
  const keyless: KeylessAgent[] = [];
  for (const [column, presetId] of Object.entries(agentState.columns) as Array<[ColumnId, string]>) {
    const preset = agentState.presets.find((p) => p.id === presetId);
    const info = preset && provider(preset.provider);
    if (!preset || preset.hasKey || info?.kind !== "cli") continue;
    if (keyless.some((k) => k.name === preset.name)) continue;
    keyless.push({ name: preset.name, keyName: info.keyName, onAdd: () => setEditing({ column, preset }) });
  }

  return (
    <ColonyProvider storageKey={`formic:colony:${repoFullName}`} cards={cards} extras={merged}>
    <SentinelsProvider initial={initialSentinels}>
    <div className="flex h-dvh flex-col overflow-hidden">
      <Board
        cards={cards}
        extras={merged}
        projectName={projectName}
        repoFullName={repoFullName}
        baseBranch={baseBranch}
        onOpenCard={(card) =>
          card.kind === "epic" ? setOpenEpicId(card.id) : setOpenTicketId(card.id)
        }
        onShowcase={(epic) => setOpenEpicId(epic.id)}
        onNewItem={(column) => setDialog({ column })}
        onTransition={transition}
        onArchived={(id) => setArchivedIds((prev) => new Set(prev).add(id))}
        account={account}
        assistant={{
          ...assistant,
          open: assistantOpen,
          setOpen: openAssistant,
          presets: agentState.presets,
          onNewAgent: () => setEditing({ column: "assistant", preset: null }),
          onEditAgent: (preset) => {
            setEditing({ column: "assistant", preset });
            void agentState.refreshUsage();
          },
        }}
        agents={{
          presets: agentState.presets,
          columns: agentState.columns,
          onAssign: agentState.assign,
          onEdit: (column, preset) => {
            setEditing({ column, preset });
            // Opening an agent asks what it has used since this page loaded.
            if (preset) void agentState.refreshUsage();
          },
        }}
      />

      {editing && (
        <AgentEditor
          column={editing.column}
          preset={editing.preset}
          usage={editing.preset ? agentState.usage[editing.preset.id] : undefined}
          onClose={() => setEditing(null)}
          onSave={async (input) => {
            const { column } = editing;
            const preset = await agentState.save(input, {
              id: editing.preset?.id,
              column: column === "assistant" ? undefined : column,
            });
            if (column === "assistant" && !editing.preset) await assistant.setAgent(preset.id);
          }}
          onDelete={agentState.remove}
        />
      )}

      <NewItemDialog
        open={dialog !== null}
        column={dialog?.column ?? "backlog"}
        onClose={() => setDialog(null)}
        onSubmit={(rawRequest, requestId, workType) =>
          dialog?.column === "todo"
            ? createTicket(rawRequest, requestId, workType)
            : createEpic(rawRequest, requestId, workType)
        }
      />

      <EpicDrawer
        epicId={openEpicId}
        onClose={() => setOpenEpicId(null)}
        onOpenTicket={(ticketId) => {
          setOpenEpicId(null);
          setOpenTicketId(ticketId);
        }}
        streamingPrd={openEpicId ? prdStreams[openEpicId] : undefined}
      />

      <TicketDrawer
        ticketId={openTicketId}
        onClose={() => setOpenTicketId(null)}
        onOpenEpic={(epicId) => {
          setOpenTicketId(null);
          setOpenEpicId(epicId);
        }}
        subscribe={subscribe}
        onChanged={() => void refetch()}
      />

      <SetupDialog
        setup={runner.setup}
        repoName={repoName}
        keyless={keyless}
        onRetry={() => void runner.check()}
      />

      <ColonyAmbient stats={stats} onStopAll={() => void stopAll()} />
      <ColonyTimeline repoName={repoName} />
      <SentinelsPage repoName={repoName} />
      <ColonyPopover />
      <ColonyToast />
      <RerouteToast toast={rerouteToast} />
      <EpicWinDialog onShowcase={(epic) => setOpenEpicId(epic.id)} />

      {connection === "reconnecting" && (
        <div
          role="status"
          className="bg-rust/12 text-ink fixed bottom-16 left-4 z-50 rounded-md px-2 py-1 text-[11px]"
        >
          Reconnecting to the agent stream…
        </div>
      )}
    </div>
    </SentinelsProvider>
    </ColonyProvider>
  );
}

/** The ambient bar, with the colony's bug count and its nest. */
function ColonyAmbient(props: {
  stats: AmbientStats;
  onStopAll: () => void;
}) {
  const colony = useColony();
  return (
    <AmbientDrawer
      {...props}
      bugsSquashed={colony?.score.squashed}
      nest={<NestButton />}
    />
  );
}
