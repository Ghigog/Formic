import { describe, expect, it } from "vitest";
import { checkDecomposition, gherkin, toDraftTicket, type TicketSpec } from "./decomposition";
import {
  ALREADY_DONE_RULE,
  ENGINEERING_PRACTICES,
  VERIFY_RULE,
  withCodingRules,
  withPlanningConventions,
  withProductConventions,
} from "./prompts";
import { taskBrief } from "./coder";
import { withEpicNotes } from "./epic-notes";

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
  storyPoints: 3,
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

  it("carries the story points onto the ticket, and refuses points off the scale", () => {
    expect(toDraftTicket(spec).storyPoints).toBe(3);
    const checked = checkDecomposition({
      tickets: [{ ...spec, storyPoints: 4 }, { ...spec, key: "T-2", dependsOn: ["T-1"] }],
    });
    expect(checked.ok).toBe(false);
    expect(!checked.ok && checked.correction).toContain("storyPoints");
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

describe("verifying", () => {
  it("runs each check once, whatever the coding agent's prompt", () => {
    expect(withCodingRules("Custom coder.")).toContain(VERIFY_RULE);
    expect(VERIFY_RULE).toContain("Run each check once");
  });

  it("stops at the report when the work is already done", () => {
    expect(ALREADY_DONE_RULE).toContain("Then stop.");
    expect(ALREADY_DONE_RULE).toContain("mention it in your report and change nothing");
  });
});

describe("sizing plans to the request", () => {
  it("tells every Product Agent, custom brief or not, to keep a small PRD small", () => {
    const prompt = withProductConventions("A custom brief.");
    expect(prompt).toContain("size the PRD to the request");
    expect(prompt).toContain("Do not restate the request");
  });

  it("tells every Architect Agent to use as few tickets as the change allows", () => {
    expect(withPlanningConventions("A custom brief.")).toContain("a small change is one ticket");
  });

  it("accepts a breakdown into a single ticket", () => {
    expect(checkDecomposition({ tickets: [spec] }).ok).toBe(true);
  });
});

describe("work for a person", () => {
  it("is marked on the ticket when the Architect says so, and only then", () => {
    expect(toDraftTicket({ ...spec, needsHuman: " Run it on production " }).needsHuman).toBe("Run it on production");
    expect(toDraftTicket(spec)).not.toHaveProperty("needsHuman");
    expect(toDraftTicket({ ...spec, needsHuman: "  " })).not.toHaveProperty("needsHuman");
  });

  it("is something every Architect Agent is told to mark, whatever its prompt", () => {
    expect(withPlanningConventions("Custom brief.")).toContain("needsHuman");
  });
});

describe("a run asked for from the ticket's chat", () => {
  const task = {
    ticketId: "t1",
    key: "T-1",
    title: "Export",
    description: "A CSV download.",
    acceptanceCriteria: ["It downloads"],
    fileScope: ["src/app"],
  };

  it("leads with what the person asked, and keeps the ticket as background", () => {
    const brief = taskBrief({ ...task, instruction: "Only rename the button." });
    expect(brief.indexOf("Only rename the button.")).toBeLessThan(brief.indexOf("Ticket T-1"));
    expect(brief).toContain("Do not start the ticket over");
  });

  it("is the ticket alone when nobody asked for anything", () => {
    expect(taskBrief(task).startsWith("Ticket T-1: Export")).toBe(true);
  });
});

describe("the Product Agent writing a PRD again", () => {
  it("reads what the person said about it since", () => {
    expect(withEpicNotes("Export as CSV.", [])).toBe("Export as CSV.");
    const rewritten = withEpicNotes("Export as CSV.", ["Also JSON."]);
    expect(rewritten).toContain("Export as CSV.");
    expect(rewritten).toContain("- Also JSON.");
  });
});
