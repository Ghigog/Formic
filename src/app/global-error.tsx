"use client";

import "./globals.css";

/** Replaces the root layout when it fails, so it renders its own html and body. */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body className="bg-cream text-ink min-h-dvh">
        <main className="flex min-h-dvh items-center justify-center p-4">
          <div className="bg-card border-line flex w-full max-w-sm flex-col gap-3 rounded-xl border p-5">
            <h1 className="font-serif text-[22px] font-semibold">Something went wrong</h1>
            <p className="text-muted text-[13px]">
              Formic failed to load. Try again; if it keeps happening, let us know.
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
          </div>
        </main>
      </body>
    </html>
  );
}
