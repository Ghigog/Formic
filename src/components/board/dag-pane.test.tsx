import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { DagPane } from "./dag-pane";
import { makeCard } from "@/test/cards";

const URL = "https://github.com/acme/widgets/pull/7";

describe("DagPane", () => {
  it("links a URL a blocked ticket's reason names, so it can be clicked through", () => {
    const reason = `Claude Code runs in this repository's GitHub Actions. Merge the setup pull request once (${URL}), then try again.`;
    const { container } = render(
      <DagPane
        tickets={[
          makeCard({ key: "T-1", title: "Wire the export", status: "blocked", blockedReason: reason }),
        ]}
      />,
    );

    expect(screen.getByRole("link", { name: URL })).toHaveAttribute("href", URL);
    // The reason still reads as one sentence around the link.
    expect(container.textContent).toContain(reason);
  });
});
