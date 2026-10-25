import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SettingsForm } from "./settings-form";

// It fetches the colony on mount; colony-section.test.tsx covers it.
vi.mock("@/components/settings/colony-section", () => ({ ColonySection: () => null }));

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

const account = { login: "octo", name: "Octo Cat", avatarUrl: null, signedIn: true };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Sound", () => {
  afterEach(() => window.localStorage.clear());

  it("is on by default and saves the choice when toggled", async () => {
    render(
      <SettingsForm account={account} installUrl={null} e2b={{ hint: null, serverFallback: false }} />,
    );
    const sw = screen.getByRole("switch", { name: "Sound" });
    expect(sw).toBeChecked();

    await userEvent.click(sw);

    expect(sw).not.toBeChecked();
    expect(window.localStorage.getItem("formic:sound")).toBe("off");
  });
});

describe("Guided tours", () => {
  afterEach(() => window.localStorage.clear());

  it("forgets every tour seen, so each screen's plays again", async () => {
    window.localStorage.setItem("formic:tours:seen", JSON.stringify(["board", "timeline"]));
    render(
      <SettingsForm account={account} installUrl={null} e2b={{ hint: null, serverFallback: false }} />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Show tours again" }));

    expect(JSON.parse(window.localStorage.getItem("formic:tours:seen")!)).toEqual([]);
    expect(screen.getByText(/plays again the next time you open it/)).toBeInTheDocument();
  });
});

describe("Danger zone", () => {
  it("deletes nothing when the confirmation is declined", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(
      <SettingsForm account={account} installUrl={null} e2b={{ hint: null, serverFallback: false }} />,
    );

    const user = userEvent.setup();
    await act(async () => {
      await user.click(screen.getByRole("button", { name: "Delete my account" }));
    });

    expect(window.confirm).toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("calls DELETE /api/account with confirm: true once confirmed", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const fetchMock = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    render(
      <SettingsForm account={account} installUrl={null} e2b={{ hint: null, serverFallback: false }} />,
    );

    const user = userEvent.setup();
    await act(async () => {
      await user.click(screen.getByRole("button", { name: "Delete my account" }));
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/account",
      expect.objectContaining({ method: "DELETE", body: JSON.stringify({ confirm: true }) }),
    );
    expect(push).toHaveBeenCalledWith("/login");
  });

  it("is not shown in local mode, where there is no account to delete", () => {
    render(
      <SettingsForm
        account={{ ...account, signedIn: false }}
        installUrl={null}
        e2b={{ hint: null, serverFallback: false }}
      />,
    );

    expect(screen.queryByRole("button", { name: "Delete my account" })).not.toBeInTheDocument();
  });
});

describe("Sandbox key", () => {
  const form = (e2b: Parameters<typeof SettingsForm>[0]["e2b"]) =>
    render(<SettingsForm account={account} installUrl={null} e2b={e2b} />);

  it("says how many minutes are left on the server's key", () => {
    form({ hint: null, serverFallback: true, fallbackMinutesLeft: 12 });
    expect(screen.getByText(/12 sandbox minutes left this month/)).toBeInTheDocument();
  });

  it("walks through getting a key, the free credit and where to check spend", () => {
    form({ hint: null, serverFallback: false });
    expect(screen.getByText(/free plan comes with \$100 of credit/)).toBeInTheDocument();
    expect(screen.getByText(/press Verify workspace/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "E2B console" })).toHaveAttribute("href", "https://console.e2b.dev");
    expect(screen.getByText(/check the Usage page/)).toBeInTheDocument();
  });

  it("asks for their own key once the minutes are used", () => {
    form({ hint: null, serverFallback: true, fallbackMinutesLeft: 0 });
    expect(screen.getByText(/Add your own key to keep running/)).toBeInTheDocument();
  });
});

describe("Auto-merge", () => {
  const project = { id: "p1", name: "Formic", autoMerge: false, autoEscalate: false };

  it("shows only the current board, and the label follows the switch", async () => {
    const fetchMock = vi.fn(async () => Response.json({ autoMerge: true }));
    vi.stubGlobal("fetch", fetchMock);
    render(
      <SettingsForm
        account={account}
        installUrl={null}
        project={project}
        e2b={{ hint: null, serverFallback: false }}
      />,
    );

    const toggle = screen.getByRole("checkbox", { name: "Merge when move to done" });
    expect(toggle).not.toBeChecked();
    const user = userEvent.setup();
    await act(async () => {
      await user.click(toggle);
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/settings",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ projectId: "p1", autoMerge: true }),
      }),
    );
    expect(toggle).toBeChecked();
    // The label now describes the behaviour it was switched into.
    expect(toggle).toHaveAccessibleName("Auto-merge when review finished and CI green");
  });

  it("stays off and says so when the save is refused", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "no" }, { status: 403 })));
    render(
      <SettingsForm
        account={account}
        installUrl={null}
        project={project}
        e2b={{ hint: null, serverFallback: false }}
      />,
    );
    const toggle = screen.getByRole("checkbox", { name: "Merge when move to done" });
    const user = userEvent.setup();
    await act(async () => {
      await user.click(toggle);
    });
    expect(toggle).not.toBeChecked();
    expect(screen.getByText("That did not save. Try again.")).toBeInTheDocument();
  });

  it("shows nothing when there is no board to set it on", () => {
    render(
      <SettingsForm account={account} installUrl={null} e2b={{ hint: null, serverFallback: false }} />,
    );
    expect(screen.queryByRole("checkbox", { name: /merge/i })).not.toBeInTheDocument();
  });
});

