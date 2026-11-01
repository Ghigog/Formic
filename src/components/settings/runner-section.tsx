"use client";

import { useEffect, useState } from "react";
import type { MachinesResponse } from "@/app/api/runner/machines/route";
import { RUNNER_LABEL_VAR } from "@/lib/toolchains/actions";

/** The label a runner GitHub's setup page registers always carries. */
export const SELF_HOSTED_LABEL = "self-hosted";

/** Where the active board's Actions jobs run, read once; null until GitHub answers. */
export function useActionsMachines(enabled = true): MachinesResponse | null {
  const [machines, setMachines] = useState<MachinesResponse | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    fetch("/api/runner/machines")
      .then((r) => (r.ok ? (r.json() as Promise<MachinesResponse>) : null))
      .then((m) => {
        if (live && m) setMachines(m);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [enabled]);
  return machines;
}

/**
 * Where agents run, and what that costs. A private repository's Actions
 * minutes count against its owner's GitHub plan; a machine of their own
 * (a self-hosted runner) costs none. Formic cannot register one for them:
 * this links to the two places on GitHub that do, and shows what is there.
 */
export function RunnerSection() {
  const machines = useActionsMachines();
  const repo = machines?.repoFullName;

  return (
    <section id="runner" data-tour="settings-runner" className="bg-card border-line scroll-mt-4 rounded-xl border p-4">
      <h2 className="text-ink mb-3 text-[11px] font-semibold tracking-[0.1em] uppercase">Runner</h2>
      {!machines ? (
        <p className="text-muted m-0 text-[12px]">Checking where agents run…</p>
      ) : !repo ? (
        <p className="text-muted m-0 text-[12px] leading-[1.5]">
          This board has no repository, so no agent runs on GitHub.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          <BillingNote repoFullName={repo} isPrivate={machines.private} />
          <p className="text-ink m-0 text-[12px] font-medium">Run agents on your own machine</p>
          <ol className="m-0 flex list-none flex-col gap-2.5 p-0 text-[12px]">
            <Step n={1} label="Add a runner on GitHub">
              <p className="text-muted m-0 leading-[1.5]">
                Choose Linux or macOS (on Windows, add it inside WSL, which is Linux), then paste the commands
                GitHub shows on the machine. Run <code className="font-mono">./svc.sh install</code> afterwards so
                it starts with the machine.
              </p>
              <ExternalLink href={`https://github.com/${repo}/settings/actions/runners/new`}>
                New self-hosted runner ↗
              </ExternalLink>
            </Step>
            <Step n={2} label="Point Formic at it">
              <p className="text-muted m-0 leading-[1.5]">
                Add a repository variable with this name, and the value{" "}
                <code className="font-mono">{SELF_HOSTED_LABEL}</code>.
              </p>
              <Copyable value={RUNNER_LABEL_VAR} />
              <ExternalLink href={`https://github.com/${repo}/settings/variables/actions/new`}>
                New repository variable ↗
              </ExternalLink>
            </Step>
          </ol>
          <Runners runners={machines.runners} />
          <p className="text-muted m-0 text-[11px] leading-[1.5]">
            While the machine is off, runs wait for it. To go back to GitHub&apos;s machines, delete the variable.
          </p>
        </div>
      )}
    </section>
  );
}

/** What running agents in this repository costs. Shared with the setup dialog. */
export function BillingNote({
  repoFullName,
  isPrivate,
  settingsLink = false,
}: {
  repoFullName: string;
  isPrivate: boolean | null;
  /** In the setup dialog: link to the Runner settings rather than explain them. */
  settingsLink?: boolean;
}) {
  const name = repoFullName.split("/").pop();
  if (isPrivate === null) return null;
  if (!isPrivate) {
    return (
      <p className="text-muted m-0 text-[12px] leading-[1.6]">
        {name} is public, so its Actions minutes are free.
      </p>
    );
  }
  return (
    <p className="bg-cream text-muted m-0 rounded-lg px-3 py-2.5 text-[12px] leading-[1.6]">
      <span className="text-ink font-medium">Please note:</span> {name} is private, so agent runs use Actions
      minutes from your GitHub plan, and minutes past its free allowance are billed. If you have no billing plan
      and expect to go over, consider making the repository public or{" "}
      {settingsLink ? (
        <a href="/settings#runner" className="text-ink underline">
          setting up a self-hosted runner
        </a>
      ) : (
        "setting up a self-hosted runner below"
      )}
      . You can also{" "}
      <a href="https://github.com/settings/billing" target="_blank" rel="noreferrer" className="text-ink underline">
        set a spending limit
      </a>
      .
    </p>
  );
}

function Runners({ runners }: { runners: MachinesResponse["runners"] }) {
  if (runners === null) {
    return <p className="text-muted m-0 text-[12px]">Formic can&apos;t see this repository&apos;s runners.</p>;
  }
  const own = runners.filter((r) => r.labels.includes(SELF_HOSTED_LABEL));
  if (own.length === 0) return <p className="text-muted m-0 text-[12px]">No runner added yet.</p>;
  return (
    <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[12px]">
      {own.map((r) => (
        <li key={r.name} className="text-ink flex items-center gap-2">
          <span
            aria-hidden
            className={`size-1.5 rounded-full ${r.online ? "bg-jade" : "bg-idle"}`}
          />
          <span className="font-mono">{r.name}</span>
          <span className="text-muted">{!r.online ? "Offline" : r.busy ? "Running a job" : "Online"}</span>
        </li>
      ))}
    </ul>
  );
}

function Step({ n, label, children }: { n: number; label: string; children: React.ReactNode }) {
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

function ExternalLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="border-line bg-card text-ink inline-flex h-[28px] items-center rounded-md border px-2.5 text-[12px] font-medium"
    >
      {children}
    </a>
  );
}

function Copyable({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };
  return (
    <div className="flex items-center gap-2">
      <code className="bg-cream text-ink rounded-md px-2 py-1 font-mono text-[11px]">{value}</code>
      <button
        type="button"
        onClick={copy}
        className="border-line bg-card text-ink h-[26px] rounded-md border px-2 text-[11px] font-medium active:scale-[0.96]"
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
