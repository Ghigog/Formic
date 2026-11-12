import "server-only";

import { credentialsForProject } from "@/lib/auth/credentials";
import type { ProjectSummary } from "@/lib/db/repository";
import { vcs } from "@/lib/vcs";

/** Where a spike's Coder writes its findings (SPIKE_RULE). */
const FINDINGS_DIR = "docs/spikes/";

export type SpikeFindings =
  | { found: true; path: string; markdown: string }
  /** Not on the board's branch yet: the pull request is where to look. */
  | { found: false; prUrl: string | null };

/**
 * A spike's findings document: the first file under docs/spikes/ on the
 * board's branch whose name starts with the ticket's key, lower-cased.
 */
export async function spikeFindings(
  project: ProjectSummary,
  ticket: { key: string; prUrl: string | null },
): Promise<SpikeFindings> {
  const missing = { found: false, prUrl: ticket.prUrl } as const;
  if (!project.repoFullName) return missing;
  const creds = await credentialsForProject(project);
  const client = vcs(project.repoFullName, creds.repoToken);

  const prefix = `${FINDINGS_DIR}${ticket.key.toLowerCase()}-`;
  const path = (await client.listFiles(project.baseBranch)).find((f) => f.startsWith(prefix));
  if (!path) return missing;
  const markdown = await client.readFile(path, project.baseBranch);
  return markdown === null ? missing : { found: true, path, markdown };
}
