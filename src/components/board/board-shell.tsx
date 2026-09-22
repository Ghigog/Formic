"use client";

import { useState } from "react";
import { Board } from "./board";
import { NewItemDialog } from "./new-item-dialog";
import { EpicDrawer } from "./epic-drawer";
import {
  AmbientDrawer,
  type AmbientStats,
} from "@/components/ui/ambient-drawer";
import type { ExtrasMap } from "./card";
import type { BoardCard } from "@/lib/domain/entities";
import { useBoard } from "@/lib/hooks/use-board";

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
}: {
  initialCards: BoardCard[];
  /** Demo detail for the mock board: elapsed times, CI counts, commits. */
  initialExtras?: ExtrasMap;
  projectName: string;
  repoFullName: string;
  baseBranch: string;
  initialStats: AmbientStats;
}) {
  const { cards, extras, stats, prdStreams, connection, transition, createEpic } =
    useBoard(initialCards, initialStats);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [openEpicId, setOpenEpicId] = useState<string | null>(null);

  const stopAll = async () => {
    await fetch("/api/runs/stop", { method: "POST" });
  };

  // Live detail from the event stream wins over the seeded demo detail.
  const merged: ExtrasMap = { ...initialExtras };
  for (const [id, live] of Object.entries(extras)) {
    merged[id] = { ...merged[id], ...live };
  }

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <Board
        cards={cards}
        extras={merged}
        projectName={projectName}
        repoFullName={repoFullName}
        baseBranch={baseBranch}
        onOpenCard={(card) =>
          setOpenEpicId(card.kind === "epic" ? card.id : card.epicId)
        }
        onShowcase={(epic) => setOpenEpicId(epic.id)}
        onNewItem={() => setDialogOpen(true)}
        onCapture={createEpic}
        onTransition={transition}
      />

      <NewItemDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onSubmit={createEpic}
      />

      <EpicDrawer
        epicId={openEpicId}
        onClose={() => setOpenEpicId(null)}
        streamingPrd={openEpicId ? prdStreams[openEpicId] : undefined}
      />

      <AmbientDrawer stats={stats} onStopAll={() => void stopAll()} />

      {connection === "reconnecting" && (
        <div
          role="status"
          className="bg-rust/12 text-ink fixed bottom-16 left-4 z-40 rounded-md px-2 py-1 text-[11px]"
        >
          Reconnecting to the agent stream…
        </div>
      )}
    </div>
  );
}
