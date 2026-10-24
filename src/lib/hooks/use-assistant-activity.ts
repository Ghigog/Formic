"use client";

import { useEffect, useState } from "react";

const POLL_MS = 60_000;
const SEEN_KEY = "formic.assistant-seen";

const NOTIFICATIONS_SEEN_KEY = "formic.notifications-seen";

export type NotificationKind = "ticketMoved" | "epicCompleted" | "needsAttention";
/** What can be waiting on a board: an assistant answer or a notification. */
export type Waiting = "answer" | NotificationKind;

export interface ProjectActivity {
  id: string;
  lastAssistantMessage?: { id: string } | null;
  /** The latest event of each kind the person has switched on. */
  notifications?: Partial<Record<NotificationKind, { seq: number }>>;
}

/** Project id to the latest event sequence seen there, per kind. */
type SeenNotifications = Record<string, Partial<Record<NotificationKind, number>>>;

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

export function readSeenNotifications(): SeenNotifications {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(NOTIFICATIONS_SEEN_KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? (parsed as SeenNotifications) : {};
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

/** Mark a project's latest answer and notifications seen. */
export function markSeen(project: ProjectActivity) {
  const id = project.lastAssistantMessage?.id;
  if (id) writeSeen({ ...readSeen(), [project.id]: id });
  if (project.notifications) {
    const seen = readSeenNotifications();
    const kinds = { ...seen[project.id] };
    for (const [kind, n] of Object.entries(project.notifications)) {
      kinds[kind as NotificationKind] = n.seq;
    }
    try {
      window.localStorage.setItem(NOTIFICATIONS_SEEN_KEY, JSON.stringify({ ...seen, [project.id]: kinds }));
    } catch {
      // Storage full or blocked: the badge just comes back next time.
    }
  }
}

/** What is waiting on a project that the person hasn't seen. */
export function waitingOn(
  project: ProjectActivity,
  seen: Seen,
  seenNotifications: SeenNotifications = {},
): Waiting[] {
  const waiting: Waiting[] = [];
  if (project.lastAssistantMessage && seen[project.id] !== project.lastAssistantMessage.id) {
    waiting.push("answer");
  }
  for (const [kind, n] of Object.entries(project.notifications ?? {})) {
    if (n.seq > (seenNotifications[project.id]?.[kind as NotificationKind] ?? 0)) {
      waiting.push(kind as NotificationKind);
    }
  }
  return waiting;
}

/** The other projects with an answer or a notification the person hasn't seen. */
export function unseenProjects(
  projects: ProjectActivity[],
  activeId: string | null,
  seen: Seen,
  seenNotifications: SeenNotifications = {},
): string[] {
  return projects
    .filter((p) => p.id !== activeId && waitingOn(p, seen, seenNotifications).length > 0)
    .map((p) => p.id);
}

/**
 * Which other projects have an answer or notification waiting, polled. The active
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
  return unseenProjects(body.projects, activeId, readSeen(), readSeenNotifications());
}
