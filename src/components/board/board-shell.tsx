"use client";

import { useCallback, useMemo, useState } from "react";
import { Board } from "./board";
import type { CardExtras } from "./card";
import { AmbientDrawer, type AmbientStats } from "@/components/ui/ambient-drawer";
import type { BoardCard } from "@/lib/domain/entities";
import type { CardTransition, TransitionResult } from "@/lib/domain/transitions";
import { statusForUserDrop } from "@/lib/domain/status";

/**
 * Client shell around the board: owns card state, the ambient bar, and the
 * transition call. PROT-02 replaces the in-memory reducer with API calls and
 * PROT-10 replaces the static stats with a live subscription; the Board
 * component itself does not change.
 */
export function BoardShell({
  initialCards,
  extras,
  projectName,
  repoFullName,
  baseBranch,
  stats,
}: {
  initialCards: BoardCard[];
  extras?: Record<string, CardExtras | undefined>;
  projectName: string;
  repoFullName: string;
  baseBranch: string;
  stats: AmbientStats;
}) {
  const [cards, setCards] = useState(initialCards);

  const dependenciesMet = useCallback(
    (card: BoardCard) => {
      if (card.dependsOn.length === 0) return true;
      const done = new Set(
        cards.filter((c) => c.status === "merged").map((c) => c.id),
      );
      return card.dependsOn.every((id) => done.has(id));
    },
    [cards],
  );

  const onTransition = useCallback(
    async (t: CardTransition): Promise<TransitionResult> => {
      const card = cards.find((c) => c.id === t.cardId);
      if (!card) {
        return { ok: false, reason: "Card no longer exists.", revertTo: t.from };
      }

      if (t.to === "in_progress" && !dependenciesMet(card)) {
        return {
          ok: false,
          reason: `${card.key} is waiting on a dependency that has not merged yet.`,
          revertTo: t.from,
        };
      }

      const status = statusForUserDrop(t.to, dependenciesMet(card));
      setCards((prev) =>
        prev.map((c) =>
          c.id === t.cardId
            ? { ...c, status, stalledIn: null, position: t.position }
            : c,
        ),
      );
      return { ok: true, status, runId: null };
    },
    [cards, dependenciesMet],
  );

  const onNewItem = useCallback(() => {
    const n = cards.filter((c) => c.kind === "epic").length + 1;
    const epic: BoardCard = {
      id: `epic-new-${n}`,
      kind: "epic",
      key: `EPIC-${n}`,
      title: "New backlog item",
      status: "draft",
      stalledIn: null,
      stage: 1,
      position: Date.now(),
      epicId: null,
      size: null,
      agentRole: null,
      model: null,
      fileScope: [],
      dependsOn: [],
      prNumber: null,
      prUrl: null,
      blockedReason: null,
      costCents: 0,
      childCount: 0,
      doneCount: 0,
    };
    setCards((prev) => [...prev, epic]);
  }, [cards]);

  const liveStats = useMemo<AmbientStats>(() => {
    const active = cards.filter((c) => c.status === "running").length;
    return { ...stats, activeSandboxes: active };
  }, [cards, stats]);

  return (
    <>
      <Board
        cards={cards}
        extras={extras}
        projectName={projectName}
        repoFullName={repoFullName}
        baseBranch={baseBranch}
        onOpenCard={() => {}}
        onNewItem={onNewItem}
        onTransition={onTransition}
      />
      <AmbientDrawer stats={liveStats} />
    </>
  );
}
