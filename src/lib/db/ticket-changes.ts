import type { TicketStatus } from "@/lib/domain/status";
import { normalizeScope } from "@/lib/domain/scope";
import type { TicketChange, TicketUpdate } from "./repository";

/** The fields of a ticket whose change after it was specified is recorded. */
export interface SpecifiedFields {
  status: TicketStatus;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  fileScope: string[];
  storyPoints: number | null;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * What an update changes in a ticket that is past its specified state: one
 * points change, and one edit change naming the text fields that differ.
 * Identical values, and a draft that is still being written, give nothing.
 */
export function precisionChanges(
  before: SpecifiedFields,
  update: TicketUpdate,
): Array<Pick<TicketChange, "kind" | "detail">> {
  if (before.status === "draft") return [];
  const changes: Array<Pick<TicketChange, "kind" | "detail">> = [];
  if (update.storyPoints !== undefined && update.storyPoints !== before.storyPoints) {
    changes.push({ kind: "points", detail: { from: before.storyPoints, to: update.storyPoints } });
  }
  const fields: string[] = [];
  if (update.title !== undefined && update.title !== before.title) fields.push("title");
  if (update.description !== undefined && update.description !== before.description) fields.push("description");
  if (update.acceptanceCriteria !== undefined && !same(update.acceptanceCriteria, before.acceptanceCriteria)) {
    fields.push("acceptanceCriteria");
  }
  if (update.fileScope !== undefined && !same(normalizeScope(update.fileScope), before.fileScope)) {
    fields.push("fileScope");
  }
  if (fields.length > 0) changes.push({ kind: "edit", detail: { fields } });
  return changes;
}
