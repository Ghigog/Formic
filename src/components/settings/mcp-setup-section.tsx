"use client";

import { useState } from "react";

function Snippet({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    await navigator.clipboard.writeText(text).catch(() => {});
    setCopied(true);
  }
  return (
    <div className="mb-2.5">
      <div className="mb-1 flex items-center justify-between">
        <h3 className="text-ink text-[12px] font-semibold">{label}</h3>
        <button
          type="button"
          aria-label={`Copy ${label} snippet`}
          onClick={() => void copy()}
          className="border-line text-ink rounded-md border px-2 py-1 text-[12px]"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="border-line bg-cream text-ink overflow-x-auto rounded-md border p-2.5 font-mono text-[12px] leading-[1.6]">
        {text}
      </pre>
    </div>
  );
}

/** Copy-paste setup to connect Claude Code or Codex to this board's MCP endpoint. */
export function McpSetupSection({ endpoint, token }: { endpoint: string; token?: string | null }) {
  const secret = token || "<your-token>";
  const claude = `claude mcp add --transport http formic ${endpoint} --header "Authorization: Bearer ${secret}"`;
  const codex = `[mcp_servers.formic]
url = "${endpoint}"
http_headers = { Authorization = "Bearer ${secret}" }`;

  return (
    <section className="bg-card border-line rounded-xl border p-4">
      <h2 className="text-ink mb-3 text-[11px] font-semibold tracking-[0.1em] uppercase">Connect your agent</h2>
      <p className="text-muted mb-2.5 text-[12px] leading-[1.5]">
        Point Claude Code or Codex at this board. Create an access token above and it fills in below.
      </p>
      <Snippet label="Endpoint URL" text={endpoint} />
      <Snippet label="Claude Code" text={claude} />
      <Snippet label="Codex (add to ~/.codex/config.toml)" text={codex} />
    </section>
  );
}
