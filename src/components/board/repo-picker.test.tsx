import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { RepoPicker } from "./repo-picker";

function serve(repos: unknown[]) {
  vi.stubGlobal("fetch", async (url: string) =>
    Response.json(
      url.includes("/api/projects")
        ? { projects: [] }
        : { ok: true, repos, installUrl: "https://github.com/apps/formic-board/installations/new" },
    ),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("RepoPicker", () => {
  it("says the app is installed nowhere, rather than 'no match'", async () => {
    serve([]);
    render(<RepoPicker current={null} inline onClose={() => {}} />);
    expect(await screen.findByText(/isn't installed on any of your repositories/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Give Formic access/ })).toHaveAttribute(
      "href",
      "https://github.com/apps/formic-board/installations/new",
    );
  });
});
