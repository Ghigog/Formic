import { expect, test } from "@playwright/test";
import {
  COLUMNS,
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
 */
test("an illegal move is refused, and the card stays put", async ({ page }) => {
  const done = await cardIds(page, "Done");
  const merged = done.at(-1);
  expect(merged, "the demo board should start with a merged ticket").toBeTruthy();

  const before = await columnOf(page, merged!);
  await dragCardTo(page, merged!, "Backlog", 2_000).catch(() => {
    // Expected: the board refuses the move, so the card never arrives.
  });

  // By text, not by role: Next renders its own empty role="alert" route
  // announcer on every page, so the role alone is ambiguous.
  await expect(
    page.getByText("Cards cannot move from Done to Backlog."),
  ).toBeVisible();
  expect(await columnOf(page, merged!)).toBe(before);
});

test("the ambient drawer opens a terminal", async ({ page }) => {
  const toggle = page.getByRole("button", { name: "Terminal" });
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
test("the Backlog composer captures a request", async ({ page }) => {
  const before = (await cardIds(page, "Backlog")).length;

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
  await expect(picker.getByText("On this board")).toBeVisible();
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
  await editor.getByRole("combobox").nth(1).selectOption("claude-sonnet-5");
  await editor.getByPlaceholder("sk-ant-…").fill("sk-ant-test-9876");
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
    column(page, "In Review").getByRole("menuitemradio", { name: /claude-worker.*9876/ }),
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
