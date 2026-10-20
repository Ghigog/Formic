import { describe, expect, it } from "vitest";
import { ticketSpecSchema, toDraftTicket } from "./decomposition";

const base = {
  key: "T-1",
  title: "Fix the export",
  userStory: { as: "a board owner", want: "export my board", soThat: "I can report on it" },
  requirements: [],
  acceptanceCriteria: [{ given: "a board", when: "I export it", then: "it downloads" }],
  fileScope: ["src/app/api/export"],
  storyPoints: 2,
  dependsOn: [],
};

describe("a ticket's type and severity", () => {
  it("rejects a ticket with no type", () => {
    expect(ticketSpecSchema.safeParse(base).success).toBe(false);
  });

  it("rejects a bug without a severity", () => {
    expect(ticketSpecSchema.safeParse({ ...base, type: "bug" }).success).toBe(false);
  });

  it("rejects a severity on any type but bug", () => {
    expect(ticketSpecSchema.safeParse({ ...base, type: "task", severity: "low" }).success).toBe(false);
  });

  it("carries a bug's severity onto the draft, and a plain type alone", () => {
    const bug = toDraftTicket(ticketSpecSchema.parse({ ...base, type: "bug", severity: "critical" }));
    expect(bug).toMatchObject({ workType: "bug", bugSeverity: "critical" });
    const spike = toDraftTicket(ticketSpecSchema.parse({ ...base, type: "spike" }));
    expect(spike).toMatchObject({ workType: "spike" });
    expect(spike).not.toHaveProperty("bugSeverity");
  });
});
