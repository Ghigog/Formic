import { afterEach, describe, expect, it, vi } from "vitest";
import { boardPorts, clearBoardPorts, registerBoardPorts, type BoardPorts } from "./ports";
import "./wiring";

const fakes = (): BoardPorts => ({
  coder: { runCoderAgent: vi.fn(async () => {}) },
  review: {
    reviewPullRequest: vi.fn(async () => {}),
    completeEpic: vi.fn(async () => {}),
    startShowcase: vi.fn(async () => {}),
    mergeByPerson: vi.fn(async () => "merged"),
  },
  service: {
    applyTransition: vi.fn(),
    redraftTicket: vi.fn(),
    retryEpic: vi.fn(),
    deleteEpic: vi.fn(),
    createBacklogItem: vi.fn(),
    advanceQueens: vi.fn(),
  },
});

afterEach(() => {
  // Put the real wiring back for other tests in this file.
  vi.resetModules();
});

describe("board ports", () => {
  it("fails loudly when used before registration", () => {
    clearBoardPorts();
    expect(() => boardPorts()).toThrow(/not registered/);
  });

  it("returns what was registered", () => {
    const f = fakes();
    registerBoardPorts(f);
    expect(boardPorts()).toBe(f);
  });
});
