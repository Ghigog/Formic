import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { MarkdownLite } from "./markdown-lite";

describe("MarkdownLite", () => {
  it("renders numbered steps as a numbered list, apart from bullets", () => {
    const { container } = render(
      <MarkdownLite text={"Checkout works.\n\n## See it\n\n1. Open the shop.\n2. Pay.\n- a note"} />,
    );
    const steps = container.querySelectorAll("ol > li");
    expect([...steps].map((li) => li.textContent)).toEqual(["Open the shop.", "Pay."]);
    expect(container.querySelector("ul > li")?.textContent).toBe("a note");
    expect(container.querySelector("p")?.textContent).toBe("Checkout works.");
  });
});
