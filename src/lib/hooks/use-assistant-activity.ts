"use client";

import { useEffect, useState } from "react";

const POLL_MS = 60_000;
const SEEN_KEY = "formic.assistant-seen";

export interface ProjectActivity {
  id: string;
  lastAssistantMessage?: { id: string } | null;
}

/** Project id to the last finished assistant message the person has seen there. */
type Seen = Record<string, string>;

export function readSeen(): Seen {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(SEEN_KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? (parsed as Seen) : {};
  } catch {
    return {};
  }
}

function writeSeen(seen: Seen) {
  try {
    window.localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
  } catch {
    // Storage full or blocked: the badge just comes back next time.
  }
}

/** Mark a project's latest answer seen. */
export function markSeen(project: ProjectActivity) {
  const id = project.lastAssistantMessage?.id;
  if (id) writeSeen({ ...readSeen(), [project.id]: id });
}

/** The other projects whose latest finished assistant message hasn't been seen. */
export function unseenProjects(
  projects: ProjectActivity[],
  activeId: string | null,
  seen: Seen,
): string[] {
  return projects
    .filter((p) => p.id !== activeId && p.lastAssistantMessage && seen[p.id] !== p.lastAssistantMessage.id)
    .map((p) => p.id);
}

/**
 * Which other projects have an assistant answer waiting, polled. The active
 * project's own answers count as seen as they arrive.
 */
export function useAssistantActivity(): { count: number; unseen: string[] } {
  const [unseen, setUnseen] = useState<string[]>([]);

  useEffect(() => {
    let live = true;
    const apply = (found: string[] | null) => {
      if (live && found) setUnseen(found);
    };
    void load().then(apply);
    const timer = setInterval(() => {
      if (document.visibilityState !== "hidden") void load().then(apply);
    }, POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);

  return { count: unseen.length, unseen };
}

async function load(): Promise<string[] | null> {
  const res = await fetch("/api/projects", { cache: "no-store" }).catch(() => null);
  const body = (await res?.json().catch(() => null)) as {
    active?: { id: string } | null;
    projects?: ProjectActivity[];
  } | null;
  if (!body?.projects) return null;
  const activeId = body.active?.id ?? null;
  const current = body.projects.find((p) => p.id === activeId);
  if (current) markSeen(current);
  return unseenProjects(body.projects, activeId, readSeen());
}
