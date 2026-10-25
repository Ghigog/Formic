"use client";

import { useState } from "react";

export interface Token {
  id: string;
  name: string;
  lastFour: string;
  readOnly: boolean;
  expiresAt: string | null;
}

const EXPIRIES = [
  { label: "Never expires", days: 0 },
  { label: "30 days", days: 30 },
  { label: "90 days", days: 90 },
  { label: "1 year", days: 365 },
];

/** Personal access tokens: make, name and revoke the ones other tools use to reach your boards. */
export function AccessTokensSection({ initial = [] }: { initial?: Token[] }) {
  const [tokens, setTokens] = useState<Token[]>(initial);
  const [name, setName] = useState("");
  const [days, setDays] = useState(30);
  const [readOnly, setReadOnly] = useState(true);
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const res = await fetch("/api/access-tokens").catch(() => null);
    if (res?.ok) setTokens(((await res.json()) as { tokens: Token[] }).tokens);
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const res = await fetch("/api/access-tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, readOnly, ...(days ? { expiresInDays: days } : {}) }),
    }).catch(() => null);
    if (!res?.ok) {
      setError("That did not save. Give the token a name and try again.");
      return;
    }
    setSecret(((await res.json()) as { secret: string }).secret);
    setCopied(false);
    setName("");
    await load();
  }

  async function revoke(id: string) {
    setError(null);
    const res = await fetch(`/api/access-tokens/${id}`, { method: "DELETE" }).catch(() => null);
    if (!res?.ok) {
      setError("Could not revoke that token. Try again.");
      return;
    }
    setTokens((list) => list.filter((t) => t.id !== id));
  }

  async function copy() {
    if (!secret) return;
    await navigator.clipboard.writeText(secret).catch(() => {});
    setCopied(true);
  }

  return (
    <section className="bg-card border-line rounded-xl border p-4">
      <h2 className="text-ink mb-3 text-[11px] font-semibold tracking-[0.1em] uppercase">Access tokens</h2>
      <p className="text-muted mb-2.5 text-[12px] leading-[1.5]">
        Tokens let other tools reach your boards. Revoke one and it stops working at once.
      </p>
      <form onSubmit={(e) => void create(e)} className="mb-3 flex flex-wrap items-center gap-2">
        <input
          aria-label="Token name"
          placeholder="Name, e.g. laptop"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="border-line text-ink rounded-md border px-2 py-1 text-[12px]"
        />
        <select
          aria-label="Expiry"
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
          className="border-line text-ink rounded-md border px-2 py-1 text-[12px]"
        >
          {EXPIRIES.map((x) => (
            <option key={x.days} value={x.days}>
              {x.label}
            </option>
          ))}
        </select>
        <label className="text-ink flex items-center gap-1 text-[12px]">
          <input type="checkbox" checked={readOnly} onChange={(e) => setReadOnly(e.target.checked)} />
          Read-only
        </label>
        <button type="submit" disabled={!name.trim()} className="border-line text-ink rounded-md border px-3 py-1.5 text-[12px] disabled:opacity-60">
          Create token
        </button>
      </form>
      {secret && (
        <div role="status" className="border-line mb-3 rounded-md border p-2 text-[12px]">
          <p className="text-ink mb-1">Copy this token now. It will not be shown again.</p>
          <code className="text-ink break-all">{secret}</code>
          <div className="mt-1.5 flex gap-2">
            <button type="button" onClick={() => void copy()} className="border-line text-ink rounded-md border px-3 py-1 text-[12px]">
              {copied ? "Copied" : "Copy"}
            </button>
            <button type="button" onClick={() => setSecret(null)} className="text-muted text-[12px]">
              Done
            </button>
          </div>
        </div>
      )}
      {tokens.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {tokens.map((t) => (
            <li key={t.id} className="text-ink flex items-center justify-between gap-2 text-[12px]">
              <span>
                {t.name} · …{t.lastFour} · {t.readOnly ? "Read-only" : "Read and write"} ·{" "}
                {t.expiresAt ? `Expires ${t.expiresAt.slice(0, 10)}` : "Never expires"}
              </span>
              <button
                type="button"
                aria-label={`Revoke ${t.name}`}
                onClick={() => void revoke(t.id)}
                className="border-line text-ink rounded-md border px-2 py-1 text-[12px]"
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p role="alert" className="text-crimson-text mt-1 text-[11px]">
          {error}
        </p>
      )}
    </section>
  );
}
