import { NextRequest } from "next/server";

import { launch } from "@/lib/agents/pipeline";
import { repository } from "@/lib/db";
import { collectCliRuns } from "@/lib/runner/runner";
import { GITLAB_RUNNER_JOB } from "@/lib/runner/gitlab-ci";
import { verifyGitlabHook } from "@/lib/runner/gitlab-hook";
import { gitlabRepo } from "@/lib/vcs/host";

export const dynamic = "force-dynamic";

const FINISHED = new Set(["success", "failed", "canceled"]);

/**
 * The GitLab webhook receiver: a project's job events, registered by the
 * setup. Only Formic's own job finishing does anything, and then only a look
 * at the project's runs, the same look the board's sweep takes: what that
 * finds is claimed once, whichever comes first. Never trusts a delivery
 * without the project's own token, and never makes GitLab wait.
 */
export async function POST(req: NextRequest) {
  let payload: {
    object_kind?: unknown;
    build_name?: unknown;
    build_status?: unknown;
    project?: { path_with_namespace?: unknown };
  };
  try {
    payload = JSON.parse(await req.text());
  } catch {
    return Response.json({ ok: false, reason: "Malformed body." }, { status: 400 });
  }
  const path = payload.project?.path_with_namespace;
  if (typeof path !== "string" || !verifyGitlabHook(path, req.headers.get("x-gitlab-token"))) {
    return Response.json({ ok: false, reason: "Bad token." }, { status: 401 });
  }
  if (
    payload.object_kind !== "build" ||
    payload.build_name !== GITLAB_RUNNER_JOB ||
    typeof payload.build_status !== "string" ||
    !FINISHED.has(payload.build_status)
  ) {
    return Response.json({ ok: true, ignored: true }, { status: 202 });
  }

  const projects = await repository().projectsForRepo(gitlabRepo(path));
  for (const project of projects) {
    launch(() => collectCliRuns(project.id, { now: true }), "collecting a GitLab agent run");
  }
  return Response.json({ ok: true, projects: projects.length }, { status: 202 });
}
