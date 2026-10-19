"use client";

import { useSyncExternalStore } from "react";

const REPO = "https://github.com/Ghigog/Formic";
const GUIDE = `${REPO}/blob/main/deploy/mac/README.md`;

const STEPS = `git clone ${REPO}.git && cd Formic
npm install
xcode-select --install
brew install postgresql@16
bash deploy/mac/build.sh
open ~/Applications/Formic.app`;

/** A Mac, not an iPad asking for the desktop site (it reports MacIntel too). */
function isMac(): boolean {
  const platform = navigator.platform || navigator.userAgent;
  return /Mac/i.test(platform) && (navigator.maxTouchPoints ?? 0) <= 1;
}

const noSubscribe = () => () => {};

/** How to run Formic as a Mac app on your own machine, with no hosting. */
export function DesktopAppSection() {
  // null on the server: the OS is only known in the browser.
  const mac = useSyncExternalStore(noSubscribe, isMac, () => null);
  if (mac === null) return null;

  return (
    <section className="bg-card border-line rounded-xl border p-4">
      <h2 className="text-ink mb-3 text-[11px] font-semibold tracking-[0.1em] uppercase">
        Desktop app
      </h2>
      {mac ? (
        <>
          <p className="text-muted mb-2.5 text-[12px] leading-[1.5]">
            Run Formic on this Mac in its own window, with nothing hosted. Your
            board lives on your machine, and agents run while it is awake. In
            Terminal:
          </p>
          <pre className="border-line bg-cream text-ink overflow-x-auto rounded-md border p-2.5 font-mono text-[12px] leading-[1.6]">
            {STEPS}
          </pre>
          <p className="text-muted mt-2.5 text-[12px] leading-[1.5]">
            Then add your GitHub token in the app&apos;s settings. The red
            button quits Formic and stops the server.{" "}
            <a href={GUIDE} target="_blank" rel="noreferrer" className="text-ink underline">
              Full guide
            </a>
          </p>
        </>
      ) : (
        <p className="text-muted text-[12px] leading-[1.5]">
          The desktop app is Mac only for now. Formic works the same here in the
          browser.
        </p>
      )}
    </section>
  );
}
