import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import VerifyPage from "./page";

describe("VerifyPage", () => {
  it("asks for a click that posts the token, rather than spending it on open", async () => {
    const { container } = render(await VerifyPage({ searchParams: Promise.resolve({ token: "abc123" }) }));
    expect(screen.getByRole("button", { name: /Sign in to Formic/ })).toBeInTheDocument();
    const form = container.querySelector("form")!;
    expect(form.getAttribute("method")).toBe("post");
    expect(form.getAttribute("action")).toBe("/api/auth/email/verify");
    expect(container.querySelector<HTMLInputElement>("input[name=token]")!.value).toBe("abc123");
  });

  it("says the link is broken when it has no token", async () => {
    render(await VerifyPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByRole("alert")).toHaveTextContent(/missing its sign-in code/);
  });
});
