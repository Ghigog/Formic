import { expect, test } from "@playwright/test";
import {
  COLUMNS,
  card,
  cardIds,
  column,
  columnOf,
  dragCardTo,
  dragCardToBottom,
  dropzone,
  gotoBoard,
  idForKey,
  withCardReturned,
} from "./board";

/**
 * The board in a real browser, against a real server.
 *
 * What belongs here and nowhere else: anything that needs layout (drag), a
 * real network round trip, or the production build. Everything cheaper is a
 * component test — see docs/testing.md.
 */

test.beforeEach(async ({ page }) => {
  await gotoBoard(page);
});

test("renders the five columns and the ambient drawer", async ({ page }) => {
  for (const name of COLUMNS) {
    await expect(column(page, name)).toBeVisible();
  }
  await expect(page.getByText(/agents? active in|Colony idle/)).toBeVisible();
});

test("a drag moves the card and fires exactly one transition", async ({ page }) => {
  const [first] = await cardIds(page, "Backlog");
  expect(first, "the demo board should start with a card in Backlog").toBeTruthy();

  await withCardReturned(page, first!, async () => {
    const posts: Array<Record<string, unknown>> = [];
    page.on("request", (r) => {
      if (r.method() === "POST" && r.url().includes("/api/transitions")) {
        posts.push(JSON.parse(r.postData() ?? "{}"));
      }
    });

    await dragCardTo(page, first!, "To Do");

    // The transition is the app's only user-facing trigger. One move, one
    // event: every later ticket subscribes to this and nothing else.
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      cardId: first,
      from: "backlog",
      to: "todo",
      actor: "user",
    });
  });
});

test("a card dragged back to Backlog goes back", async ({ page }) => {
  const [first] = await cardIds(page, "Backlog");
  expect(first).toBeTruthy();

  await withCardReturned(page, first!, async () => {
    await dragCardTo(page, first!, "To Do");
    await dragCardTo(page, first!, "Backlog");
    expect(await columnOf(page, first!)).toBe("Backlog");
  });
});

/*
 * Not the first card in Done: that is the epic group's header, which is
 * deliberately not draggable — a merged epic has nowhere to go. The merged
 * tickets underneath it are the ones a user can pick up.
 *
 * A move the rules do not allow still lands, as the person asked: the card
 * shows where it was put, marked with what is wrong, and keeps its real
 * status until it is moved back.
 */
test("an illegal move lands with a warning, and the card keeps its status", async ({ page }) => {
  const done = await cardIds(page, "Done");
  const merged = done.at(-1);
  expect(merged, "the demo board should start with a merged ticket").toBeTruthy();

  await withCardReturned(page, merged!, async () => {
    await dragCardTo(page, merged!, "Backlog");

    // By text, not by role: Next renders its own empty role="alert" route
    // announcer on every page, so the role alone is ambiguous.
    await expect(page.getByText(/Cards cannot move from Done to Backlog\./)).toBeVisible();
    await expect(card(page, merged!).getByRole("img", { name: /^Needs you:/ })).toBeVisible();

    const board = await page.request.get("/api/board");
    const { cards } = (await board.json()) as {
      cards: Array<{ id: string; status: string; misplacedIn: string | null }>;
    };
    expect(cards.find((c) => c.id === merged)).toMatchObject({
      status: "merged",
      misplacedIn: "backlog",
    });
  });
});

test("the ambient drawer opens a terminal", async ({ page }) => {
  const toggle = page.getByRole("button", { name: "Terminal", exact: true });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
});

/*
 * Additive, and not undone: there is no delete. The store lives in the server
 * process, so a run that starts its own server (CI always does) starts clean.
 * Locally, `reuseExistingServer` means repeated runs accumulate captures.
 */
test("Backlog's New request captures a request", async ({ page }) => {
  const before = (await cardIds(page, "Backlog")).length;

  await column(page, "Backlog").getByRole("button", { name: "New request" }).click();
  await page.getByLabel("New feature request").fill("Rate-limit the merge queue");
  await page.getByRole("button", { name: "Draft PRD" }).click();

  await expect
    .poll(async () => (await cardIds(page, "Backlog")).length)
    .toBeGreaterThan(before);
  await expect(page.getByText("Rate-limit the merge queue")).toBeVisible();
});

test("a ticket dragged out of its epic stays out, in To Do", async ({ page }) => {
  const id = await idForKey(page, "PROT-07");
  const standalone = dropzone(page, "To Do").locator(
    `> li[data-rfd-draggable-id="${id}"]`,
  );
  await expect(standalone, "PROT-07 should start inside EPIC-03").toHaveCount(0);

  try {
    await dragCardToBottom(page, id, "To Do");
    await expect(standalone).toHaveCount(1);

    // Still there after a reload: the server kept it, not just the tab.
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(standalone).toHaveCount(1);
  } finally {
    await page.request.post("/api/transitions", {
      data: {
        cardId: id,
        kind: "ticket",
        from: "todo",
        to: "todo",
        position: 0,
        detached: false,
        actor: "user",
      },
    });
  }
});

