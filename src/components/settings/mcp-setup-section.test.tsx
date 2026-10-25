// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { McpSetupSection } from "./mcp-setup-section";

const endpoint = "https://board.example.com/api/mcp";
afterEach(cleanup);

describe("McpSetupSection", () => {
  it("shows the endpoint and both snippets with a placeholder token", () => {
    render(<McpSetupSection endpoint={endpoint} />);
    expect(screen.getByText(endpoint)).toBeInTheDocument();
    expect(
      screen.getByText(`claude mcp add --transport http formic ${endpoint} --header "Authorization: Bearer <your-token>"`),
    ).toBeInTheDocument();
    expect(screen.getByText(/\[mcp_servers\.formic\]/)).toHaveTextContent(`url = "${endpoint}"`);
    expect(screen.getAllByRole("button", { name: /^Copy/ })).toHaveLength(3);
  });

  it("puts a just-created token in the snippets and copies it", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(<McpSetupSection endpoint={endpoint} token="fmc_abc" />);
    expect(screen.queryByText(/<your-token>/)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Copy Claude Code snippet" }));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("Bearer fmc_abc"));
  });
});
