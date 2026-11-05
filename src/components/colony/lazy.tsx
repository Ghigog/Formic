"use client";

import dynamic from "next/dynamic";
import type { BoardCard } from "@/lib/domain/entities";
import { useColony } from "./colony";
import type { RerouteNotice } from "./overlays";

/** The timeline and the colony overlays load on demand, off the board's first paint. */
const ColonyTimeline = dynamic(() => import("./timeline").then((m) => m.ColonyTimeline), {
  ssr: false,
  loading: () => (
    <div
      role="region"
      aria-label="Timeline"
      aria-busy="true"
      className="bg-cream fixed top-14 right-0 bottom-14 left-0 z-[60] box-border overflow-auto px-6 pt-5 pb-8 md:top-16"
    >
      <p className="text-muted m-0 text-[13px]">Loading…</p>
    </div>
  ),
});
const ColonyToast = dynamic(() => import("./overlays").then((m) => m.ColonyToast), { ssr: false });
const RerouteToast = dynamic(() => import("./overlays").then((m) => m.RerouteToast), { ssr: false });
const EpicWinDialog = dynamic(() => import("./overlays").then((m) => m.EpicWinDialog), { ssr: false });

export function LazyColonyTimeline({ repoName }: { repoName: string }) {
  const c = useColony();
  if (!c?.timelineOpen) return null;
  return <ColonyTimeline repoName={repoName} />;
}

export function LazyColonyToast() {
  const c = useColony();
  if (!c?.toast) return null;
  return <ColonyToast />;
}

export function LazyRerouteToast({ toast }: { toast: RerouteNotice | null }) {
  if (!toast) return null;
  return <RerouteToast toast={toast} />;
}

export function LazyEpicWinDialog({ onOpenEpic }: { onOpenEpic?: (epic: BoardCard) => void }) {
  const c = useColony();
  if (!c?.win) return null;
  return <EpicWinDialog onOpenEpic={onOpenEpic} />;
}
