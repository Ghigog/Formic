{
  "title": "Keep columns scrollable when epic accordions are expanded",
  "prd": {
    "summary": "Make every board column scroll its own contents so that expanding an epic's accordion (the To Do DAG or the Done merged group) never shrinks, hides or blocks the cards and epics above or below it. Expanding and collapsing an epic should make the accordion take exactly the space its child tickets need, and push the rest of the column down instead of squashing it.",
    "problem": "In the To Do column an expanded epic accordion squashes the other cards and epic groups around it, so they become hard or impossible to see or open. In the code, the card list in each column is a flex column that can scroll (`overflow-y-auto`), but its items can still shrink. The epic group's `<li>` has `overflow-hidden`, so it can shrink below the height of its content. When a column gets more content than it has height for, the flex layout shrinks the epic groups instead of letting the list overflow and scroll. Epic headers and child rows get clipped, and the column never becomes scrollable. Every epic starts expanded (the board's `collapsed` sets start empty), so a To Do column with a few decomposed epics reaches this state right away. Done's merged groups use the same `EpicGroup` and have the same problem.",
    "scope": [
      "Epic groups (`EpicGroup`) and standalone cards (`KanbanCard`) in a column's card list keep their natural height and never shrink to fit the column.",
      "Each column's card list scrolls vertically on its own when its content is taller than the column. The column header, agent selector, limit banner and Backlog composer stay in place above it.",
      "Expanding an epic's accordion grows the group to the full height of its child tickets and pushes later items down. Collapsing it shrinks the group back to the epic header. Both happen in the same scrolling list.",
      "The fix applies to every column that renders epic groups (To Do DAG accordion and Done merged group) and to the mobile single-column (`bare`) view.",
      "After an epic is expanded or collapsed, the other cards and epics in the column can still be reached by scrolling and opened with a click.",
      "Dragging cards and child tickets (`@hello-pangea/dnd`) keeps working inside a scrolled column, including dropping onto a column that is scrolled away from its top.",
      "Regression coverage: an e2e (Playwright) check that a To Do column with several expanded epics taller than the viewport scrolls, and that every epic header in it keeps its full height and can be opened."
    ],
    "outOfScope": [
      "Changing the default collapse state (epics start expanded) or saving collapse state across reloads.",
      "Expanding or collapsing all epics at once, or any other new collapse control.",
      "A capped height or inner scroll area inside a single epic accordion. The column scrolls, not the accordion.",
      "Animating the accordion open and closed.",
      "Scrolling the whole board horizontally, or resizing and reordering columns.",
      "Changes to the epic drawer or ticket drawer that open when an epic or ticket is clicked.",
      "Changes to what an epic group shows (child row content, the pheromone trail design, DAG summary)."
    ],
    "technicalContext": [
      "Column layout lives in `src/components/board/column.tsx`. The card list is the `Droppable` `<ul>` with `flex flex-1 flex-col overflow-y-auto min-h-16`, inside a `<section>` with `flex min-h-0 flex-1 flex-col`.",
      "`EpicGroup` in `src/components/board/card.tsx` renders `<li className=\"bg-card border-line rounded-lg border flex flex-col overflow-hidden\">`. Because of `overflow-hidden`, its automatic minimum height is 0, so it can shrink as a flex child. The likely fix is to make list items `shrink-0` (or equivalent) and not rely on content-based minimum height. `KanbanCard`'s `<li>` should get the same treatment for consistency.",
      "Child rows in the To Do accordion (`ChildRow`) are a fixed 60px tall so that the `ColumnTrail` SVG (`src/components/ui/pheromone-trail.tsx`), which is absolutely positioned and sized from `ROW`/`GAP`, lines up. Squashing the group breaks that alignment, and the fix must keep it.",
      "Collapse state is owned by `Board` (`src/components/board/board.tsx`) as `Record<ColumnId, Set<string>>` and passed to `Column`. Drag indices are allotted per rendered item, so collapse state affects drop placement (`placement.ts`).",
      "The page shell (`board-shell.tsx`) is `h-dvh flex-col overflow-hidden` and `<main>` is `flex min-h-0 flex-1`, so each column is bounded by the viewport. Scrolling has to happen inside the column list, not on the page.",
      "`@hello-pangea/dnd` supports one scroll container per Droppable. The `<ul>` is already the Droppable, so it should also be the scroll container, with no nested scroll parents. Mobile uses an Advance button instead of drag.",
      "Existing tests: `column.test.tsx` and `board.test.tsx` (Vitest, jsdom; no layout, so height checks belong in Playwright), `e2e/board.spec.ts` and `e2e/mobile.spec.ts`."
    ],
    "userStories": [
      "As a person watching the board, I'd like to scroll each column on its own, so that I can reach every card and epic in a column no matter how many there are.",
      "As a person reviewing decomposition in To Do, I'd like to expand an epic's accordion without the epics around it being squashed, so that I can still see and open them.",
      "As a person managing the board, I'd like expanding and collapsing an epic to only change that epic's height, so that the rest of the column stays readable and reachable.",
      "As a person on a small screen, I'd like the single visible column to scroll with expanded epics in it, so that I can reach every card on mobile too."
    ],
    "successCriteria": [
      "Given a To Do column whose expanded epics are taller than the viewport, when I scroll inside that column, then I can reach the last epic and its last child ticket.",
      "Given a To Do column with several expanded epics, when I look at any epic group, then its header (EPIC badge, key, title and DAG summary) and all of its child rows are fully visible, not clipped.",
      "Given an expanded epic in the middle of a column, when I scroll to the epics above and below it and click their titles, then each one opens.",
      "Given a collapsed epic, when I expand it, then its child tickets appear at full height and the items after it move down, without any other item in the column shrinking.",
      "Given an expanded epic, when I collapse it, then the group shrinks to its header and the items after it move up.",
      "Given one column is scrolled, when I look at the other columns, then their scroll positions have not changed and their headers are still visible.",
      "Given a column's list is scrolled down, when I look at the column, then its header, agent selector and (in Backlog) the New request button are still visible above the list.",
      "Given a scrolled To Do column, when I drag a ready child ticket into In Progress, then it lands in In Progress as it would from an unscrolled column.",
      "Given the Done column holds merged groups taller than the viewport, when I scroll it, then every merged group and its View showcase button can be reached and clicked.",
      "Given a viewport under 768px on the To Do tab with expanded epics taller than the screen, when I scroll, then every epic can be reached and the page still does not scroll sideways."
    ]
  }
}
