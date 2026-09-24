import { redirect } from "next/navigation";
import { CURRENT_TERMS_VERSION, currentUser } from "@/lib/auth/user";
import { safeNext } from "@/lib/auth/session";
import { MarkdownLite } from "@/components/ui/markdown-lite";
import { PRIVACY_MD, TERMS_MD } from "./content";

export const dynamic = "force-dynamic";

/**
 * Shown before the board to anyone signed in who has not accepted the
 * current terms; see needsTermsAcceptance in src/lib/auth/user.ts and the
 * gate in src/proxy.ts. Also reachable any time from the account menu.
 */
export default async function LegalPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const user = await currentUser();
  if (!user) redirect("/login");

  const { next: rawNext } = await searchParams;
  const next = safeNext(rawNext);

  return (
    <main className="bg-cream flex min-h-dvh items-center justify-center p-4">
      <div className="bg-card border-line flex w-full max-w-2xl flex-col gap-4 rounded-xl border p-6">
        <div>
          <h1 className="font-serif text-[22px] font-semibold">Terms & privacy</h1>
          <p className="text-muted text-[13px]">
            Formic is closed-beta software. Please read this before connecting a
            repository — it says what happens to your code, keys and data.
          </p>
        </div>

        <section className="border-line max-h-[45vh] overflow-y-auto rounded-lg border p-3 text-[13px]">
          <h2 className="text-fg-subtle font-mono text-[10px] tracking-wide uppercase">
            Terms of service / beta agreement
          </h2>
          <MarkdownLite text={TERMS_MD} className="mt-2" />

          <h2 className="text-fg-subtle mt-4 font-mono text-[10px] tracking-wide uppercase">
            Privacy policy
          </h2>
          <MarkdownLite text={PRIVACY_MD} className="mt-2" />

          <p className="text-muted mt-4 text-[12px]">
            Full third-party list: <code className="bg-sunken rounded px-1 font-mono text-[0.9em]">docs/legal/third-parties.md</code> in
            this repository.
          </p>
        </section>

        <form
          method="post"
          action="/legal/accept"
          className="flex flex-wrap items-center justify-between gap-3"
        >
          <input type="hidden" name="next" value={next} />
          <p className="text-muted text-[12px]">
            Accepting agrees to both documents, version {CURRENT_TERMS_VERSION}.
          </p>
          <button
            type="submit"
            className="bg-terracotta-cta h-10 shrink-0 rounded-lg px-4 text-[14px] font-semibold text-white"
          >
            Accept and continue
          </button>
        </form>
      </div>
    </main>
  );
}
