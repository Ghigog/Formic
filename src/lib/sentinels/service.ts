import "server-only";

import { repository } from "@/lib/db";
import { launch } from "@/lib/agents/pipeline";
import { sentinelAgent } from "@/lib/agents/presets";
import { projectFor } from "@/lib/board/project";
import { credentialsForProject } from "@/lib/auth/credentials";
import { vcs } from "@/lib/vcs";
import { CANNED } from "./canned";
import { runAudit } from "./agent";
import { sentinel as findSentinel, stepsFor } from "./roster";
import { sentinelStates, type SentinelStates } from "./view";

/**
 * Summoning a sentinel: the audit is journalled before it starts and runs
 * detached, and the page follows it by reading the journal, so a run on one
 * server instance shows up on a page served by another.
 */

export async function sentinelsFor(projectId: string): Promise<SentinelStates> {
  return sentinelStates(await repository().auditsFor(projectId));
}

export async function summonSentinel(
  projectId: string,
  sentinelId: string,
): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  const s = findSentinel(sentinelId);
  if (!s) return { ok: false, error: "No such sentinel.", status: 404 };
  const current = await sentinelsFor(projectId);
  if (current[s.id]?.running) return { ok: true };

  const repo = repository();
  const audit = await repo.startAudit(projectId, s.id);
  const log = (step: string) => repo.logAudit(audit.id, step);
  const fail = (error: string, model: string | null = null) =>
    repo.finishAudit(audit.id, { status: "failed", error, model });

  launch(async () => {
    try {
      await log("Listing files");
      const agent = await sentinelAgent(projectId);

      if (agent.kind === "none") return await fail(agent.reason);
      if (agent.kind === "mock") {
        // No key and no GitHub needed: a canned report at a believable pace.
        for (const step of stepsFor(s).slice(1)) {
          await new Promise((r) => setTimeout(r, 700 + Math.random() * 400));
          await log(step);
        }
        const canned = CANNED[s.id]!;
        return await repo.finishAudit(audit.id, { status: "done", ...canned, model: "mock" });
      }

      const project = await projectFor(projectId);
      const { githubToken } = await credentialsForProject(project);
      if (!githubToken) {
        return await fail("Sentinels read the code through GitHub, and this project has no GitHub access.");
      }
      const client = vcs(project.repoFullName, githubToken);
      const files = await client.listFiles(project.baseBranch);
      const outcome = await runAudit(agent.config, {
        sentinel: s,
        repoFullName: project.repoFullName,
        files,
        read: (path) => client.readFile(path, project.baseBranch),
        log,
        signal: AbortSignal.timeout(280_000),
      });
      if (!outcome.ok) return await fail(outcome.error, outcome.usage.model);
      await repo.finishAudit(audit.id, {
        status: "done",
        stars: outcome.stars,
        quote: outcome.quote,
        summary: outcome.summary,
        report: outcome.report,
        files: outcome.files,
        model: outcome.usage.model,
      });
    } catch (e) {
      await fail(e instanceof Error ? e.message : "The audit failed.");
    }
  }, `sentinel ${s.id}`);

  return { ok: true };
}
