import { SubmitOnce } from "@/components/ui/submit-once";

export const dynamic = "force-dynamic";

/**
 * Where an emailed sign-in link lands. Opening it spends nothing: mail
 * scanners open every link in a message. The button posts the token, and
 * that is what signs the person in.
 */
export default async function VerifyPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;

  return (
    <main className="bg-cream flex min-h-dvh items-center justify-center p-4">
      <div className="bg-card border-line flex w-full max-w-sm flex-col gap-3 rounded-xl border p-5">
        <h1 className="font-serif text-[22px] font-semibold">Formic</h1>
        {token ? (
          <form method="post" action="/api/auth/email/verify" className="flex flex-col gap-3">
            <p className="text-muted text-[13px]">You&apos;re one click from your board.</p>
            <input type="hidden" name="token" value={token} />
            <SubmitOnce
              pending="Signing you in…"
              autoFocus
              className="bg-cta h-10 rounded-lg text-[13px] font-semibold text-white"
            >
              Sign in to Formic
            </SubmitOnce>
          </form>
        ) : (
          <p role="alert" className="text-crimson-text text-[13px]">
            This link is missing its sign-in code. Ask for a new link from the{" "}
            <a href="/login" className="underline">
              login page
            </a>
            .
          </p>
        )}
      </div>
    </main>
  );
}
