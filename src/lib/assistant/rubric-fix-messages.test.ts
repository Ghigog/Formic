import { beforeEach, describe, expect, it, vi } from "vitest";

const { reviseRubricCheck, sentinelsFor } = vi.hoisted(() => ({
  reviseRubricCheck: vi.fn(async () => ({ ok: true as const })),
  sentinelsFor: vi.fn(),
}));

vi.mock("@/lib/events/bus", () => ({ publish: vi.fn(async () => 1) }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/sentinels/service", () => ({ reviseRubricCheck, sentinelsFor }));

import { repository } from "@/lib/db";
import { applyAction, dismissAction } from "./actions";
import { proposeRubricFixes } from "./rubric-fix-messages";

const PROJECT = "project_default";
const RUBRIC = {
  context: "c",
  rungs: [{ stars: 1, checks: [{ id: "5b", text: "Reads app/OverlayService.kt", how: "h", command: null, pass: "p" }] }],
};

async function flag() {
  return repository().addRubricFix({
    projectId: PROJECT,
    sentinel: "architect",
    checkId: "5b",
    problem: "Names the wrong file.",
    suggestion: "Use app/src/main/java/com/juice/overlay/OverlayService.kt",
    status: "flagged",
  });
}

const messages = async () => (await repository().assistantMessages(PROJECT)).messages;

beforeEach(() => {
  (globalThis as { __formicMemoryStore?: unknown }).__formicMemoryStore = undefined;
  vi.clearAllMocks();
  sentinelsFor.mockResolvedValue({ architect: { rubric: { rubric: RUBRIC } } });
});

describe("proposeRubricFixes", () => {
  it("posts one message naming the Sentinel, check, why, current and proposed text", async () => {
    const fix = await flag();
    await proposeRubricFixes(PROJECT, [fix.id]);
    const [m, ...rest] = await messages();
    expect(rest).toEqual([]);
    expect(m!.content).toContain("Collum");
    expect(m!.content).toContain("5b");
    expect(m!.content).toContain("Names the wrong file.");
    expect(m!.content).toContain("Reads app/OverlayService.kt");
    expect(m!.content).toContain("OverlayService.kt");
    expect(m!.proposals).toHaveLength(1);
    expect(m!.proposals[0]!.action).toMatchObject({ type: "revise_rubric_check", fix: fix.id });
    expect(await repository().rubricFix(fix.id)).toMatchObject({ status: "proposed", messageId: m!.id });
  });

  it("does not tell the same fix twice", async () => {
    const fix = await flag();
    await proposeRubricFixes(PROJECT, [fix.id]);
    await proposeRubricFixes(PROJECT, [fix.id]);
    expect(await messages()).toHaveLength(1);
  });
});

describe("revise_rubric_check", () => {
  it("approve records the approver and time, and starts the revise run", async () => {
    const fix = await flag();
    await proposeRubricFixes(PROJECT, [fix.id]);
    await applyAction(PROJECT, { type: "revise_rubric_check", fix: fix.id }, "user-9");
    const after = await repository().rubricFix(fix.id);
    expect(after).toMatchObject({ status: "approved", approvedBy: "user-9" });
    expect(after!.approvedAt).toBeInstanceOf(Date);
    expect(reviseRubricCheck).toHaveBeenCalledWith(PROJECT, fix.id);
  });

  it("is not applied twice", async () => {
    const fix = await flag();
    await applyAction(PROJECT, { type: "revise_rubric_check", fix: fix.id }, "user-9");
    await expect(
      applyAction(PROJECT, { type: "revise_rubric_check", fix: fix.id }, "user-9"),
    ).rejects.toThrow(/already decided/);
    expect(reviseRubricCheck).toHaveBeenCalledTimes(1);
  });

  it("refuses without an approver", async () => {
    const fix = await flag();
    await expect(applyAction(PROJECT, { type: "revise_rubric_check", fix: fix.id })).rejects.toThrow(/approval/);
    expect(reviseRubricCheck).not.toHaveBeenCalled();
  });

  it("decline marks it declined and starts nothing", async () => {
    const fix = await flag();
    await dismissAction(PROJECT, { type: "revise_rubric_check", fix: fix.id });
    expect(await repository().rubricFix(fix.id)).toMatchObject({ status: "declined", approvedBy: null });
    expect(reviseRubricCheck).not.toHaveBeenCalled();
  });

  it("a person's own request makes a fix from them and revises it", async () => {
    await applyAction(
      PROJECT,
      { type: "revise_rubric_check", sentinel: "Collum", check: "5b", note: "Use the real path" },
      "user-9",
    );
    const [fix] = await repository().rubricFixesFor(PROJECT, "architect");
    expect(fix).toMatchObject({ flaggedBy: null, status: "approved", approvedBy: "user-9", checkId: "5b" });
    expect(reviseRubricCheck).toHaveBeenCalledWith(PROJECT, fix!.id);
  });
});
