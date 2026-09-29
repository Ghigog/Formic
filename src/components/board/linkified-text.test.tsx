import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { LinkifiedText } from "./linkified-text";

const URL = "https://github.com/acme/widgets/pull/7";

describe("LinkifiedText", () => {
  it("turns a URL in a sentence into a link, and leaves the words around it words", () => {
    const reason = `Claude Code runs in this repository's GitHub Actions. Merge the setup pull request once (${URL}), then try again.`;
    const { container } = render(<LinkifiedText text={reason} />);

    const link = screen.getByRole("link", { name: URL });
    expect(link).toHaveAttribute("href", URL);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer");
    // Still one sentence: the brackets and the full stop are text around the
    // link, not part of the address.
    expect(container.textContent).toBe(reason);
  });

  it("keeps a sentence's own full stop out of the address", () => {
    render(<LinkifiedText text={`Merge it, then see ${URL}.`} />);

    expect(screen.getByRole("link", { name: URL })).toHaveAttribute("href", URL);
  });

  it("renders text with no URL in it exactly as it was", () => {
    const { container } = render(<LinkifiedText text="Blocked by T-2: it writes the same files." />);

    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(container.textContent).toBe("Blocked by T-2: it writes the same files.");
  });
});
