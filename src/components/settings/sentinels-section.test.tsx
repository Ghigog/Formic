import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SentinelsSection } from "./sentinels-section";

afterEach(() => vi.unstubAllGlobals());

describe("SentinelsSection", () => {
  it("saves the toggle for the project", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    render(<SentinelsSection projectId="p1" initial={false} />);

    await userEvent.click(screen.getByRole("checkbox", { name: "Unlock all Sentinels" }));

    await waitFor(() => expect(screen.getByRole("checkbox")).toBeChecked());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects/p1",
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ unlockAllSentinels: true }) }),
    );
  });

  it("stays off and says so when the save fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    render(<SentinelsSection projectId="p1" initial={false} />);

    await userEvent.click(screen.getByRole("checkbox"));

    expect(await screen.findByRole("alert")).toHaveTextContent("did not save");
    expect(screen.getByRole("checkbox")).not.toBeChecked();
  });
});
