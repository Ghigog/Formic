"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import type { RunnerSetup } from "@/lib/runner/setup";

/** A secret that column CLI agents sign in with, which they cannot run without in the repository's Actions secrets. */
export interface KeylessAgent {
  /** The agents that sign in with this secret. */
  names: string[];
  keyName: string;
  secretName: string;
}

const ackKey = (repoFullName: string) => `formic:secrets-ack:${repoFullName}`;

const ackChanged = "formic:secrets-ack";

/** The secrets this person has said they added, as saved text; Formic cannot see them. */
function readAcked(repoFullName: string): string {
  try {
    return localStorage.getItem(ackKey(repoFullName)) ?? "[]";
  } catch {
    return "[]";
  }
}

function parseAcked(saved: string): string[] {
  try {
    const raw: unknown = JSON.parse(saved);
    return Array.isArray(raw) ? raw.filter((n): n is string => typeof n === "string") : [];
  } catch {
    return [];
  }
}

function watchAcked(onChange: () => void) {
  window.addEventListener("storage", onChange);
  window.addEventListener(ackChanged, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(ackChanged, onChange);
  };
}

/**
 * What a person has to do before agents can run in their repository: merge
 * the pull request that installs Formic's workflow, then add the secrets the
 * agents sign in with. Shown as the board loads, not as a card's error once
 * they have already asked an agent for something. Once the workflow is
 * merged it comes back for any secret not yet marked as added, since Formic
 * never reads the repository's secrets and cannot tell.
 */
