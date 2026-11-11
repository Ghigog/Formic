"use client";

import { useFocusTrap } from "@/lib/hooks/use-focus-trap";
import { useActiveTour } from "@/components/onboarding/store";
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import type { RunnerSetup } from "@/lib/runner/setup";
import {
  agentSecretsName,
  agentSecretsUrl,
  changeRequestName,
  ciName,
  hostName,
  repoHost,
  runnerFileName,
  type RepoHost,
} from "@/lib/vcs/host";
import { BillingNote, useActionsMachines } from "@/components/settings/runner-section";

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
  onApprove,
}: {
  setup: RunnerSetup | null;
  repoName: string;
  repoFullName: string;
  keyless: KeylessAgent[];
  onRetry: () => void;
  /** The person's yes to running agents in GitHub Actions: opens the setup pull request. */
  onApprove: () => Promise<void>;
}) {
  const [hidden, setHidden] = useState(false);
  const [approving, setApproving] = useState(false);
  // Null on the server and until the browser answers: nothing is asked before then.
  const saved = useSyncExternalStore(
    watchAcked,
    () => readAcked(repoFullName),
    () => null,
  );
  const acked = saved === null ? null : parseAcked(saved);
  const titleId = useId();
  const primary = useRef<HTMLAnchorElement & HTMLButtonElement>(null);
  // The guided tour goes first: setup can wait the minute it takes.
  const touring = useActiveTour() !== null;
  const pending = acked ? keyless.filter((k) => !acked.includes(k.secretName)) : [];
  const secretsOnly = setup?.state === "ready";
  const needed = !!setup && (secretsOnly ? pending.length > 0 : true);
  const open = needed && !hidden && !touring;
  // Asked once, while the repository is first being set up: running agents
  // in a private one costs Actions minutes, and this is the moment to say so.
  const machines = useActionsMachines(open && setup?.state === "waiting" && !setup.update);

  // Set when a person puts the dialog away, so the reopen pill takes focus. The
  // dialog opens by itself, so there is no opener for useRestoreFocus to return
  // to, and the pill that reopens it is gone by the time it closes again.
  const focusPill = useRef(false);
  const dismiss = useCallback(() => {
    focusPill.current = true;
    setHidden(true);
  }, []);
  const reopen = () => setHidden(false);

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
  }, [open]);
  const trapKeys = useFocusTrap({ onEscape: dismiss });

  if (!setup || !needed || touring) return null;

  if (hidden) {
    return (
      <button
        type="button"
        ref={(el) => {
          if (el && focusPill.current) {
            focusPill.current = false;
            el.focus();
          }
        }}
        onClick={reopen}
        className="bg-card border-line text-ink fixed bottom-16 left-4 z-50 flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-medium shadow-sm"
      >
        <span aria-hidden className="bg-clay pulse-dot size-1.5 rounded-full" />
        {secretsOnly
          ? "Agent secrets not added"
          : setup.state === "ask"
            ? "Agents need your OK"
            : setup.state === "waiting"
            ? `Setup ${changeRequestName(repoHost(repoFullName))} waiting`
            : "Agents can't run yet"}
      </button>
    );
  }

  const merging = setup.state === "waiting" ? setup : null;
  const asking = setup.state === "ask" ? setup : null;
  const host = repoHost(repoFullName);
  const cr = changeRequestName(host);
  const approve = async () => {
    setApproving(true);
    try {
      await onApprove();
    } finally {
      setApproving(false);
    }
  };
  const title = secretsOnly
    ? "Add your agents' secrets"
    : asking
      ? `Let agents work on ${repoName}`
      : setup.state === "blocked"
      ? `Formic can't set up ${repoName} yet`
      : merging?.update
        ? host === "gitlab"
          ? "Formic's agent job changed"
          : "Formic's agent workflow changed"
        : `Getting ${repoName} ready`;

  return (
    <div className="fixed inset-0 z-[120] flex items-end justify-center bg-[color-mix(in_srgb,var(--anthracite)_32%,transparent)] p-0 backdrop-blur-[3px] motion-safe:animate-[reqFade_160ms_ease-out] sm:items-center sm:p-6">
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
      <div
        role="dialog"
        aria-modal
        onKeyDown={trapKeys}
        aria-labelledby={titleId}
        className="bg-card border-line box-border flex max-h-[92dvh] w-full max-w-[480px] flex-col gap-4 overflow-y-auto rounded-t-xl border p-5 shadow-[0_30px_60px_-24px_color-mix(in_srgb,var(--anthracite)_45%,transparent)] motion-safe:animate-[reqPop_240ms_cubic-bezier(.2,.9,.3,1.15)] sm:rounded-xl"
      >
        <h2 id={titleId} className="text-ink m-0 text-[15px] font-semibold">
          {title}
        </h2>

        {asking ? (
          <AskBody plans={asking.plans} host={host} />
        ) : setup.state === "blocked" ? (
          <p className="text-muted m-0 text-[13px] leading-[1.6]">{setup.reason}</p>
        ) : (
          <>
            <p className="text-muted m-0 text-[13px] leading-[1.6]">
              {secretsOnly
                ? `${repoName}'s agents sign in with secrets stored on ${hostName(host)}. Until they are added, an agent's run stops straight away.`
                : merging?.update
                  ? `Merge this update to ${repoName} so its agents keep running.`
                  : `Agents run in this repository's own ${ciName(host)}. That takes one ${runnerFileName(host)}, which you merge yourself because it runs with the repository's secrets.`}
            </p>
            <ol className="m-0 flex list-none flex-col gap-2.5 p-0 text-[13px]">
              {!secretsOnly && (
              <Step n={1} label={`Merge the setup ${cr}`}>
                <a
                  ref={primary}
                  href={merging?.setupUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="bg-cta inline-flex h-8 items-center rounded-lg px-3 text-[12px] font-semibold whitespace-nowrap text-white hover:opacity-90"
                >
                  Open {cr} ↗
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
                {host === "gitlab" ? "On GitLab, choose Add variable in" : "On GitHub, choose New repository secret in"}{" "}
                <a href={agentSecretsUrl(repoFullName)} target="_blank" rel="noreferrer" className="text-ink underline">
                  your repository&apos;s {agentSecretsName(host)}
                </a>
                , then paste the name and the value{host === "gitlab" ? ", and mark it Masked" : ""}. Formic keeps only the name, never the value. Agents can share a secret or each use their own: choose in the agent&apos;s settings.
              </p>
            )}
            {host === "github" && !merging?.update && !secretsOnly && machines?.repoFullName && (
              <BillingNote repoFullName={machines.repoFullName} isPrivate={machines.private} settingsLink />
            )}
            {!merging?.update && !secretsOnly && (
              <p className="text-muted m-0 text-[12px] leading-[1.6]">
                Your first ticket is waiting in To Do: an AGENTS.md that tells every agent how this codebase is
                built and tested. Start it once the {cr} is merged.
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
          {asking && (
            <button
              ref={primary}
              type="button"
              onClick={() => void approve()}
              disabled={approving}
              className="bg-cta h-9 rounded-lg px-3.5 text-[13px] font-semibold text-white hover:opacity-90 disabled:opacity-60"
            >
              {approving ? "Opening…" : `Open the setup ${cr}`}
            </button>
          )}
          {secretsOnly && (
            <button
              ref={primary}
              type="button"
              onClick={markAdded}
              className="bg-cta h-9 rounded-lg px-3.5 text-[13px] font-semibold text-white hover:opacity-90"
            >
              I&apos;ve added them
            </button>
          )}
          {setup.state === "blocked" && (
            <button
              ref={primary}
              type="button"
              onClick={onRetry}
              className="bg-cta h-9 rounded-lg px-3.5 text-[13px] font-semibold text-white hover:opacity-90"
            >
              Try again
            </button>
          )}
          <button
            type="button"
            onClick={dismiss}
            className="border-line bg-card text-ink h-9 rounded-lg border px-3 text-[13px] font-medium active:scale-[0.96]"
          >
            Not now
          </button>
        </div>
      </div>
    </div>
  );
}

/** Why Formic asks for GitHub Actions, and the way round it for people who know E2B. */
function AskBody({ plans, host }: { plans: boolean; host: RepoHost }) {
  return (
    <>
      <p className="text-muted m-0 text-[13px] leading-[1.6]">
        Your agents work in this repository&apos;s own {ciName(host)}, with your {hostName(host)} access. To allow
        that, Formic opens one {changeRequestName(host)} that adds a {runnerFileName(host)}. Nothing runs until you
        merge it.
      </p>
      {host === "gitlab" && (
        <p className="text-muted m-0 text-[12px] leading-[1.6]">
          Formic also lets this project&apos;s jobs push with their own token, and lets developers run pipelines with
          variables. Changing those takes a Maintainer.
        </p>
      )}
      {plans ? (
        <p className="text-muted m-0 text-[12px] leading-[1.6]">
          Claude Code, Codex and Gemini CLI run on your own plan, which only works in {ciName(host)}.
        </p>
      ) : (
        <E2bAlternative host={host} />
      )}
    </>
  );
}

/**
 * The way round GitHub Actions, for people who know E2B. The note opens in
 * the dialog's flow, not floating: a floating one is cut off by the dialog's
 * scrolling box on a short screen.
 */
function E2bAlternative({ host }: { host: RepoHost }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-muted m-0 text-[12px] leading-[1.6]">
        Rather not use {ciName(host)}?{" "}
        <a href="/settings#sandbox" className="text-ink underline">
          Bring your own E2B key
        </a>{" "}
        instead.{" "}
        <button
          type="button"
          aria-label="What is E2B?"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen(!open)}
          className={`border-line inline-flex size-[18px] items-center justify-center rounded-full border align-middle font-serif text-[11px] leading-none font-semibold italic ${
            open ? "bg-anthracite text-on-anthracite" : "bg-card text-muted"
          }`}
        >
          i
        </button>
      </p>
      {open && (
        <p id={id} className="border-line bg-cream text-ink m-0 rounded-lg border px-3 py-2.5 text-[11px] leading-[1.5]">
          E2B (e2b.dev) runs each agent in a short-lived cloud sandbox instead of your {ciName(host)}, so your
          repository needs no {runnerFileName(host)}. You need your own E2B account and API key, and you pay E2B for the time
          your agents run. It works for agents on API keys only: Claude Code, Codex and Gemini CLI run on your plan in
          {ciName(host)}.
        </p>
      )}
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
        className="border-line bg-card text-ink h-8 self-start rounded-lg border px-2.5 text-[12px] font-medium active:scale-[0.96]"
      >
        {copied ? "Copied" : "Copy name"}
      </button>
    </div>
  );
}

/**
 * The setup pull request as the first card in To Do, while it waits: the
 * starter tickets below it cannot run until it is merged, so it stays in
 * view after the dialog is put away. Gone once the workflow is in.
 */
export function SetupCard({
  setup,
  repoName,
  repoFullName = "",
  onRetry,
  onApprove,
}: {
  setup: RunnerSetup | null;
  repoName: string;
  /** Which host it is on: GitHub when omitted. */
  repoFullName?: string;
  onRetry: () => void;
  onApprove: () => void;
}) {
  if (!setup || setup.state === "ready") return null;
  const host = repoHost(repoFullName);
  const cr = changeRequestName(host);
  if (setup.state === "ask") {
    return (
      <div
        data-testid="setup-card"
        className="border-terracotta/50 bg-card mt-2 flex flex-col gap-1.5 rounded-lg border border-dashed px-3 py-2.5"
      >
        <span className="text-muted font-mono text-[10px] tracking-[0.06em] uppercase">Start here</span>
        <span className="text-ink text-[13px] leading-[1.4] font-semibold">Let agents work on {repoName}</span>
        <span className="text-muted text-[12px] leading-[1.5]">
          Agents run in {repoName}&apos;s own {ciName(host)}. Formic opens one {cr} for you to merge.
        </span>
        <div className="mt-0.5">
          <button
            type="button"
            onClick={onApprove}
            className="bg-cta inline-flex h-8 items-center rounded-lg px-2.5 text-[12px] font-semibold text-white hover:opacity-90"
          >
            Open the setup {cr}
          </button>
        </div>
      </div>
    );
  }
  const blocked = setup.state === "blocked";
  return (
    <div
      data-testid="setup-card"
      className="border-terracotta/50 bg-card mt-2 flex flex-col gap-1.5 rounded-lg border border-dashed px-3 py-2.5"
    >
      <span className="text-muted font-mono text-[10px] tracking-[0.06em] uppercase">Start here</span>
      <span className="text-ink text-[13px] leading-[1.4] font-semibold">
        {blocked
          ? `Formic can't set up ${repoName} yet`
          : setup.update
            ? "Merge the agent workflow update"
            : `Merge the setup ${cr}`}
      </span>
      <span className="text-muted text-[12px] leading-[1.5]">
        {blocked
          ? setup.reason
          : `Agents run in ${repoName}'s own ${ciName(host)}. The tickets below wait for this one ${runnerFileName(host)}.`}
      </span>
      <div className="mt-0.5 flex items-center gap-2">
        {blocked ? (
          <button
            type="button"
            onClick={onRetry}
            className="bg-cta inline-flex h-8 items-center rounded-lg px-2.5 text-[12px] font-semibold text-white hover:opacity-90"
          >
            Try again
          </button>
        ) : (
          <>
            <a
              href={setup.setupUrl}
              target="_blank"
              rel="noreferrer"
              className="bg-cta inline-flex h-8 items-center rounded-lg px-2.5 text-[12px] font-semibold whitespace-nowrap text-white hover:opacity-90"
            >
              Open {cr} ↗
            </a>
            <span className="text-muted flex items-center gap-1.5 text-[11px]">
              <span aria-hidden className="bg-clay pulse-dot size-1.5 rounded-full" />
              Watching for the merge
            </span>
          </>
        )}
      </div>
    </div>
  );
}
