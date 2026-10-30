import { NextRequest } from "next/server";
import { z } from "zod";
import { repository } from "@/lib/db";
import { PROJECT_COOKIE, activeProject } from "@/lib/board/project";
import { currentUser, ownerScope } from "@/lib/auth/user";
import { byLastOpened } from "@/lib/board/last-opened";
import { boardFor, boardsFor, canSeeBoard, sharedBoard } from "@/lib/board/sharing";
import { credentialsFor } from "@/lib/auth/credentials";
import { authMode, cookieHeader } from "@/lib/auth/session";
import { normalizeRepo } from "@/lib/secrets/repo";
import { getRepository } from "@/lib/vcs/repositories";
import { openExampleProject } from "@/lib/board/example";
import { addDesignTicket, addOnboardingTicket } from "@/lib/board/onboarding";
import { limited, RUN } from "@/lib/rate-limit";
import { classifyEvent, type NotificationKind } from "@/lib/notifications/classify";
import type { FormicEvent } from "@/lib/domain/events";
import { verdict } from "@/lib/usage/governor";

export const dynamic = "force-dynamic";

/** The boards this person can open, and which one this browser is looking at. */
export async function GET() {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Sign in first." }, { status: 401 });
  const [active, projects, openedAt] = await Promise.all([
    activeProject(),
    repository().listProjects(ownerScope(user)).then((own) => boardsFor(user, own)),
    repository().openedAtByProject(user.id),
  ]);
  const repo = repository();
  const prefs = await repo.pushPreferences(user.id);
  const latest = await latestNotifications(
    projects.map((p) => p.id),
    prefs,
  );
  const withActivity = await Promise.all(
    byLastOpened(projects, openedAt).map(async (p) => {
      const answered = (await repo.assistantMessages(p.id)).filter(
        (m) => m.role === "assistant" && m.status !== "pending",
      );
      const last = answered[answered.length - 1];
      return { ...p, lastAssistantMessage: last ? { id: last.id, createdAt: last.createdAt } : null,
        notifications: latest.get(p.id) ?? {},
      };
    }),
  );
  return Response.json({ active, projects: withActivity });
}

const NOTIFICATION_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Each board's latest notification of every kind the person has switched on,
 * as the event's sequence number: what the logo badge compares to what they
 * last saw.
 */
async function latestNotifications(
  projectIds: string[],
  prefs: Record<NotificationKind, boolean>,
): Promise<Map<string, Partial<Record<NotificationKind, { seq: number }>>>> {
  const found = new Map<string, Partial<Record<NotificationKind, { seq: number }>>>();
  if (projectIds.length === 0) return found;
  const events = await repository().eventsOfTypes(
    projectIds,
    ["card.status", "budget.exhausted"],
    new Date(Date.now() - NOTIFICATION_WINDOW_MS),
    1000,
  );
  for (const e of events) {
    const n = classifyEvent(e.payload as FormicEvent, { cardKey: "", cardTitle: "", boardName: "" });
    if (!n || !prefs[n.kind]) continue;
    const kinds = found.get(e.projectId) ?? {};
    kinds[n.kind] = { seq: e.seq };
    found.set(e.projectId, kinds);
  }
  return found;
}

const chooseSchema = z.union([
  z.object({ projectId: z.string().min(1) }),
  z.object({ repoFullName: z.string().min(1) }),
  z.object({ noRepository: z.literal(true), name: z.string().trim().min(1).max(100).optional() }),
  z.object({ example: z.literal(true) }),
]);

/**
 * Switch this browser to a project: one this person can see, by id, or a
 * repository by name. A repository someone already has a board for is joined
 * (see src/lib/board/sharing.ts); otherwise its board is made the first time.
 */
export async function POST(req: NextRequest) {
  const refused = limited(req, RUN, "run-start");
  if (refused) return refused;

  const user = await currentUser();
  if (!user) return Response.json({ error: "Sign in first." }, { status: 401 });

  const parsed = chooseSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "Expected a projectId, a repoFullName, noRepository or example." }, { status: 400 });
  }

  const repo = repository();
  let project;
  if ("projectId" in parsed.data) {
    project = await repo.projectById(parsed.data.projectId);
    if (!project || !(await canSeeBoard(user, project))) {
      return Response.json({ error: "That project no longer exists." }, { status: 404 });
    }
    project = await boardFor(user, project);
  } else if ("example" in parsed.data) {
    // A safe board to try Formic on: no repository, so nothing touches code.
    project = await openExampleProject(user.id);
  } else if ("noRepository" in parsed.data) {
    // A board of cards and levels: no repository to reach, no setup run, and
    // no AGENTS.md ticket, since no agent will read it.
    project = await repo.ensureProject({
      ownerId: user.id,
      repoFullName: null,
      name: parsed.data.name ?? "My board",
      baseBranch: "main",
    });
  } else {
    const fullName = normalizeRepo(parsed.data.repoFullName);
    if (!fullName) {
      return Response.json(
        { error: "Use owner/repo, or paste the repository URL." },
        { status: 400 },
      );
    }
    // Signed in with GitHub, a repository must be one this person's token
    // can reach: that is what their agents will push with. In local mode a
    // typed name is taken on trust, as before.
    const { githubToken } = await credentialsFor(user);
    const remote = githubToken ? await getRepository(fullName, githubToken) : null;
    if (!remote && authMode() === "github") {
      return Response.json(
        {
          error: `Formic can't reach ${fullName}. Install the Formic GitHub App on it first.`,
        },
        { status: 404 },
      );
    }
    const repoFullName = remote?.fullName ?? fullName;
    // Signed in with GitHub, a repository has one board, shared by everyone
    // whose access reaches it: the token check above is that access.
    const shared = authMode() === "github" ? await sharedBoard(repoFullName) : null;
    if (shared && shared.ownerId !== user.id) {
      await repo.addMember(shared.id, user.id);
      await repo.markOpened(user.id, shared.id);
      const res = Response.json({ project: shared });
      res.headers.append("Set-Cookie", cookieHeader(PROJECT_COOKIE, encodeURIComponent(shared.id), 31536000));
      return res;
    }
    const existed = (await repo.projectsForRepo(repoFullName)).some((p) => p.ownerId === user.id);
    // Near the host allowance, switching between boards stays open (the
    // proxy lets it through) but a new board would start its setup run.
    if (!existed && (await verdict()).standing !== "ok") {
      return Response.json(
        {
          error:
            "Formic is close to its hosting allowance, so new boards wait until 00:00 UTC. Existing boards can still be opened.",
        },
        { status: 503 },
      );
    }
    project = await repo.ensureProject({
      ownerId: user.id,
      repoFullName,
      baseBranch: remote?.defaultBranch ?? "main",
    });
    // A new board starts with its AGENTS.md and DESIGN.md tickets, as the
    // tour promises. Cards cost nothing; the setup run waits for the first
    // agent (see agents/columns/[column]/route.ts).
    if (!existed) {
      await addOnboardingTicket(project.id);
      await addDesignTicket(project.id);
    }
  }

  await repo.markOpened(user.id, project.id);
  const res = Response.json({ project });
  res.headers.append(
    "Set-Cookie",
    cookieHeader(PROJECT_COOKIE, encodeURIComponent(project.id), 31536000),
  );
  return res;
}
