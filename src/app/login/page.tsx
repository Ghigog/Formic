import { authMode, safeNext } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const { next: rawNext, error } = await searchParams;
  const next = safeNext(rawNext);
  const github = authMode() === "github";

  return (
    <main className="bg-cream flex min-h-dvh items-center justify-center p-4">
      <div className="bg-card border-line flex w-full max-w-sm flex-col gap-3 rounded-xl border p-5">
        <h1 className="font-serif text-[22px] font-semibold">Formic</h1>

        {github ? (
          <>
            <p className="text-muted text-[13px]">
              Sign in with GitHub. Your agents work on the repositories you give
              the Formic app access to, as you.
            </p>
            <a
              href={`/api/auth/github/login?next=${encodeURIComponent(next)}`}
              className="bg-anthracite text-cream inline-flex h-10 items-center justify-center gap-2 rounded-lg text-[14px] font-semibold"
            >
              <GitHubMark />
              Sign in with GitHub
            </a>
          </>
        ) : (
          <form method="post" action="/api/login" className="flex flex-col gap-3">
            <p className="text-muted text-[13px]">This board is private. Enter its password.</p>
            <input type="hidden" name="next" value={next} />
            <input
              type="password"
              name="password"
              aria-label="Password"
              autoFocus
              autoComplete="current-password"
              className="border-line bg-cream text-ink focus:border-clay h-10 rounded-md border px-3 text-[14px] outline-none"
            />
            <button
              type="submit"
              className="bg-terracotta-cta h-10 rounded-lg text-[14px] font-semibold text-white"
            >
              Sign in
            </button>
          </form>
        )}

        {error && (
          <p role="alert" className="text-crimson-text text-[12px]">
            {github ? error : "That password is not right."}
          </p>
        )}
      </div>
    </main>
  );
}

function GitHubMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}