export function SetupDialog({
  setup,
  repoName,
  repoFullName,
  keyless,
  onRetry,
}: {
  setup: RunnerSetup | null;
  repoName: string;
  repoFullName: string;
  keyless: KeylessAgent[];
  onRetry: () => void;
}) {
  const [hidden, setHidden] = useState(false);
  // Null on the server and until the browser answers: nothing is asked before then.
  const saved = useSyncExternalStore(
    watchAcked,
    () => readAcked(repoFullName),
    () => null,
  );
  const acked = saved === null ? null : parseAcked(saved);
  const titleId = useId();
  const primary = useRef<HTMLAnchorElement & HTMLButtonElement>(null);
  const pending = acked ? keyless.filter((k) => !acked.includes(k.secretName)) : [];
  const secretsOnly = setup?.state === "ready";
  const needed = !!setup && (secretsOnly ? pending.length > 0 : true);
  const open = needed && !hidden;

  const markAdded = () => {
    const next = [...new Set([...(acked ?? []), ...pending.map((k) => k.secretName)])];
    try {
      localStorage.setItem(ackKey(repoFullName), JSON.stringify(next));
    } catch {}
    window.dispatchEvent(new Event(ackChanged));
  };

  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => primary.current?.focus());
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setHidden(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!setup || !needed) return null;

  if (hidden) {
    return (
      <button
        type="button"
        onClick={() => setHidden(false)}
        className="bg-card border-line text-ink fixed bottom-16 left-4 z-50 flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-medium shadow-sm"
      >
        <span aria-hidden className="bg-clay pulse-dot size-1.5 rounded-full" />
        {secretsOnly
          ? "Agent secrets not added"
          : setup.state === "waiting"
            ? "Setup pull request waiting"
            : "Agents can't run yet"}
      </button>
    );
  }

  const merging = setup.state === "waiting" ? setup : null;
  const title = secretsOnly
    ? "Add your agents' secrets"
    : setup.state === "blocked"
      ? `Formic can't set up ${repoName} yet`
      : merging?.update
        ? "Formic's agent workflow changed"
        : `Getting ${repoName} ready`;

  return (
    <div className="fixed inset-0 z-[120] flex items-end justify-center bg-[color-mix(in_srgb,var(--anthracite)_32%,transparent)] p-0 backdrop-blur-[3px] motion-safe:animate-[reqFade_160ms_ease-out] sm:items-center sm:p-6">
      <div
        role="dialog"
        aria-modal
        aria-labelledby={titleId}
        className="bg-card border-line box-border flex max-h-[92dvh] w-full max-w-[480px] flex-col gap-4 overflow-y-auto rounded-t-xl border p-5 shadow-[0_30px_60px_-24px_color-mix(in_srgb,var(--anthracite)_45%,transparent)] motion-safe:animate-[reqPop_240ms_cubic-bezier(.2,.9,.3,1.15)] sm:rounded-xl"
      >
        <h2 id={titleId} className="text-ink m-0 text-[16px] font-semibold">
          {title}
        </h2>

        {setup.state === "blocked" ? (
          <p className="text-muted m-0 text-[13px] leading-[1.6]">{setup.reason}</p>
        ) : (
          <>
            <p className="text-muted m-0 text-[13px] leading-[1.6]">
              {secretsOnly
                ? `${repoName}'s agents sign in with secrets stored on GitHub. Until they are added, an agent's run stops straight away.`
                : merging?.update
                  ? `Merge this update to ${repoName} so its agents keep running.`
                  : "Agents run in this repository's own GitHub Actions. That takes one workflow file, which you merge yourself because it runs with the repository's secrets."}
            </p>
            <ol className="m-0 flex list-none flex-col gap-2.5 p-0 text-[13px]">
              {!secretsOnly && (
              <Step n={1} label="Merge the setup pull request">
                <a
                  ref={primary}
                  href={merging?.setupUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="bg-terracotta-cta inline-flex h-[30px] items-center rounded-lg px-3 text-[12px] font-semibold whitespace-nowrap text-white hover:opacity-90"
                >
                  Open pull request ↗
                </a>
              </Step>
              )}
              {(secretsOnly ? pending : keyless).map((agent, i) => (
                <Step key={agent.secretName} n={i + (secretsOnly ? 1 : 2)} label={`Add a secret for ${agent.names.join(", ")}`}>
                  <p className="text-muted m-0 text-[12px] leading-[1.5]">
                    Name it exactly this. The value is the {agent.keyName}.
                  </p>
                  <SecretName value={agent.secretName} />
                </Step>
              ))}
            </ol>
            {(secretsOnly ? pending : keyless).length > 0 && (
              <p className="text-muted m-0 text-[12px] leading-[1.6]">
                On GitHub, choose New repository secret in{" "}
                <a
                  href={`https://github.com/${repoFullName}/settings/secrets/actions`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-ink underline"
                >
                  your repository&apos;s Actions secrets
                </a>
                , then paste the name and the value. Formic keeps only the name, never the value. Agents can share a secret or each use their own: choose in the agent&apos;s settings.
              </p>
            )}
            {!merging?.update && !secretsOnly && (
              <p className="text-muted m-0 text-[12px] leading-[1.6]">
                Your first ticket is waiting in To Do: an AGENTS.md that tells every agent how this codebase is
                built and tested. Start it once the pull request is merged.
              </p>
            )}
          </>
        )}

        <div className="flex items-center gap-2">
          {setup.state === "waiting" && (
            <span className="text-muted flex items-center gap-1.5 text-[11px]">
              <span aria-hidden className="bg-clay pulse-dot size-1.5 rounded-full" />
              Watching for the merge
            </span>
          )}
          <div className="flex-grow" />
          {secretsOnly && (
            <button
              ref={primary}
              type="button"
              onClick={markAdded}
              className="bg-terracotta-cta h-[34px] rounded-lg px-3.5 text-[13px] font-semibold text-white hover:opacity-90"
            >
              I&apos;ve added them
            </button>
          )}
          {setup.state === "blocked" && (
            <button
              ref={primary}
              type="button"
              onClick={onRetry}
              className="bg-terracotta-cta h-[34px] rounded-lg px-3.5 text-[13px] font-semibold text-white hover:opacity-90"
            >
              Try again
            </button>
          )}
          <button
            type="button"
            onClick={() => setHidden(true)}
            className="border-line bg-card text-ink h-[34px] rounded-lg border px-3 text-[13px] font-medium active:scale-[0.96]"
          >
            Not now
          </button>
        </div>
      </div>
    </div>
  );
}

function Step({ n, label, children }: { n: number; label: string; children?: React.ReactNode }) {
  return (
    <li className="border-line flex items-start gap-3 rounded-lg border px-3 py-2.5">
      <span className="bg-cream text-muted mt-px inline-flex size-5 shrink-0 items-center justify-center rounded-full font-mono text-[11px]">
        {n}
      </span>
      <div className="flex min-w-0 flex-1 flex-col items-start gap-2">
        <span className="text-ink font-medium">{label}</span>
        {children}
      </div>
    </li>
  );
}

function SecretName({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };
  return (
    <div className="flex w-full flex-col gap-1.5">
      <code className="bg-cream text-ink w-full rounded-md px-2 py-1.5 font-mono text-[11px] leading-[1.5] break-all">
        {value}
      </code>
      <button
        type="button"
        onClick={copy}
        className="border-line bg-card text-ink h-[28px] self-start rounded-md border px-2.5 text-[12px] font-medium active:scale-[0.96]"
      >
        {copied ? "Copied" : "Copy name"}
      </button>
    </div>
  );
}
