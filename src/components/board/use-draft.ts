"use client";

import { useCallback, useEffect, useState } from "react";

/** Versioned so a later change to what is stored can start fresh. */
const DRAFT_KEY_PREFIX = "formic:draft:v1:";

function readDraft(scope: string): string {
  try {
    return window.localStorage.getItem(DRAFT_KEY_PREFIX + scope) ?? "";
  } catch {
    return "";
  }
}

function writeDraft(scope: string, value: string): void {
  try {
    if (value) window.localStorage.setItem(DRAFT_KEY_PREFIX + scope, value);
    else window.localStorage.removeItem(DRAFT_KEY_PREFIX + scope);
  } catch {
    // Storage full or blocked: the draft just won't persist.
  }
}

/**
 * Like useState(""), but the unsent text survives a reload or navigating away:
 * it is mirrored to localStorage under `scope` and removed when emptied. It is
 * read after mount so server rendering stays unchanged.
 */
export function useDraft(scope: string): [string, (value: string) => void] {
  const [value, setValue] = useState("");

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reading the browser's storage can only happen after mount
    setValue(readDraft(scope));
  }, [scope]);

  const set = useCallback(
    (next: string) => {
      setValue(next);
      writeDraft(scope, next);
    },
    [scope],
  );

  return [value, set];
}
