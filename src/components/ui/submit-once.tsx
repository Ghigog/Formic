"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * A plain form's submit button that says it is working and can't be pressed
 * twice. Sending a sign-in email takes a few seconds; without this, the page
 * looks stuck, and every extra press sends another link until the rate
 * limit refuses them.
 *
 * Works on a server-rendered form posting to a route: it only listens for
 * the form's submit, and lets the browser do the rest. Coming back to the
 * page (the back button's cache) makes it pressable again.
 */
export function SubmitOnce({
  children,
  pending,
  className,
  autoFocus,
}: {
  children: ReactNode;
  /** What the button says while the form is on its way. */
  pending: string;
  className?: string;
  autoFocus?: boolean;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const form = ref.current?.form;
    if (!form) return;
    const onSubmit = (e: SubmitEvent) => {
      if (busy) {
        e.preventDefault();
        return;
      }
      setBusy(true);
    };
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) setBusy(false);
    };
    form.addEventListener("submit", onSubmit);
    window.addEventListener("pageshow", onShow);
    return () => {
      form.removeEventListener("submit", onSubmit);
      window.removeEventListener("pageshow", onShow);
    };
  }, [busy]);

  return (
    <button
      ref={ref}
      type="submit"
      autoFocus={autoFocus}
      aria-disabled={busy}
      // Not `disabled`: a button disabled during its own submit event can
      // drop out of the submission in some browsers. The submit handler
      // stops a second one instead.
      className={`${className ?? ""} ${busy ? "cursor-wait opacity-70" : ""}`}
    >
      {busy ? pending : children}
    </button>
  );
}
