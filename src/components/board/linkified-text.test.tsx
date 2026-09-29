import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { LinkifiedText } from "./linkified-text";

const REASON =
  "Claude Code (your Claude plan) runs in this repository's GitHub Actions. " +
  "Merge the setup pull request once (https://github.com/acme/widgets/pull/1), then try again.";

describe("LinkifiedText", () => {
  it("renders a URL inside text as a link that opens in a new tab, leaving the rest plain", () => {
    const { container } = render(<LinkifiedText text={REASON} />);

    const links = container.querySelectorAll("a");
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute("href", "https://github.com/acme/widgets/pull/1");
    expect(links[0]).toHaveAttribute("target", "_blank");
    expect(links[0]).toHaveAttribute("rel", "noreferrer");
    expect(links[0]).toHaveTextContent("https://github.com/acme/widgets/pull/1");

    // The surrounding text stays plain, including the parenthesis the URL sat in.
    expect(container).toHaveTextContent(
      "Merge the setup pull request once (https://github.com/acme/widgets/pull/1), then try again.",
    );
  });

  it("leaves text without a URL as plain text", () => {
    render(<LinkifiedText text="Blocked by EPIC-1." />);
    expect(screen.getByText("Blocked by EPIC-1.")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});
