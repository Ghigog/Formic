"use client";

import { AccountMenu, type Account } from "./account-menu";
import { RepoPicker } from "./repo-picker";
import { AutoTour } from "@/components/onboarding/tour";

/**
 * Someone signed in with no board yet: this is the whole page until they
 * pick a repository, the example, or a board with no repository.
 */
export function Welcome({ account }: { account: Account }) {
  // Signed in by email with no GitHub: lead with a board of its own.
  const githubOff = account.github?.connected === false;
  return (
    <div className="bg-cream flex min-h-dvh flex-col">
      <header className="border-line bg-card flex h-16 shrink-0 items-center gap-3 border-b px-4 md:px-6">
        <span
          aria-hidden
          className="oct-lg bg-anthracite text-on-anthracite inline-flex size-7 items-center justify-center font-serif text-[16px] font-semibold"
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
            {githubOff ? "Start a board" : "Pick a repository to start"}
          </h1>
          <p className="text-muted mt-2 text-[13px] leading-[1.6]">
            {githubOff
              ? "A board works without a repository: tickets, epics and your colony, with your own AI through the MCP server. Connect GitHub later if you want agents working on code."
              : "Each repository gets its own board. Your agents work on it with your GitHub access, and open pull requests you review."}
          </p>
        </div>
        <RepoPicker current={null} inline onClose={() => {}} className="relative" />
        <a href="/settings" className="text-muted hover:text-ink text-[12px] font-medium">
          Add your sandbox key in Settings
        </a>
        <AutoTour id="pick" delay={700} />
      </main>
    </div>
  );
}
