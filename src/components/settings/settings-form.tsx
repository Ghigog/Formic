"use client";

import Link from "next/link";
import { useState } from "react";
import type { Account } from "@/components/board/account-menu";

interface KeyState {
  /** Last four characters of the saved key, or null with none saved. */
  hint: string | null;
  /** The server has its own key that runs use when this person has none. */
  serverFallback: boolean;
}

/**
 * Everything that is this person's own: who they are on GitHub, which
 * repositories Formic may touch, and the keys their runs are paid with.
 */
export function SettingsForm({
  account,
  installUrl,
  e2b,
}: {
  account: Account;
  installUrl: string | null;
  e2b: KeyState;
}) {
  return (
    <div className="bg-cream min-h-dvh">
      <header className="border-line bg-card flex h-16 items-center gap-3 border-b px-4 md:px-6">
        <Link href="/" className="text-muted hover:text-ink text-[13px] font-medium">
          ← Board
        </Link>
        <span aria-hidden className="bg-line h-6 w-px" />
        <h1 className="font-serif text-[19px] font-semibold">Settings</h1>
      </header>

      <main className="mx-auto flex max-w-xl flex-col gap-4 px-4 py-6">
        <Section title="GitHub">
          <div className="flex items-center gap-3">
            {account.avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={account.avatarUrl} alt="" className="size-10 rounded-full" />
            ) : null}
            <div className="min-w-0 flex-1">
              <p className="text-ink text-[14px] font-semibold">{account.name ?? account.login}</p>
              <p className="text-muted text-[12px]">
                {account.signedIn
                  ? `Signed in as @${account.login}. Agents push and open pull requests as you.`
                  : "Local mode: the server's GITHUB_TOKEN is used for every board."}
              </p>
            </div>
            {account.signedIn && (
              <form method="post" action="/api/auth/logout">
                <button
                  type="submit"
                  className="text-muted hover:text-ink h-9 px-2 text-[12px] font-medium"
                >
                  Sign out
                </button>
              </form>
            )}
          </div>
          {installUrl && (
            <a
              href={installUrl}
              className="text-terracotta mt-3 inline-block text-[13px] font-semibold"
            >
              Choose which repositories Formic can access →
            </a>
          )}
        </Section>

        <KeyField
          field="e2bKey"
          title="Sandbox (E2B)"
          blurb="The cloud machines your coding agents work in, whichever AI provider they use."
          getFrom="https://e2b.dev/dashboard"
          getFromLabel="e2b.dev/dashboard → API Keys"
          placeholder="e2b_…"
          state={e2b}
        />

        <p className="text-muted px-1 text-[12px] leading-[1.5]">
          AI provider keys live on each agent, not here: pick or create one from
          a column&apos;s agent menu on the board, and give it the key for its
          provider.
        </p>

        {account.signedIn && <DangerZone />}
      </main>
    </div>
  );
}

function DangerZone() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function deleteAccount() {
    if (
      !window.confirm(
        "Delete your account? This removes your boards, saved agents, keys and history from Formic, and cannot be undone. Issues, branches, pull requests and repo secrets already on GitHub are not touched — see docs/legal/privacy.md for how to remove those.",
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    const res = await fetch("/api/account", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: true }),
    }).catch(() => null);
    if (!res?.ok) {
      const body = (await res?.json().catch(() => null)) as { error?: string } | null;
      setError(body?.error ?? "That did not work. Try again.");
      setBusy(false);
      return;
    }
    window.location.href = "/login";
  }

  return (
    <Section title="Danger zone">
      <p className="text-muted mb-2.5 text-[12px] leading-[1.5]">
        Deletes your account and everything Formic knows about you. Formic
        does not touch GitHub itself: issues, branches, pull requests and
        repo secrets stay behind (see{" "}
        <Link href="/legal" className="text-ink underline">
          the privacy policy
        </Link>{" "}
        for how to remove those too).
      </p>
      <button
        type="button"
        disabled={busy}
        onClick={() => void deleteAccount()}
        className="text-crimson-text h-9 px-2 text-[13px] font-semibold disabled:opacity-50"
      >
        {busy ? "Deleting…" : "Delete my account"}
      </button>
      {error && <p className="text-crimson-text mt-1.5 text-[11px]">{error}</p>}
    </Section>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="bg-card border-line rounded-xl border p-4">
      <h2 className="text-ink mb-3 text-[11px] font-semibold tracking-[0.1em] uppercase">
        {title}
      </h2>
      {children}
    </section>
  );
}

function KeyField({
  field,
  title,
  blurb,
  getFrom,
  getFromLabel,
  placeholder,
  state,
}: {
  field: "e2bKey";
  title: string;
  blurb: string;
  getFrom: string;
  getFromLabel: string;
  placeholder: string;
  state: KeyState;
}) {
  const [hint, setHint] = useState(state.hint);
  const [editing, setEditing] = useState(!state.hint);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function save(next: string | null) {
    setBusy(true);
    setMessage(null);
    const res = await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [field]: next }),
    }).catch(() => null);
    setBusy(false);
    const body = (await res?.json().catch(() => null)) as
      | { error?: string; e2bKeyHint?: string | null }
      | null;
    if (!res?.ok) {
      setMessage({ ok: false, text: body?.error ?? "That did not save. Try again." });
      return;
    }
    const saved = body?.e2bKeyHint;
    setHint(saved ?? null);
    setEditing(!saved);
    setValue("");
    setMessage({ ok: true, text: next === null ? "Key removed." : "Key saved." });
  }

  const fallback = state.serverFallback
    ? "Without one, runs use the server's key."
    : "Without one, coding agents can't run.";

  return (
    <Section title={title}>
      <p className="text-muted mb-2.5 text-[12px] leading-[1.5]">
        {blurb} Get one at{" "}
        <a href={getFrom} target="_blank" rel="noreferrer" className="text-ink underline">
          {getFromLabel}
        </a>
        .
      </p>

      {editing ? (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (value.trim()) void save(value.trim());
          }}
        >
          <input
            type="password"
            autoComplete="off"
            aria-label={`${title} API key`}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={placeholder}
            className="border-line bg-cream text-ink focus:border-clay h-10 min-w-0 flex-1 rounded-md border px-2.5 font-mono text-[13px] outline-none"
          />
          <button
            type="submit"
            disabled={busy || !value.trim()}
            className="bg-terracotta-cta h-10 rounded-lg px-3.5 text-[13px] font-semibold text-white disabled:opacity-50"
          >
            {busy ? "Saving…" : "Save"}
          </button>
          {hint && (
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="text-muted hover:text-ink h-10 px-1 text-[12px] font-medium"
            >
              Cancel
            </button>
          )}
        </form>
      ) : (
        <div className="border-line bg-cream flex h-10 items-center gap-3 rounded-md border px-2.5">
          <span className="text-ink flex-1 font-mono text-[13px]">••••••••{hint}</span>
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="text-terracotta text-[12px] font-semibold"
          >
            Replace
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void save(null)}
            className="text-muted hover:text-ink text-[12px] font-medium"
          >
            Remove
          </button>
        </div>
      )}

      <p
        role={message ? "status" : undefined}
        className={`mt-1.5 text-[11px] ${message && !message.ok ? "text-crimson-text" : "text-muted"}`}
      >
        {message?.text ?? (hint ? "Stored encrypted. Never shown again." : fallback)}
      </p>
    </Section>
  );
}
