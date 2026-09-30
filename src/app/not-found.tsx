import Link from "next/link";

export default function NotFound() {
  return (
    <main className="bg-cream flex min-h-dvh items-center justify-center p-4">
      <div className="bg-card border-line flex w-full max-w-sm flex-col gap-3 rounded-xl border p-5">
        <h1 className="font-serif text-[22px] font-semibold">Page not found</h1>
        <p className="text-muted text-[13px]">
          There is nothing at this address. It may have moved, or the link is wrong.
        </p>
        <Link
          href="/"
          className="bg-terracotta-cta inline-flex h-10 items-center justify-center rounded-lg text-[14px] font-semibold text-white"
        >
          Back to the board
        </Link>
      </div>
    </main>
  );
}
