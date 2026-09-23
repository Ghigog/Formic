import { describe, expect, it } from "vitest";
import { checkDecomposition, gherkin, toDraftTicket, type TicketSpec } from "./decomposition";
import {
  ENGINEERING_PRACTICES,
  withCodingRules,
  withPlanningConventions,
  withProductConventions,
} from "./prompts";

/** The ticket template and the practices every agent works to. */

const spec: TicketSpec = {
  key: "T-1",
  title: "Export the board",
  userStory: { as: "board owner", want: "export my board as CSV", soThat: "I can report on it." },
  context: "People track work in spreadsheets too.",
  description: "A CSV download of every card.",
  requirements: ["An endpoint that streams CSV", "A test per column"],
  acceptanceCriteria: [
    { given: "Given a board with two cards", when: "I export it", then: "Then the CSV has two rows." },
  ],
  fileScope: ["src/app/api/export/"],
  size: "S",
  dependsOn: [],
};

describe("the ticket template", () => {
  it("renders the story, why, what and how as the ticket's description", () => {
    const t = toDraftTicket(spec);
    expect(t.description).toBe(
      [
        "**User story:** As a board owner, I'd like to export my board as CSV, so that I can report on it.",
        "",
        "### Context",
        "People track work in spreadsheets too.",
        "",
        "### Description",
        "A CSV download of every card.",
        "",
        "### Requirements",
        "- An endpoint that streams CSV",
        "- A test per column",
      ].join("\n"),
    );
    expect(t.fileScope).toEqual(["src/app/api/export"]);
  });

  it("stores acceptance criteria as one Gherkin line each, without doubled keywords", () => {
    expect(toDraftTicket(spec).acceptanceCriteria).toEqual([
      "Given a board with two cards, when I export it, then the CSV has two rows.",
    ]);
    expect(gherkin({ given: "x", when: "y", then: "z" })).toBe("Given x, when y, then z.");
  });

  it("sends a ticket without the template back to the Architect", () => {
    const { userStory: _, ...noStory } = spec;
    const checked = checkDecomposition({ tickets: [noStory, { ...spec, key: "T-2", dependsOn: ["T-1"] }] });
    expect(checked.ok).toBe(false);
    expect(!checked.ok && checked.correction).toContain("userStory");
  });
});

describe("the engineering practices", () => {
  it("reach the coding agents and the Architect, whatever their prompt", () => {
    for (const prompt of [withCodingRules("Custom coder."), withPlanningConventions("Custom architect.")]) {
      expect(prompt).toContain(ENGINEERING_PRACTICES);
      expect(prompt).toContain("TDD");
    }
    expect(withPlanningConventions("x")).toContain("Gherkin");
  });

  it("are defaults with judgment, and the repository's conventions win", () => {
    expect(ENGINEERING_PRACTICES).toContain("Defaults, not dogma");
    expect(ENGINEERING_PRACTICES).toContain("win where they differ");
  });

  it("give the Product Agent the user story form", () => {
    expect(withProductConventions("x")).toContain("As a <role>, I'd like to <capability>, so that <benefit>.");
  });
});
