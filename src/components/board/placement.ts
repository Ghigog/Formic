import type { BoardCard } from "@/lib/domain/entities";
import type { ColumnId } from "@/lib/domain/status";
import { POSITION_STEP, positionBetween } from "@/lib/ordering";

/**
 * How a column is laid out, and where a drop in it lands.
 *
 * The board renders some columns grouped: an epic absorbs the tickets it owns
 * in that column into an accordion. So the order on screen is not the order
 * of `position`, and a drag library index cannot be fed straight into
 * `positionForIndex`. This module is the one place that knows both orders,
 * which is why the column renders from it and the board places drops with it.
 * No React, so it is tested in node.
 */

/**
 * To Do shows the DAG and Done shows the merged set, so in both an epic
 * absorbs the tickets it owns in that column. Elsewhere a ticket stands on
 * its own, which is what the artboard shows for a card mid-flight.
 */
export const GROUPS_CHILDREN: Record<ColumnId, boolean> = {
  backlog: false,
  todo: true,
  in_progress: false,
  in_review: false,
  done: true,
};

export type RenderItem =
  | { kind: "card"; card: BoardCard }
  | { kind: "group"; epic: BoardCard; children: BoardCard[] };

/**
 * Column order with each epic's own tickets folded in behind it. A ticket the
 * user pulled out of its epic (`detached`) stands on its own.
 */
export function layout(cards: BoardCard[], column: ColumnId): RenderItem[] {
  if (!GROUPS_CHILDREN[column]) {
    return cards.map((card) => ({ kind: "card" as const, card }));
  }

  const epicIds = new Set(
    cards.filter((c) => c.kind === "epic").map((c) => c.id),
  );
  const adopted = new Set(
    cards
      .filter(
        (c) =>
          c.kind !== "epic" && !c.detached && c.epicId && epicIds.has(c.epicId),
      )
      .map((c) => c.id),
  );

  const items: RenderItem[] = [];
  for (const card of cards) {
    if (adopted.has(card.id)) continue;
    if (card.kind === "epic") {
      items.push({
        kind: "group",
        epic: card,
        children: cards.filter((c) => adopted.has(c.id) && c.epicId === card.id),
      });
    } else {
      items.push({ kind: "card", card });
    }
  }
  return items;
}

/** One draggable on screen, in the order the drag library indexes them. */
export interface FlatEntry {
  card: BoardCard;
  /** The epic whose accordion this row sits in, for a child row. */
  groupOf: string | null;
}

/**
 * Every draggable the column renders, top to bottom. A collapsed epic
 * contributes only its header; an expanded one its header and a row per child.
 */
export function flatten(
  items: RenderItem[],
  collapsed: ReadonlySet<string>,
): FlatEntry[] {
  const out: FlatEntry[] = [];
  for (const item of items) {
    if (item.kind === "card") {
      out.push({ card: item.card, groupOf: null });
      continue;
    }
    out.push({ card: item.epic, groupOf: null });
    if (collapsed.has(item.epic.id)) continue;
    for (const child of item.children) {
      out.push({ card: child, groupOf: item.epic.id });
    }
  }
  return out;
}

export interface Placement {
  position: number;
  /** Tickets only: true when it was dropped outside its own epic's group. */
  detached: boolean;
}

/**
 * Where `card` lands when dropped at `index` among `destination`'s cards.
 *
 * `index` is the drag library's: an index into the destination's rendered
 * draggables with the moving card already taken out. The result is a
 * position whose place in the column's sort order puts the card exactly
 * where it was dropped, grouped or not.
 */
export function placeDrop({
  card,
  destination,
  column,
  collapsed,
  index,
}: {
  card: BoardCard;
  /** The destination column's cards, sorted by position. */
  destination: BoardCard[];
  column: ColumnId;
  collapsed: ReadonlySet<string>;
  index: number;
}): Placement {
  const others = destination.filter((c) => c.id !== card.id);
  // The layout with the card as it will be, so an epic still owns its group
  // and the dragged ticket is not counted in anyone's children.
  const flat = flatten(layout(others, column), collapsed);
  const at = Math.max(0, Math.min(index, flat.length));

  const sorted = others.map((c) => c.position);
  const after = (p: number) => positionBetween(p, sorted.find((q) => q > p) ?? null);
  const before = (p: number) =>
    positionBetween([...sorted].reverse().find((q) => q < p) ?? null, p);

  const above = flat[at - 1] ?? null;
  const below = flat[at] ?? null;

  // Inside its own epic's open accordion: ordered among its siblings. That
  // is only where the gap opens inside the accordion on screen, which is
  // above a sibling. Below the last one the gap opens under the whole group,
  // so a drop there pulls the ticket out. An epic with no tickets left in the
  // group takes one dropped straight under its header.
  const ownGroup =
    card.kind === "ticket" && card.epicId && GROUPS_CHILDREN[column]
      ? card.epicId
      : null;
  const open = ownGroup !== null && !collapsed.has(ownGroup);
  const emptyGroup = !flat.some((e) => e.groupOf === ownGroup);

  if (open && below?.groupOf === ownGroup) {
    return { position: before(below.card.position), detached: false };
  }
  if (open && emptyGroup && above?.card.id === ownGroup) {
    return { position: after(above.card.position), detached: false };
  }

  // Top level. Rows inside an accordion are not top-level anchors: the card
  // lands after the whole group it was dropped inside.
  const topAbove = above ? (above.groupOf ?? above.card.id) : null;
  let belowAt = at;
  while (belowAt < flat.length && flat[belowAt]!.groupOf !== null) belowAt++;
  const topBelow = flat[belowAt]?.card ?? null;

  const anchorAbove = topAbove ? others.find((c) => c.id === topAbove) : null;
  const position = anchorAbove
    ? after(anchorAbove.position)
    : topBelow
      ? before(topBelow.position)
      : sorted.length
        ? after(sorted[sorted.length - 1]!)
        : POSITION_STEP;

  // Detached only means something where its epic would otherwise absorb it.
  // Anywhere else the flag is cleared, so a ticket an agent later carries
  // into Done joins its epic's merged group there.
  const detached =
    card.kind === "ticket" &&
    GROUPS_CHILDREN[column] &&
    others.some((c) => c.id === card.epicId);
  return { position, detached };
}
