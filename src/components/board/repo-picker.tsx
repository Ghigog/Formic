"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/components/ui/cn";

interface Project {
  id: string;
  repoFullName: string;
  baseBranch: string;
}

interface RepoOption {
  fullName: string;
  defaultBranch: string;
  private: boolean;
  description: string | null;
}

const OWNER_REPO = /^[\w.-]+\/[\w.-]+$/;

/**
 * Which repository the board works on. Repositories already on the board
 * come first; below them, everything the GitHub token can reach. Typing an
 * owner/repo that is in neither list still works, for a token that can push
 * to a repository it cannot list.
 *
 * Picking one switches this browser's board and reloads it, since the event
 * stream and every card belong to the project.
 */
export function RepoPicker({
  current,
  onClose,
  className,
}: {
  current: string;
  onClose: () => void;
  className?: string;
}) {
  const [query, setQuery] = useState("");
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [repos, setRepos] = useState<RepoOption[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
    void fetch("/api/projects", { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { projects: Project[] }) => setProjects(d.projects))
      .catch(() => setProjects([]));
    void fetch("/api/github/repos", { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { ok: boolean; repos?: RepoOption[]; reason?: string }) => {
        setRepos(d.repos ?? []);
        if (!d.ok) setNotice(d.reason ?? "Could not list repositories.");
      })
      .catch(() => {
        setRepos([]);
        setNotice("Could not list repositories.");
      });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const q = query.trim().toLowerCase();
  const onBoard = useMemo(
    () =>
      (projects ?? []).filter((p) => p.repoFullName.toLowerCase().includes(q)),
    [projects, q],
  );
  const known = useMemo(
    () => new Set((projects ?? []).map((p) => p.repoFullName.toLowerCase())),
    [projects],
  );
  const fromGitHub = useMemo(
    () =>
      (repos ?? [])
        .filter((r) => !known.has(r.fullName.toLowerCase()))
        .filter((r) => r.fullName.toLowerCase().includes(q))
        .slice(0, 50),
    [repos, known, q],
  );
  const typed =
    OWNER_REPO.test(query.trim()) &&
    !known.has(q) &&
    !(repos ?? []).some((r) => r.fullName.toLowerCase() === q)
      ? query.trim()
      : null;

  async function choose(body: { projectId: string } | { repoFullName: string }, key: string) {
    setBusy(key);
    setError(null);
    const res = await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => null);
    if (!res?.ok) {
      const data = (await res?.json().catch(() => null)) as { error?: string } | null;
      setError(data?.error ?? "Could not switch repository.");
      setBusy(null);
      return;
    }
    window.location.reload();
  }

  const row =
    "flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[13px] hover:bg-cream focus-visible:bg-cream outline-none disabled:opacity-60";

  return (
    <>
      <div aria-hidden className="fixed inset-0 z-40" onClick={onClose} />
      <div
        role="dialog"
        aria-label="Choose a repository"
        className={cn(
          "bg-card border-line shadow-lift z-50 flex max-h-[70dvh] w-[380px] max-w-[calc(100vw-32px)] flex-col overflow-hidden rounded-xl border",
          className,
        )}
      >
        <div className="border-hairline border-b p-2.5">
          <input
            ref={input}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search or type owner/repo"
            aria-label="Search repositories"
            className="border-line bg-cream text-ink focus:border-clay h-9 w-full rounded-md border px-2.5 text-[13px] outline-none"
          />
        </div>

        <div className="flex-1 overflow-y-auto p-1.5">
          {typed && (
            <button
              type="button"
              className={row}
              disabled={busy !== null}
              onClick={() => void choose({ repoFullName: typed }, typed)}
            >
              <span className="text-muted">Use</span>
              <span className="text-ink font-medium">{typed}</span>
            </button>
          )}

          {onBoard.length > 0 && (
            <Section label="On this board">
              {onBoard.map((p) => {
                const selected = p.repoFullName === current;
                return (
                  <button
                    key={p.id}
                    type="button"
                    className={row}
                    aria-current={selected ? "true" : undefined}
                    disabled={busy !== null}
                    onClick={() =>
                      selected ? onClose() : void choose({ projectId: p.id }, p.id)
                    }
                  >
                    <span className="text-ink min-w-0 flex-1 truncate font-medium">
                      {p.repoFullName}
                    </span>
                    <span className="text-muted font-mono text-[10px]">{p.baseBranch}</span>
                    {selected && <Check />}
                    {busy === p.id && <span className="text-muted text-[11px]">…</span>}
                  </button>
                );
              })}
            </Section>
          )}

          <Section label="Your GitHub repositories">
            {repos === null ? (
              <p className="text-muted px-2.5 py-2 text-[12px]">Loading…</p>
            ) : fromGitHub.length === 0 ? (
              <p className="text-muted px-2.5 py-2 text-[12px]">
                {notice ?? (q ? "No match." : "Nothing else to add.")}
              </p>
            ) : (
              fromGitHub.map((r) => (
                <button
                  key={r.fullName}
                  type="button"
                  className={row}
                  disabled={busy !== null}
                  onClick={() => void choose({ repoFullName: r.fullName }, r.fullName)}
                >
                  <span className="min-w-0 flex-1">
                    <span className="text-ink block truncate font-medium">
                      {r.fullName}
                    </span>
                    {r.description && (
                      <span className="text-muted block truncate text-[11px]">
                        {r.description}
                      </span>
                    )}
                  </span>
                  {r.private && (
                    <span className="text-muted border-line rounded border px-1 font-mono text-[9px]">
                      private
                    </span>
                  )}
                  {busy === r.fullName && <span className="text-muted text-[11px]">…</span>}
                </button>
              ))
            )}
          </Section>
        </div>

        {error && (
          <p role="alert" className="text-crimson-text border-hairline border-t px-3 py-2 text-[12px]">
            {error}
          </p>
        )}
      </div>
    </>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mt-1 first:mt-0">
      <h3 className="text-muted px-2.5 pt-2 pb-1 text-[10px] font-semibold tracking-[0.08em] uppercase">
        {label}
      </h3>
      {children}
    </div>
  );
}

function Check() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path
        d="M2.5 6.5 5 9l4.5-5.5"
        stroke="var(--color-jade)"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
