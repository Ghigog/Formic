"use client";

import dynamic from "next/dynamic";
import { useColony } from "@/components/colony/colony";

/**
 * The Sentinels page and its portraits are a big chunk most people never
 * open, so it is fetched on first open. While it loads, the real overlay
 * surface shows "Loading…" (DESIGN.md, States), so nothing jumps when it lands.
 */
const SentinelsPage = dynamic(() => import("./sentinels").then((m) => m.SentinelsPage), {
  ssr: false,
  loading: () => (
    <div
      role="region"
      aria-label="Sentinels"
      aria-busy="true"
      className="bg-cream fixed top-14 right-0 bottom-14 left-0 z-[60] box-border overflow-x-hidden overflow-y-auto overscroll-none px-4 pt-5 pb-6 md:top-16 md:px-6"
    >
      <p className="text-muted m-0 text-[13px]">Loading…</p>
    </div>
  ),
});

/** The dialog is small and decides for itself whether to open, so it only loads off the first paint. */
export const UnlockAllDialog = dynamic(() => import("./unlock-all-dialog").then((m) => m.UnlockAllDialog), {
  ssr: false,
});

/** Renders the Sentinels page only once it is open, so the chunk is never fetched otherwise. */
export function LazySentinelsPage(props: { repoName: string; onOpenEpic: (epicId: string) => void }) {
  const c = useColony();
  if (!c?.sentinelsOpen) return null;
  return <SentinelsPage {...props} />;
}
