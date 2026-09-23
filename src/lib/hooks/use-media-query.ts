"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * Matches a media query on the client. False during SSR and hydration so the
 * markup is stable; the real value follows on the client.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}
