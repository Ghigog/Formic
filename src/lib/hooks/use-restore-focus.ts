"use client";

import { useEffect, useRef } from "react";

/** Returns focus to the control that opened a dialog once it closes (or unmounts while open). */
export function useRestoreFocus(open: boolean) {
  const opener = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      const el = opener.current;
      opener.current = null;
      if (el?.isConnected) el.focus();
    };
  }, [open]);
}
