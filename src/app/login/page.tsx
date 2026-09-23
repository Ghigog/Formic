export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const { next = "/", error } = await searchParams;

  return (
    <main className="bg-cream flex min-h-dvh items-center justify-center p-4">
      <form
        method="post"
        action="/api/login"
        className="bg-card border-line flex w-full max-w-sm flex-col gap-3 rounded-xl border p-5"
      >
        <h1 className="font-serif text-[22px] font-semibold">Formic</h1>
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
        {error && (
          <p role="alert" className="text-crimson-text text-[12px]">
            That password is not right.
          </p>
        )}
        <button
          type="submit"
          className="bg-terracotta-cta h-10 rounded-lg text-[14px] font-semibold text-white"
        >
          Sign in
        </button>
      </form>
    </main>
  );
}