test("picking another repository switches the board to it", async ({ page }) => {
  await page.getByRole("button", { name: /Choose another project/ }).first().click();
  const picker = page.getByRole("dialog", { name: "Choose a repository" });
  await expect(picker).toBeVisible();

  await picker.getByLabel("Search repositories").fill("acme/widgets");
  await picker.getByRole("button", { name: /Use\s*acme\/widgets/ }).click();

  // A new repository starts with an empty board of its own.
  await expect(page.getByRole("button", { name: /Choose another project/ }).first())
    .toContainText("acme / widgets");
  await expect(cardIds(page, "To Do")).resolves.toEqual([]);

  // And the demo board is still there to switch back to.
  await page.getByRole("button", { name: /Choose another project/ }).first().click();
  await expect(picker.getByText("Your boards")).toBeVisible();
  await page.screenshot({ path: "e2e/.results/repo-picker.png" });
  await picker.getByRole("button", { name: /Ghigog\/Formic/i }).click();
  await expect(page.getByRole("button", { name: /Choose another project/ }).first())
    .not.toContainText("acme");
});

test("a column runs a saved agent: create, pick, edit, remove", async ({ page }) => {
  const inProgress = column(page, "In Progress");
  const selector = inProgress.getByRole("button", { name: /Agent for In Progress:/ });
  await expect(selector).toContainText("Coder Agent");

  // New agent from the column's menu.
  await selector.click();
  await inProgress.getByRole("menuitem", { name: /New agent/ }).click();
  const editor = page.getByRole("dialog", { name: "New agent" });
  await expect(editor.getByRole("textbox").last()).toHaveValue(/implement one ticket/);
  await editor.getByPlaceholder("claude-worker").fill("claude-worker");
  await editor.getByRole("combobox", { name: "Provider", exact: true }).selectOption("anthropic");
  await editor.getByPlaceholder("sk-ant-…").fill("sk-ant-test-9876");
  await editor.getByRole("combobox", { name: "Model", exact: true }).fill("claude-sonnet-5");
  await editor.getByRole("button", { name: "Create agent" }).click();

  // It is now what In Progress runs, and it survives a reload.
  await expect(selector).toContainText("claude-worker");
  await expect(selector).toContainText("Sonnet 5");
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(selector).toContainText("claude-worker");
  await page.screenshot({ path: "e2e/.results/agent-select.png" });

  // Offered on other columns too, with its key hinted but never shown.
  await column(page, "In Review").getByRole("button", { name: /Agent for In Review:/ }).click();
  await expect(
    column(page, "In Review").getByRole("menuitemradio", { name: /claude-worker.*Anthropic/ }),
  ).toBeVisible();
  await page.keyboard.press("Escape");

  // Edit, then remove it and the column goes back to its built-in agent.
  await selector.click();
  await inProgress.getByRole("button", { name: "Edit claude-worker" }).click();
  const edit = page.getByRole("dialog", { name: "Edit claude-worker" });
  await expect(edit.getByText("••••••••9876")).toBeVisible();
  await page.screenshot({ path: "e2e/.results/agent-editor.png" });
  page.once("dialog", (d) => void d.accept());
  await edit.getByRole("button", { name: "Delete" }).click();
  await expect(selector).toContainText("Coder Agent");
});

test("settings keeps a key without ever showing it back", async ({ page }) => {
  await page.getByRole("button", { name: /^Account:/ }).first().click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  // No event stream on this page, so idle means hydrated: typing before
  // then is overwritten when React takes over the input.
  await page.waitForLoadState("networkidle");

  await page.getByLabel("Sandbox (E2B) API key").fill("e2b_test_abcd");
  await page.getByRole("button", { name: "Save" }).first().click();
  await expect(page.getByText("••••••••abcd")).toBeVisible();

  await page.reload();
  await expect(page.getByText("••••••••abcd")).toBeVisible();
  expect(await page.content()).not.toContain("e2b_test_abcd");
  await page.screenshot({ path: "e2e/.results/settings.png" });

  await page.getByRole("button", { name: "Remove" }).first().click();
  await expect(page.getByLabel("Sandbox (E2B) API key")).toBeVisible();
});

