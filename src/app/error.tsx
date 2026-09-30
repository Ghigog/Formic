"use client";

import { BUG_REPORT_URL, SUPPORT_EMAIL } from "@/components/board/account-menu";

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="bg-cream flex min-h-dvh items-center justify-center p-4">
      <div className="bg-card border-line flex w-full max-w-sm flex-col gap-3 rounded-xl border p-5">
        <h1 className="font-serif text-[22px] font-semibold">Something went wrong</h1>
        <p className="text-muted text-[13px]">
          This page hit an error. Try again, or report it so we can fix it.
        </p>
        {error.digest && (
          <p className="text-muted font-mono text-[11px]">Reference: {error.digest}</p>
        )}
        <button
          type="button"
          onClick={reset}
          className="bg-terracotta-cta h-10 rounded-lg text-[14px] font-semibold text-white"
        >
          Try again
        </button>
        <p className="text-muted text-[13px]">
          <a href={BUG_REPORT_URL} className="underline" target="_blank" rel="noopener noreferrer">
            Report a bug
          </a>{" "}
          or write to{" "}
          <a href={`mailto:${SUPPORT_EMAIL}`} className="underline">
            {SUPPORT_EMAIL}
          </a>
          .
        </p>
      </div>
    </main>
  );
}
