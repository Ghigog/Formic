"use client";

import { AccountMenu, type Account } from "./account-menu";
import { RepoPicker } from "./repo-picker";

/**
 * Someone signed in with no repository yet. The board needs one before it
 * has anything to show, so this is the whole page until they pick.
 */
export function Welcome({ account }: { account: Account }) {
  return (
    <div className="bg-cream flex min-h-dvh flex-col">
      <header className="border-line bg-card flex h-16 shrink-0 items-center gap-3 border-b px-4 md:px-6">
        <span
          aria-hidden
          className="oct-lg bg-anthracite text-cream inline-flex size-7 items-center justify-center font-serif text-[16px] font-semibold"
        >
          F
        </span>
        <span className="font-serif text-[19px] font-semibold">Formic</span>
        <span className="flex-grow" />
        <AccountMenu account={account} />
      </header>

      <main className="flex flex-1 flex-col items-center gap-5 px-4 py-10">
        <div className="max-w-md text-center">
          <h1 className="font-serif text-[26px] font-semibold">
            Pick a repository to start
          </h1>
          <p className="text-muted mt-2 text-[13px] leading-[1.6]">
            Each repository gets its own board. Your agents work on it with your
            GitHub access, and open pull requests you review.
          </p>
        </div>
        <RepoPicker current={null} inline onClose={() => {}} className="relative" />
        <a href="/settings" className="text-muted hover:text-ink text-[12px] font-medium">
          Add your E2B and Anthropic keys in Settings
        </a>
      </main>
    </div>
  );
}
