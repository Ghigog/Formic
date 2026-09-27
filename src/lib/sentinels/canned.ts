import type { AuditReport } from "@/lib/db/repository";

/**
 * Canned reports for the mock agents, so the Sentinels page can be driven
 * end to end with no API key: the same shape a real sentinel returns.
 */

export interface CannedAudit {
  stars: number;
  quote: string;
  summary: string;
  report: AuditReport;
}

const p = (text: string, ref = "") => ({ text, ref: ref || null });

export const CANNED: Record<string, CannedAudit> = {
  tester: {
    stars: 4,
    quote: "Jolly fine coverage, old sport. Alas, my little arms cannot reach the API routes.",
    summary: "Solid unit coverage on the domain layer, but API routes are thin on tests and one suite is red on main.",
    report: {
      likes: [
        p("Domain logic in lib/points.ts is covered at 94% with table-driven cases", "lib/points.test.ts"),
        p("Fixtures are factories rather than JSON blobs, so tests read clearly", "test/factories.ts"),
      ],
      dislikes: [
        p("Snapshot tests assert on output nobody reviews", "components/__snapshots__/"),
        p("Mocks reach into Prisma internals instead of a repository seam", "app/api/tickets/route.test.ts"),
      ],
      wrong: [
        p("Epic route test fails on main: expected 200, received 500", "app/api/epics/route.test.ts:42"),
      ],
      missing: [
        p("No tests for the webhook signature check", "app/api/github/webhook/route.ts"),
        p("No coverage threshold enforced in CI", "vitest.config.ts"),
      ],
    },
  },
  qa: {
    stars: 3,
    quote: "It’s good, old chap… could use polish. And more brains.",
    summary: "Core flows work by hand, but nothing guards them end to end and two regressions from last sprint still reproduce.",
    report: {
      likes: [
        p("Every ticket state change has a clear, reversible action", "components/Board.tsx"),
        p("Bug reports link back to the ticket that introduced them", "lib/bugs.ts"),
      ],
      dislikes: [
        p("The manual QA checklist lives outside the repo"),
        p("Preview deployments expire before review finishes", "vercel.json"),
      ],
      wrong: [
        p("Dragging a ticket back from Done keeps its points", "lib/points.ts:88"),
        p("Heat multiplier resets on page refresh", "hooks/useHeat.ts"),
      ],
      missing: [
        p("No Playwright or Cypress suite for the board"),
        p("No smoke test after deploy"),
      ],
    },
  },
  architect: {
    stars: 4,
    quote: "Whooo let epics import tickets that import epics? A circle, dear student. How gauche.",
    summary: "Clean module boundaries and a readable data model. Business rules are starting to leak into route handlers.",
    report: {
      likes: [
        p("lib/ holds pure domain logic with no framework imports", "lib/"),
        p("Prisma schema is normalised and migrations are linear", "prisma/schema.prisma"),
      ],
      dislikes: [
        p("Route handlers compute points inline instead of calling lib/points", "app/api/tickets/[id]/route.ts"),
        p("Two date libraries in use, date-fns and dayjs", "package.json"),
      ],
      wrong: [
        p("Circular import between lib/epics and lib/tickets", "lib/epics.ts:3"),
      ],
      missing: [
        p("No architecture decision records", "docs/"),
        p("README setup skips the webhook secret", "README.md"),
      ],
    },
  },
  secops: {
    stars: 3,
    quote: "I walked in through your webhook. Nobody heard a thing.",
    summary: "Auth sits on a mature library, but secrets hygiene and input validation need work before outside users arrive.",
    report: {
      likes: [
        p("Sessions use NextAuth with httpOnly, sameSite cookies", "lib/auth.ts"),
        p("Dependabot is on and merged weekly", ".github/dependabot.yml"),
      ],
      dislikes: [
        p("CSP allows unsafe-inline scripts", "next.config.js"),
        p("Admin routes check role on the client only", "app/admin/page.tsx"),
      ],
      wrong: [
        p("Webhook payloads are processed before the signature is verified", "app/api/github/webhook/route.ts:17"),
        p("A Stripe test key is committed in an example file", ".env.example:9"),
      ],
      missing: [
        p("No rate limiting on the public API", "middleware.ts"),
        p("No schema validation on request bodies", "app/api/"),
      ],
    },
  },
  devops: {
    stars: 5,
    quote: "BEEP. PIPELINE MAGNIFICENT. FOUR MINUTES FLAT. I AM EXPERIENCING JOY. BOOP.",
    summary: "Fast, reproducible pipeline with preview deploys and one-click rollbacks. The best-kept part of the repo.",
    report: {
      likes: [
        p("CI runs lint, types and tests in parallel in under 4 minutes", ".github/workflows/ci.yml"),
        p("Every PR gets a preview deployment with seeded data", ".github/workflows/preview.yml"),
        p("Migrations run as a gated step before deploy", ".github/workflows/deploy.yml"),
      ],
      dislikes: [
        p("Node version is pinned in CI but not in .nvmrc", ".nvmrc"),
      ],
      wrong: [],
      missing: [
        p("No dependency cache for the Prisma engine", ".github/workflows/ci.yml"),
      ],
    },
  },
  techops: {
    stars: 3,
    quote: "I only rise at 3am, and at 3am your logs tell me nothing. Nothing!",
    summary: "The app runs, but when it breaks nobody will know why. Logging and alerting are the gap.",
    report: {
      likes: [
        p("Health check reports database and queue status", "app/api/health/route.ts"),
        p("Background jobs are idempotent and retry safely", "lib/jobs.ts"),
      ],
      dislikes: [
        p("Logs are plain strings with no request IDs"),
        p("Cron jobs are defined in two places", "vercel.json"),
      ],
      wrong: [
        p("Job failures are swallowed by an empty catch", "lib/jobs.ts:61"),
      ],
      missing: [
        p("No error tracking"),
        p("No runbook or on-call notes", "docs/"),
        p("No uptime alerting"),
      ],
    },
  },
  perf: {
    stars: 4,
    quote: "Even I’d lap that N+1 query. Everything else? Zoom zoom.",
    summary: "The board renders fast and bundles are lean. A few N+1 queries will bite as projects grow.",
    report: {
      likes: [
        p("Board route ships 142 kB of JS, well under budget", "app/board/page.tsx"),
        p("Ant canvas runs outside the React tree", "components/Colony.tsx"),
      ],
      dislikes: [
        p("Timeline recomputes the burndown on every hover", "components/Timeline.tsx"),
      ],
      wrong: [
        p("Epic list fetches tickets once per epic (N+1)", "app/api/epics/route.ts:28"),
      ],
      missing: [
        p("No index on tickets.epicId", "prisma/schema.prisma"),
        p("No performance budget in CI"),
      ],
    },
  },
  a11y: {
    stars: 2,
    quote: "Sweetheart, I can’t drag things. Where’s the keyboard way? And turn down those ants.",
    summary: "Visually polished, but much of the board is unreachable without a mouse and motion is hard to turn off.",
    report: {
      likes: [
        p("Colour tokens meet 4.5:1 contrast for body text", "styles/tokens.css"),
        p("CSS animations respect prefers-reduced-motion", "app/globals.css"),
      ],
      dislikes: [
        p("Canvas particles ignore the reduced-motion setting", "components/Colony.tsx"),
        p("No visible mute control on mobile", "components/Header.tsx"),
      ],
      wrong: [
        p("Tickets can only be moved by dragging", "components/Board.tsx"),
        p("Timeline tooltips are hover-only", "components/Timeline.tsx"),
        p("Icon buttons have no accessible names", "components/Card.tsx"),
      ],
      missing: [
        p("No documented keyboard shortcuts"),
        p("No screen reader announcement when points change"),
      ],
    },
  },
  design: {
    stars: 5,
    quote: "Every cog in its proper place. I would only ask for an evening mode, darling.",
    summary: "A coherent, confident visual system. Motion and sound are used with restraint and always tied to an action.",
    report: {
      likes: [
        p("One type scale and one spacing scale used everywhere", "styles/tokens.css"),
        p("The octagon motif carries from logo to level badge to buttons", "components/Octagon.tsx"),
        p("Empty states explain the next action", "components/Column.tsx"),
      ],
      dislikes: [
        p("Mono labels drop to 9px in a few places", "components/Header.tsx"),
      ],
      wrong: [],
      missing: [
        p("No dark theme"),
      ],
    },
  },
  legal: {
    stars: 3,
    quote: "Eight arms and not one privacy policy between them. Objection sustained.",
    summary: "Licences are clean, but there is no privacy policy or data story for the GitHub data you store.",
    report: {
      likes: [
        p("All dependencies use permissive licences (MIT, Apache-2.0, ISC)", "package.json"),
        p("Repo includes LICENSE and CONTRIBUTING files", "LICENSE"),
      ],
      dislikes: [
        p("Terms of service is a placeholder page", "app/terms/page.tsx"),
      ],
      wrong: [
        p("Commit author emails are stored with no stated purpose or retention", "prisma/schema.prisma"),
        p("Sound effects have no licence attribution", "public/sfx/"),
      ],
      missing: [
        p("No privacy policy", "app/privacy/"),
        p("No account deletion or data export"),
      ],
    },
  },
  marketer: {
    stars: 4,
    quote: "Earthlings would totally screenshot these level-ups. Now give them a share button.",
    summary: "The product has a story people will share. The public site does not tell it yet.",
    report: {
      likes: [
        p("Level-ups and S grades are screenshot-worthy moments", "components/LevelUp.tsx"),
        p("The changelog is written for users, not engineers", "CHANGELOG.md"),
      ],
      dislikes: [
        p("Landing page leads with features, not the colony", "app/(marketing)/page.tsx"),
      ],
      wrong: [
        p("Open Graph image is still the framework default", "app/opengraph-image.png"),
      ],
      missing: [
        p("No share action for grades or level-ups"),
        p("No activation analytics"),
      ],
    },
  },
  sales: {
    stars: 3,
    quote: "Arr, a grand demo. But where be the SSO? The big ships won’t board without it.",
    summary: "A fun demo, but buyers will ask about SSO, seats and exports and the product has no answer yet.",
    report: {
      likes: [
        p("Demo seed data tells a complete story in two minutes", "prisma/seed.ts"),
        p("Timeline answers \"when will it ship\" at a glance", "components/Timeline.tsx"),
      ],
      dislikes: [
        p("Pricing lists no team tier", "app/(marketing)/pricing/page.tsx"),
      ],
      wrong: [
        p("Free plan has no project limit, so there is no upgrade trigger", "lib/plans.ts"),
      ],
      missing: [
        p("No SSO or SAML"),
        p("No CSV or Jira export"),
        p("No admin view of seats and usage"),
      ],
    },
  },
};
