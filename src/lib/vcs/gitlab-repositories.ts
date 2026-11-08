import "server-only";

import { gl, glPages, projectId } from "./gitlab-api";
import { gitlabRepo } from "./host";
import type { RepoOption } from "./repositories";

/** A gitlab.com project as the API gives it, the parts the picker shows. */
interface RawProject {
  path_with_namespace: string;
  default_branch: string | null;
  visibility: string;
  description: string | null;
  last_activity_at: string | null;
}

function toOption(p: RawProject): RepoOption {
  return {
    fullName: gitlabRepo(p.path_with_namespace),
    defaultBranch: p.default_branch ?? "main",
    private: p.visibility !== "public",
    description: p.description,
    pushedAt: p.last_activity_at,
  };
}

/**
 * The gitlab.com projects this person can work on: those where they can push
 * (Developer or above), most recently active first. Agents push branches and
 * open merge requests as them, so the picker offers only what that allows.
 */
export async function listGitlabProjects(
  token: string,
): Promise<{ ok: true; repos: RepoOption[] } | { ok: false; reason: string }> {
  try {
    const projects = await glPages<RawProject>(
      token,
      "/projects?membership=true&min_access_level=30&order_by=last_activity_at&sort=desc&archived=false&simple=true",
      3,
    );
    return { ok: true, repos: projects.map(toOption) };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : "Could not reach GitLab." };
  }
}

/** One project by its path, for its real name and default branch. Null if unseen. */
export async function getGitlabProject(path: string, token: string): Promise<RepoOption | null> {
  const found = await gl<RawProject | null>(token, `/projects/${projectId(path)}`, { allow404: true }).catch(
    () => null,
  );
  return found ? toOption(found) : null;
}

/** Every path on a ref, files and directories, as GitLab's tree lists them. */
export async function gitlabTree(
  path: string,
  ref: string,
  token: string,
): Promise<Array<{ path: string; type: "blob" | "tree" }> | null> {
  try {
    return await glPages<{ path: string; type: "blob" | "tree" }>(
      token,
      `/projects/${projectId(path)}/repository/tree?ref=${encodeURIComponent(ref)}&recursive=true`,
      // 100 a page: room for 20,000 entries, past which the layout is cut anyway.
      200,
    );
  } catch {
    return null;
  }
}
