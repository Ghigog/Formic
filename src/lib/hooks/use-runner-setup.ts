"use client";

import { useCallback, useEffect, useState } from "react";
import type { FormicEvent } from "@/lib/domain/events";
import type { RunnerSetup } from "@/lib/runner/setup";

/** While the pull request waits, how often to look again. The webhook is usually first. */
const POLL_MS = 15_000;

type Subscribe = (listener: (event: FormicEvent, seq: number) => void) => () => void;

async function load(): Promise<RunnerSetup | null> {
  const res = await fetch("/api/runner/setup", { cache: "no-store" }).catch(() => null);
  const body = (await res?.json().catch(() => null)) as RunnerSetup | null;
  return body?.state ? body : null;
}

/**
 * Whether this board's repository can run CLI agents yet. Asked on load,
 * then again while the setup pull request waits: on the merge webhook, on a
 * timer in case that never arrives, and when the person comes back to the
 * tab from GitHub.
 */
export function useRunnerSetup(subscribe: Subscribe): {
  setup: RunnerSetup | null;
  check: () => Promise<void>;
} {
  const [setup, setSetup] = useState<RunnerSetup | null>(null);

  const apply = useCallback((next: RunnerSetup | null) => {
    if (next) setSetup(next);
  }, []);
  const check = useCallback(() => load().then(apply), [apply]);

  useEffect(() => {
    void load().then(apply);
  }, [apply]);

  const waiting = setup?.state === "waiting";
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => void check(), POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [waiting, check]);

  useEffect(
    () =>
      subscribe((event) => {
        if (event.type === "runner.ready") setSetup({ state: "ready" });
      }),
    [subscribe],
  );

  return { setup, check };
}
