"use client";

import { AutoTour } from "@/components/onboarding/tour";
import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/components/ui/cn";
import {
  markSeen,
  readSeen,
  readSeenNotifications,
  waitingOn,
  type ProjectActivity,
  type Waiting,
} from "@/lib/hooks/use-assistant-activity";

interface Project extends ProjectActivity {
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

const WAITING_LABELS: Record<Waiting, string> = {
  answer: "New assistant answer",
  ticketMoved: "A ticket moved",
  epicCompleted: "Epic completed",
  needsAttention: "Needs attention",
};

const OWNER_REPO = /^[\w.-]+\/[\w.-]+$/;
const REPO_NAME = /^[\w.-]{1,100}$/;

/**
 * Which repository the board works on. Repositories already on the board
 * come first; below them, everything the GitHub token can reach. Typing an
 * owner/repo that is in neither list still works, for a token that can push
 * to a repository it cannot list. A bare name that matches none of them
 * offers to create that repository on GitHub and start its board.
 *
 * Picking one switches this browser's board and reloads it, since the event
 * stream and every card belong to the project.
 */
export function RepoPicker({
  current,
  onClose,
  className,
  inline = false,
}: {
  /** The repository on screen, or null when there is none yet. */
  current: string | null;
  onClose: () => void;
  className?: string;
  /** Part of the page rather than a popover: no backdrop, no Escape. */
  inline?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [repos, setRepos] = useState<RepoOption[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [install, setInstall] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [waiting, setWaiting] = useState<Record<string, Waiting[]>>({});
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
    void fetch("/api/projects", { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { active?: { id: string } | null; projects: Project[] }) => {
        setProjects(d.projects);
        const seen = readSeen();
        const seenNotifications = readSeenNotifications();
        setWaiting(
          Object.fromEntries(
            d.projects
              .filter((p) => p.id !== (d.active?.id ?? null))
              .map((p) => [p.id, waitingOn(p, seen, seenNotifications)]),
          ),
        );
      })
      .catch(() => setProjects([]));
    void fetch("/api/github/repos", { cache: "no-store" })
      .then((r) => r.json())
      .then((d: {
        ok: boolean;
        repos?: RepoOption[];
        reason?: string;
        installUrl?: string | null;
      }) => {
        setRepos(d.repos ?? []);
        setInstall(d.installUrl ?? null);
        if (!d.ok) setNotice(d.reason ?? "Could not list repositories.");
      })
      .catch(() => {
        setRepos([]);
        setNotice("Could not list repositories.");
      });
  }, []);

  useEffect(() => {
    if (inline) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, inline]);

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
  const fresh =
    REPO_NAME.test(query.trim()) &&
    repos !== null &&
    !(repos ?? []).some((r) => r.fullName.toLowerCase().split("/")[1] === q) &&
    !(projects ?? []).some((p) => p.repoFullName.toLowerCase().split("/")[1] === q)
      ? query.trim()
      : null;

  async function create(name: string) {
    setBusy(`create:${name}`);
    setError(null);
    const res = await fetch("/api/github/repos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    }).catch(() => null);
    const data = (await res?.json().catch(() => null)) as
      | { repo?: { fullName: string }; error?: string }
      | null;
    if (!res?.ok || !data?.repo) {
      setError(data?.error ?? "Could not create the repository.");
      setBusy(null);
      return;
    }
    await choose({ repoFullName: data.repo.fullName }, `create:${name}`);
  }

  async function choose(
    body: { projectId: string } | { repoFullName: string } | { noRepository: true } | { example: true },
    key: string,
  ) {
    const project = "projectId" in body ? projects?.find((p) => p.id === body.projectId) : undefined;
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
    if (project) markSeen(project);
    window.location.reload();
  }

  const row =
    "flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[13px] hover:bg-cream focus-visible:bg-cream outline-none disabled:opacity-60";

  return (
    <>
      {!inline && <div aria-hidden className="fixed inset-0 z-40" onClick={onClose} />}
      <div
        role="dialog"
        aria-label="Choose a repository"
        className={cn(
          "bg-card border-line shadow-lift z-50 flex max-h-[70dvh] w-[380px] max-w-[calc(100vw-32px)] flex-col overflow-hidden rounded-xl border",
          className,
        )}
      >
        {!inline && <AutoTour id="switch" delay={450} />}
        <div data-tour="switch-search" className="border-hairline border-b p-2.5">
          <input
            ref={input}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search, type owner/repo, or name a new repo"
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

          {fresh && (
            <button
              type="button"
              className={row}
              disabled={busy !== null}
              onClick={() => void create(fresh)}
            >
              <span className="text-muted">Create</span>
              <span className="text-ink min-w-0 flex-1 truncate font-medium">{fresh}</span>
              <span className="text-muted border-line rounded border px-1 font-mono text-[9px]">
                new private repo
              </span>
              {busy === `create:${fresh}` && <span className="text-muted text-[11px]">…</span>}
            </button>
          )}

          {!q && (
            <div data-tour="examples">
              <Section label="Example project">
                <button
                  type="button"
                  className={row}
                  disabled={busy !== null}
                  onClick={() => void choose({ example: true }, "example")}
                >
                  <span className="min-w-0 flex-1">
                    <span className="text-ink block truncate font-medium">Try the example project</span>
                    <span className="text-muted block truncate text-[11px]">
                      A safe board to experiment on. Nothing touches your code.
                    </span>
                  </span>
                  <span className="bg-jade-chip text-jade-chip-text rounded-full px-1.5 py-px font-mono text-[9px]">
                    example
                  </span>
                  {busy === "example" && <span className="text-muted text-[11px]">…</span>}
                </button>
              </Section>
            </div>
          )}

          {onBoard.length > 0 && (
            <Section label="Your boards" tour="switch-boards">
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
                      {p.repoFullName || "No repository"}
                    </span>
                    <span className="text-muted font-mono text-[10px]">{p.baseBranch}</span>
                    {(waiting[p.id] ?? []).map((kind) => (
                      <span
                        key={kind}
                        role="img"
                        aria-label={WAITING_LABELS[kind]}
                        title={WAITING_LABELS[kind]}
                        className={cn(
                          "size-2 shrink-0 rounded-full",
                          kind === "needsAttention" ? "bg-crimson-text" : "bg-terracotta",
                        )}
                      />
                    ))}
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
              <p className="text-muted px-2.5 py-2 text-[12px] leading-[1.5]">
                {notice ??
                  (repos.length === 0 && install
                    ? "Formic isn't installed on any of your repositories yet. Give it access below, then pick one here."
                    : q && install
                      ? "Not found. If it's yours, give Formic access to it below."
                      : q
                        ? "No match."
                        : "Nothing else to add.")}
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

        <button
          type="button"
          className="text-terracotta border-hairline disabled:opacity-60 border-t px-3 py-2.5 text-left text-[12px] font-semibold"
          disabled={busy !== null}
          onClick={() => void choose({ noRepository: true }, "none")}
        >
          Start without a repository
          {busy === "none" && <span className="text-muted ml-1.5 text-[11px]">…</span>}
        </button>

        {install && (
          <a
            href={install}
            className="text-terracotta border-hairline block border-t px-3 py-2.5 text-[12px] font-semibold"
          >
            Give Formic access to more repositories →
          </a>
        )}

        {error && (
          <p role="alert" className="text-crimson-text border-hairline border-t px-3 py-2 text-[12px]">
            {error}
          </p>
        )}
      </div>
    </>
  );
}

function Section({ label, tour, children }: { label: string; tour?: string; children: React.ReactNode }) {
  return (
    <div data-tour={tour} className="mt-1 first:mt-0">
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
