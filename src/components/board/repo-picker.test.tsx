import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

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

  it("starts a board without a repository", async () => {
    const calls: unknown[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        calls.push(JSON.parse(String(init.body)));
        return Response.json({ project: { id: "p1" } });
      }
      return Response.json(url.includes("/api/projects") ? { projects: [] } : { ok: true, repos: [] });
    });
    render(<RepoPicker current={null} inline onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Start without a repository/ }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls).toEqual([{ noRepository: true }]);
  });

  it("opens the example project, and hides it while searching", async () => {
    const calls: unknown[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        calls.push(JSON.parse(String(init.body)));
        return Response.json({ project: { id: "p1" } });
      }
      return Response.json(url.includes("/api/projects") ? { projects: [] } : { ok: true, repos: [] });
    });
    render(<RepoPicker current={null} inline onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Try the example project/ }));
    await waitFor(() => expect(calls).toEqual([{ example: true }]));

    fireEvent.change(screen.getByRole("textbox", { name: "Search repositories" }), { target: { value: "acme" } });
    expect(screen.queryByRole("button", { name: /Try the example project/ })).toBeNull();
  });

  it("lists the example project after boards and GitHub repositories", async () => {
    vi.stubGlobal("fetch", async (url: string) =>
      Response.json(
        url.includes("/api/projects")
          ? { projects: [{ id: "p1", repoFullName: "acme/api", baseBranch: "main", notifications: {} }] }
          : { ok: true, repos: [{ fullName: "acme/web", private: false }], installUrl: null },
      ),
    );
    render(<RepoPicker current={null} inline onClose={() => {}} />);
    await screen.findByText("acme/web");
    const at = (t: string) => screen.getByText(t).compareDocumentPosition.bind(screen.getByText(t));
    expect(at("Your boards")(screen.getByText("Your GitHub repositories"))).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(at("Your GitHub repositories")(screen.getByText("Example project"))).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("marks a board with the kind waiting on it", async () => {
    vi.stubGlobal("fetch", async (url: string) =>
      Response.json(
        url.includes("/api/projects")
          ? {
              active: { id: "p0" },
              projects: [
                { id: "p1", repoFullName: "acme/api", baseBranch: "main", notifications: { needsAttention: { seq: 4 } } },
                { id: "p2", repoFullName: "acme/web", baseBranch: "main", notifications: {} },
              ],
            }
          : { ok: true, repos: [], installUrl: null },
      ),
    );
    render(<RepoPicker current={null} inline onClose={() => {}} />);
    expect(await screen.findByRole("img", { name: "Needs attention" })).toBeInTheDocument();
    expect(screen.getAllByRole("img")).toHaveLength(1);
  });

  it("creates a new repository from a bare name, then opens its board", async () => {
    const calls: Array<{ url: string; body?: string }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body as string | undefined });
      if (url === "/api/github/repos" && init?.method === "POST") {
        return Response.json({ repo: { fullName: "ada/fresh-idea" } });
      }
      if (url === "/api/projects" && init?.method === "POST") {
        return Response.json({ project: { id: "p1" } });
      }
      return Response.json(
        url.includes("/api/projects")
          ? { projects: [] }
          : { ok: true, repos: [{ fullName: "ada/old", defaultBranch: "main", private: false, description: null }] },
      );
    });
    render(<RepoPicker current={null} inline onClose={() => {}} />);
    await screen.findByText("ada/old");

    fireEvent.change(screen.getByLabelText("Search repositories"), { target: { value: "old" } });
    expect(screen.queryByText("new private repo")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Search repositories"), {
      target: { value: "fresh-idea" },
    });
    fireEvent.click(screen.getByText("new private repo"));

    await waitFor(() =>
      expect(calls.some((c) => c.url === "/api/projects" && c.body)).toBe(true),
    );
    expect(calls.find((c) => c.url === "/api/github/repos" && c.body)?.body).toBe(
      JSON.stringify({ name: "fresh-idea" }),
    );
    expect(calls.find((c) => c.url === "/api/projects" && c.body)?.body).toBe(
      JSON.stringify({ repoFullName: "ada/fresh-idea" }),
    );
  });
});
