"use client";

import { useEffect, useRef, useState } from "react";

export interface Account {
  login: string;
  name: string | null;
  avatarUrl: string | null;
  /** False in local mode, where there is no sign-in and so no sign-out. */
  signedIn: boolean;
}

/** Who is signed in, with the way to Settings and out. */
export function AccountMenu({ account }: { account: Account }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const label = account.name ?? account.login;
  const item =
    "flex h-9 w-full items-center rounded-md px-2.5 text-left text-[13px] text-ink hover:bg-cream";

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account: ${label}`}
        className="border-line bg-cream inline-flex size-11 items-center justify-center overflow-hidden rounded-full border md:size-9"
      >
        {account.avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={account.avatarUrl} alt="" className="size-full object-cover" />
        ) : (
          <span className="text-ink text-[13px] font-semibold uppercase">
            {label.slice(0, 1)}
          </span>
        )}
      </button>

      {open && (
        <div
          role="menu"
          className="bg-card border-line shadow-lift absolute top-full right-0 z-50 mt-2 w-56 rounded-lg border p-1"
        >
          <div className="border-hairline mb-1 border-b px-2.5 pt-1.5 pb-2">
            <p className="text-ink truncate text-[13px] font-semibold">{label}</p>
            {account.signedIn && (
              <p className="text-muted truncate font-mono text-[11px]">@{account.login}</p>
            )}
          </div>
          <a role="menuitem" href="/settings" className={item}>
            Settings
          </a>
          {account.signedIn && (
            <form method="post" action="/api/auth/logout">
              <button role="menuitem" type="submit" className={item}>
                Sign out
              </button>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
