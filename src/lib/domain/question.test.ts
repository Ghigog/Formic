import { describe, expect, it } from "vitest";
import { classifyNotice } from "./notice";
import { answerNote, isQuestion, MAX_QUESTIONS, questionReason } from "./question";

describe("a question for the person", () => {
  const one = { question: "Should the bell hang from a string?", why: "It sets how it rings." };

  it("is its own notice, neither a failure nor an alert", () => {
    const reason = questionReason("The Product Agent", [one]);
    expect(isQuestion(reason)).toBe(true);
    expect(classifyNotice({ status: "blocked", stalledIn: "backlog", blockedReason: reason })).toMatchObject({
      severity: "question",
      title: "Question for you",
      shortDescription: "Should the bell hang from a string?",
    });
  });

  it("says who is waiting and how to answer", () => {
    expect(questionReason("The Coder Agent", [one])).toContain("The Coder Agent is waiting for your answer. Reply in this card's chat");
  });

  it("numbers several and keeps no more than the cap", () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ question: `Q${i + 1}?`, why: "" }));
    const reason = questionReason("The Product Agent", many);
    expect(reason).toContain(`${MAX_QUESTIONS}. Q${MAX_QUESTIONS}?`);
    expect(reason).not.toContain(`Q${MAX_QUESTIONS + 1}?`);
  });

  it("puts the answer beside the question for the agent that asked", () => {
    const note = answerNote(questionReason("The Product Agent", [one]), "Yes, a string.");
    expect(note).toBe("You asked the person:\nShould the bell hang from a string?\n   Why: It sets how it rings.\n\nThey answered: Yes, a string.");
  });

  it("does not mistake an ordinary stop for a question", () => {
    expect(isQuestion("Tests failed")).toBe(false);
    expect(isQuestion(null)).toBe(false);
  });
});
