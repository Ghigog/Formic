import { asSignedIn } from "@/lib/auth/user";
import { repository } from "@/lib/db";
import { configuredOrigin } from "@/lib/origin";
import { limited, RUN } from "@/lib/rate-limit";
import { playtestAccess } from "@/lib/playtest/access";
import { ensureReaper, isOpen, startPlaytest, viewOf } from "@/lib/playtest/service";
import { playtestBoard } from "@/lib/playtest/route-helpers";
import { vcs } from "@/lib/vcs";

export const dynamic = "force-dynamic";

/**
 * Whether this person can playtest this board, and the session they have
 * open on it. The Done column's button reads this. See docs/plans/playtest.md.
 */
export const GET = asSignedIn(async () => {
  const found = await playtestBoard();
  if ("error" in found) return found.error;
  ensureReaper();
  const access = await playtestAccess(found.project, found.user);
  const open = (await repository().openPlaytestsFor(found.user.id)).find((r) => r.projectId === found.project.id && isOpen(r));
  return Response.json({
    access: access.ok ? { ok: true } : { ok: false, reason: access.reason, message: access.message },
    session: open ? viewOf(open) : null,
  });
});

/** Starts a playtest of the default branch, ending any other this person has open. */
export const POST = asSignedIn(async (req: Request) => {
  const refused = limited(req, RUN, "playtest-start");
  if (refused) return refused;
  const found = await playtestBoard();
  if ("error" in found) return found.error;
  const access = await playtestAccess(found.project, found.user);
  if (!access.ok) return Response.json({ error: access.message, reason: access.reason }, { status: 403 });

  // Their token has to reach the repository, not only exist.
  const head = await vcs(found.project.repoFullName, access.repoToken)
    .branchHead(found.project.baseBranch)
    .catch(() => null);
  if (!head) {
    return Response.json(
      { error: "Your access cannot read this repository's default branch. Check it in Settings.", reason: "no-repo-access" },
      { status: 403 },
    );
  }

  const record = await startPlaytest({
    project: found.project,
    userId: found.user.id,
    e2bKey: access.e2bKey,
    repoToken: access.repoToken,
    formicOrigin: configuredOrigin() ?? new URL(req.url).origin,
  });
  return Response.json({ session: viewOf(record) }, { status: 201 });
});
