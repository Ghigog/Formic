import { beforeEach, describe, expect, it, vi } from "vitest";

const redirected: string[] = [];
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    redirected.push(url);
    throw new Error(`redirect:${url}`);
  },
}));
vi.mock("@/components/calls/call-chat", () => ({ CallChat: () => null }));
vi.mock("@/lib/auth/user", () => ({ currentUser: async () => ({ id: "u" }) }));
vi.mock("@/lib/board/project", () => ({ activeProject: async () => ({ id: "p" }) }));
const level = vi.fn();
vi.mock("@/lib/colony/game", async (orig) => ({
  ...(await orig<typeof import("@/lib/colony/game")>()),
  scoreOf: () => ({ level: level() }),
}));
vi.mock("@/lib/db", () => ({ repository: () => ({ boardCards: async () => [] }) }));

import CallPage from "./page";

const open = () => CallPage({ params: Promise.resolve({ meetingId: "m-1" }) });

beforeEach(() => void (redirected.length = 0));

describe("call page", () => {
  it("sends the person back to the board below Lv 15", async () => {
    level.mockReturnValue(14);
    await expect(open()).rejects.toThrow("redirect:/");
  });

  it("opens the call from Lv 15", async () => {
    level.mockReturnValue(15);
    await expect(open()).resolves.toBeTruthy();
    expect(redirected).toEqual([]);
  });
});