test("the assistant pulls down from the top bar and rolls back up", async ({ page }) => {
  const shade = page.locator("section[aria-label=Assistant]");
  await expect(shade).toHaveAttribute("data-open", "false");

  await page.getByRole("button", { name: "Pull the assistant down" }).click();
  await expect(shade).toHaveAttribute("data-open", "true");
  await expect(shade.getByText(/Ask anything about/)).toBeVisible();
  await expect(shade.getByLabel("The assistant's agent")).toBeVisible();

  await shade.getByRole("button", { name: "Roll the assistant up" }).click();
  await expect(shade).toHaveAttribute("data-open", "false");
  await expect(shade).toBeHidden();
});

test("a dropped card stays where it was dropped while the server answers", async ({ page }) => {
  const [first] = await cardIds(page, "Backlog");
  expect(first, "the demo board should start with a card in Backlog").toBeTruthy();

  await withCardReturned(page, first!, async () => {
    // Hold the answer back, so the gap between drop and reply is visible.
    await page.route("**/api/transitions", async (r) => {
      await new Promise((res) => setTimeout(res, 1200));
      await r.continue().catch(() => undefined);
    });
    const drag = dragCardTo(page, first!, "To Do");
    await page.waitForRequest("**/api/transitions");
    for (let i = 0; i < 4; i++) {
      expect(await columnOf(page, first!)).toBe("To Do");
      await page.waitForTimeout(200);
    }
    await drag;
    await page.unrouteAll({ behavior: "wait" });
  });
});

/*
 * The board holds an SSE connection open for its whole life, and any other
 * card's status changing — an agent finishing a step, CI reporting in —
 * refetches the entire board and re-renders every column. @hello-pangea/dnd
 * cannot survive its subtree re-rendering mid-gesture: at best it drops the
 * gesture outright (no destination, no transition sent); at worst, if the
 * update actually moves the card being dragged, its rendered node vanishes
 * while the library still has it pinned to the pointer. In Review is the
 * column this hits hardest, since that is where CI and agent activity land
 * most often while a person might be looking at the board.
 */
test("an unrelated card's status change mid-drag does not disturb the drag", async ({ page }) => {
  const [dragged] = await cardIds(page, "In Review");
  expect(dragged, "the demo board should start with a card in In Review").toBeTruthy();

  const board = await page.request.get("/api/board");
  const { cards } = (await board.json()) as {
    cards: Array<{ id: string; kind: string; status: string }>;
  };
  const victim = cards.find((c) => c.status === "running");
  expect(victim, "the demo board should start with a running card").toBeTruthy();

  await withCardReturned(page, dragged!, async () => {
    const posts: Array<Record<string, unknown>> = [];
    page.on("request", (r) => {
      if (r.method() === "POST" && r.url().includes("/api/transitions")) {
        posts.push(JSON.parse(r.postData() ?? "{}"));
      }
    });

    const source = card(page, dragged!);
    const target = dropzone(page, "To Do");
    const from = (await source.boundingBox())!;
    const into = (await target.boundingBox())!;
    const startX = from.x + from.width / 2;
    const startY = from.y + Math.min(20, from.height / 2);
    const endX = into.x + into.width / 2;
    const endY = into.y + 40;

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    for (let i = 1; i <= 15; i++) {
      await page.mouse.move(
        startX + ((endX - startX) * i) / 15,
        startY + ((endY - startY) * i) / 15,
      );
      if (i === 7) {
        // Mid-gesture: an unrelated card's own status "changes" (a same-column
        // nudge is enough to publish `card.status`), simulating an agent or CI
        // event landing on the board while the person is still dragging.
        const res = await page.request.post("/api/transitions", {
          data: {
            cardId: victim!.id,
            kind: victim!.kind,
            from: "in_progress",
            to: "in_progress",
            position: 999_999,
            actor: "agent",
          },
        });
        expect(res.ok()).toBe(true);
      }
      // The dragged card must stay exactly one visible, on-screen node
      // throughout — never zero (unmounted out from under the gesture) and
      // never more than one (a stale copy left behind).
      const dragging = card(page, dragged!);
      await expect(dragging).toHaveCount(1);
      await expect(dragging).toBeVisible();
    }
    await page.mouse.up();

    await expect.poll(() => columnOf(page, dragged!)).toBe("To Do");
    // The concurrent event must not have cost the gesture: exactly one
    // transition for the card the user actually dragged.
    expect(posts.filter((p) => p.cardId === dragged)).toHaveLength(1);
  });
});

test("a ticket opens its own view, not its Epic's", async ({ page }) => {
  const [first] = await cardIds(page, "In Progress");
  expect(first, "the demo board should have a ticket in progress").toBeTruthy();

  await page.locator(`[data-rfd-draggable-id="${first}"]`).click();

  const dialog = page.getByRole("dialog", { name: "Ticket detail" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("list", { name: "Ticket progress" })).toBeVisible();
  await expect(dialog.getByText("Plan", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Thought process")).toBeVisible();
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toBeHidden();
});
