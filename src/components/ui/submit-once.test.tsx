import { describe, expect, it } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { SubmitOnce } from "./submit-once";

function setup() {
  let submits = 0;
  let prevented = 0;
  render(
    <form
      onSubmit={(e) => {
        submits++;
        if (e.defaultPrevented) prevented++;
        e.preventDefault();
      }}
    >
      <SubmitOnce pending="Sending your link…">Email me a sign-in link</SubmitOnce>
    </form>,
  );
  return { counts: () => ({ submits, prevented }) };
}

describe("SubmitOnce", () => {
  it("says it is sending once the form goes", () => {
    setup();
    fireEvent.submit(screen.getByRole("button").closest("form")!);
    expect(screen.getByRole("button")).toHaveTextContent("Sending your link…");
    expect(screen.getByRole("button")).toHaveAttribute("aria-disabled", "true");
  });

  it("stops a second submit while the first is on its way", () => {
    const { counts } = setup();
    const form = screen.getByRole("button").closest("form")!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(counts()).toEqual({ submits: 2, prevented: 1 });
  });

  it("can be pressed again after coming back to the page from the cache", () => {
    setup();
    fireEvent.submit(screen.getByRole("button").closest("form")!);
    act(() => {
      const e = new Event("pageshow") as PageTransitionEvent;
      Object.defineProperty(e, "persisted", { value: true });
      window.dispatchEvent(e);
    });
    expect(screen.getByRole("button")).toHaveTextContent("Email me a sign-in link");
  });
});
