import { credentialsForProject } from "@/lib/auth/credentials";
import { activeProject, noProject } from "@/lib/board/project";
import { vcs } from "@/lib/vcs";
import type { ActionsMachines } from "@/lib/vcs/types";

export const dynamic = "force-dynamic";

export type MachinesResponse = ActionsMachines & { repoFullName: string | null };

/**
 * Where the active project's Actions jobs run: whether the repository is
 * private (its minutes are billed against the owner's plan) and the machines
 * of its own it has registered. The setup dialog and the Runner settings read
 * it to say what running agents costs, and how to make it free.
 */
export async function GET() {
  const project = await activeProject();
  if (!project) return noProject();
  const none: MachinesResponse = { repoFullName: project.repoFullName, private: null, runners: null };
  if (!project.repoFullName) return Response.json(none);
  const creds = await credentialsForProject(project);
  if (!creds.repoToken) return Response.json(none);
  try {
    const machines = await vcs(project.repoFullName, creds.repoToken).actionsMachines();
    return Response.json({ ...machines, repoFullName: project.repoFullName } satisfies MachinesResponse);
  } catch {
    return Response.json(none);
  }
}
