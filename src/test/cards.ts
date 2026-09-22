import type { BoardCard, CardKind } from "@/lib/domain/entities";
import type { TicketStatus } from "@/lib/domain/status";

/**
 * Board cards for tests.
 *
 * Deliberately not the demo fixtures: those exist to show every card anatomy
 * on a running board and will keep changing as the design does. A test that
 * asserts on them breaks for reasons that have nothing to do with the test.
 * Build the smallest board the assertion needs instead.
 */

let seq = 0;

export function makeCard(partial: Partial<BoardCard> = {}): BoardCard {
  seq += 1;
  const kind: CardKind = partial.kind ?? "ticket";
  return {
    id: `card-${seq}`,
    kind,
    key: kind === "epic" ? `EPIC-${seq}` : `PROT-${seq}`,
    title: `Card ${seq}`,
    status: "ready" as TicketStatus,
    stalledIn: null,
    stage: 1,
    position: seq * 1000,
    epicId: null,
    size: "M",
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
    ...partial,
  };
}

/** An epic plus the tickets it owns, already linked by `epicId`. */
export function makeEpicWithChildren(
  epic: Partial<BoardCard>,
  children: Array<Partial<BoardCard>>,
): BoardCard[] {
  const parent = makeCard({ kind: "epic", size: null, ...epic });
  const kids = children.map((c, i) =>
    makeCard({ epicId: parent.id, position: parent.position + 100 * (i + 1), ...c }),
  );
  return [
    { ...parent, childCount: kids.length, doneCount: kids.filter((k) => k.status === "merged").length },
    ...kids,
  ];
}
