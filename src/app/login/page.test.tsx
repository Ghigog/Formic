import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import LoginPage from "./page";

afterEach(() => vi.unstubAllEnvs());

describe("LoginPage", () => {
  it("refuses sign-in with a message for the operator when FORMIC_SECRET is missing in GitHub mode", async () => {
    vi.stubEnv("GITHUB_APP_CLIENT_ID", "Iv1.test");
    vi.stubEnv("GITHUB_APP_CLIENT_SECRET", "shh");
    render(await LoginPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByRole("alert")).toHaveTextContent(/FORMIC_SECRET is not set/);
    expect(screen.queryByRole("link", { name: /Sign in with GitHub/ })).not.toBeInTheDocument();
  });

  it("offers GitHub sign-in when FORMIC_SECRET is set to a real secret", async () => {
    vi.stubEnv("GITHUB_APP_CLIENT_ID", "Iv1.test");
    vi.stubEnv("GITHUB_APP_CLIENT_SECRET", "shh");
    vi.stubEnv("FORMIC_SECRET", "a".repeat(32));
    render(await LoginPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByRole("link", { name: /Sign in with GitHub/ })).toBeInTheDocument();
  });

  it("keeps the password form in local mode with no FORMIC_SECRET", async () => {
    render(await LoginPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
  });
});