describe("Auto-escalation", () => {
  const project = { id: "p1", name: "Formic", autoMerge: false, autoEscalate: false };
  const e2b = { hint: null, serverFallback: false };

  it("shows the stored value and saves a change", async () => {
    const fetchMock = vi.fn(async () => Response.json({ autoEscalate: false }));
    vi.stubGlobal("fetch", fetchMock);
    render(
      <SettingsForm
        account={account}
        installUrl={null}
        project={{ ...project, autoEscalate: true }}
        e2b={e2b}
      />,
    );
    const toggle = screen.getByRole("checkbox", { name: "Escalate story points automatically" });
    expect(toggle).toBeChecked();
    const user = userEvent.setup();
    await act(async () => {
      await user.click(toggle);
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/settings",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ projectId: "p1", autoEscalate: false }),
      }),
    );
    expect(toggle).not.toBeChecked();
  });

  it("stays as it was and says so when the save is refused", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "no" }, { status: 403 })));
    render(<SettingsForm account={account} installUrl={null} project={project} e2b={e2b} />);
    const toggle = screen.getByRole("checkbox", { name: "Escalate story points automatically" });
    const user = userEvent.setup();
    await act(async () => {
      await user.click(toggle);
    });
    expect(toggle).not.toBeChecked();
    expect(screen.getByText("That did not save. Try again.")).toBeInTheDocument();
  });

  it("shows nothing when there is no board to set it on", () => {
    render(<SettingsForm account={account} installUrl={null} e2b={e2b} />);
    expect(screen.queryByRole("checkbox", { name: /escalate/i })).not.toBeInTheDocument();
  });
});

describe("GitHub access (local mode)", () => {
  it("saves the token through /api/settings", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ e2bKeyHint: null, githubTokenHint: "1234" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(
      <SettingsForm
        account={account}
        installUrl={null}
        // A saved sandbox key keeps that field out of its editing state, so the
        // only Save button on the page is this one.
        e2b={{ hint: "abcd", serverFallback: false }}
        github={{ hint: null }}
      />,
    );

    const user = userEvent.setup();
    await act(async () => {
      await user.type(screen.getByLabelText("GitHub access API key"), "ghp_TESTTOKEN1234");
    });
    // The budget and renewal sections have Save buttons of their own.
    const section = screen.getByText("GitHub access").closest("section")!;
    await act(async () => {
      await user.click(within(section).getByRole("button", { name: "Save" }));
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/settings",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ githubToken: "ghp_TESTTOKEN1234" }),
      }),
    );
  });

  it("is not offered outside local mode, where the sign-in is the credential", () => {
    render(
      <SettingsForm account={account} installUrl={null} e2b={{ hint: null, serverFallback: false }} />,
    );

    expect(screen.queryByText("GitHub access")).not.toBeInTheDocument();
  });
});

describe("Agents", () => {
  const project = { id: "p1", name: "Board", autoMerge: false, autoEscalate: false, shareKeys: true, agents: false };
  const e2b = { hint: null, serverFallback: false };

  it("hides the provider, key, colony, scout, auto-merge and sharing settings when off", () => {
    render(<SettingsForm account={account} installUrl={null} e2b={e2b} project={project} />);

    expect(screen.getByRole("switch", { name: "Agents" })).not.toBeChecked();
    expect(screen.queryByLabelText(/API key/)).not.toBeInTheDocument();
    expect(screen.queryByText("Auto-merge")).not.toBeInTheDocument();
    expect(screen.queryByText("Sharing")).not.toBeInTheDocument();
    expect(screen.queryByText(/AI provider keys live/)).not.toBeInTheDocument();
  });

  it("saves the owner's flip and shows the agent sections", async () => {
    const fetchMock = vi.fn(async () => Response.json({ agents: true }));
    vi.stubGlobal("fetch", fetchMock);
    render(<SettingsForm account={account} installUrl={null} e2b={e2b} project={project} />);

    await userEvent.click(screen.getByRole("switch", { name: "Agents" }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/settings",
      expect.objectContaining({ body: JSON.stringify({ projectId: "p1", agents: true }) }),
    );
    expect(await screen.findByText("Auto-merge")).toBeInTheDocument();
    expect(screen.getByLabelText(/API key/)).toBeInTheDocument();
  });

  it("is not editable for a non-owner", () => {
    render(
      <SettingsForm account={account} installUrl={null} e2b={e2b} project={{ ...project, owner: false }} />,
    );

    expect(screen.getByRole("switch", { name: "Agents" })).toBeDisabled();
    expect(screen.queryByText("Auto-merge")).not.toBeInTheDocument();
  });
});
