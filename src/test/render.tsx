import { DragDropContext } from "@hello-pangea/dnd";
import { render, type RenderResult } from "@testing-library/react";

/**
 * A `Droppable` throws outside a `DragDropContext`, so a column rendered on
 * its own needs one. The context is inert here: jsdom has no layout, so no
 * drag can start, and the handler exists only to satisfy the type.
 *
 * Drag behaviour itself is end-to-end territory. See e2e/board.spec.ts.
 */
export function renderInDnd(ui: React.ReactNode): RenderResult {
  return render(<DragDropContext onDragEnd={() => {}}>{ui}</DragDropContext>);
}
