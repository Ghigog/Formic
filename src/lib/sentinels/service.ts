import "server-only";

import { repository } from "@/lib/db";
import { launch } from "@/lib/agents/pipeline";
import { sentinelAgent } from "@/lib/agents/presets";
import { projectFor } from "@/lib/board/project";
import { credentialsForProject } from "@/lib/auth/credentials";
import { vcs } from "@/lib/vcs";
import { startCliSentinel } from "@/lib/runner/runner";
import { CANNED } from "./canned";
import { runAudit } from "./agent";
import { gatherEvidence } from "./gather";

/** Bytes of repository a sentinel downloads at most. */
const SNAPSHOT_BUDGET = 80_000_000;

/** What a snapshot keeps: text a sentinel could read, and lockfiles whole. */
function snapshotWanted(path: string, size: number): boolean {
  if (/(^|\/)(package-lock\.json|npm-shrinkwrap\.json)$/.test(path)) return size <= 30_000_000;
  if (/(^|\/)(node_modules|\.git|dist|build|out|\.next|coverage|vendor)\//.test(path)) return false;
  if (/\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf|eot|mp3|mp4|wav|ogg|pdf|zip|gz|tgz|wasm|bin|exe|dll|so|dylib|lockb)$/i.test(path)) return false;
  return size <= 400_000;
}
import { scoreOf } from "@/lib/colony/game";
import { isUnlocked, sentinel as findSentinel, stepsFor } from "./roster";
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
  // The level the colony shows, from the same stamped merge scores.
  const { level } = scoreOf(await repository().boardCards(projectId));
  if (!isUnlocked(s, level)) {
    return { ok: false, error: `${s.name} unlocks at Lv ${s.unlockLevel}.`, status: 403 };
  }
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
      if (agent.kind === "cli") {
        // The audit runs in GitHub Actions and finishes when its report comes back.
        await log(`Starting ${agent.agent.info.label} in GitHub Actions`);
        const started = await startCliSentinel({
          projectId,
          auditId: audit.id,
          sentinelId: s.id,
          agent: agent.agent,
        });
        if (!started.ok) await fail(started.reason);
        return;
      }
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
      await log("Gathering the facts");
      // The whole repository in one download, for reading and for the
      // analysis that needs every file. Without it, files come one by one.
      const snapshot = await client.snapshot(project.baseBranch, snapshotWanted, SNAPSHOT_BUDGET).catch(() => null);
      const evidence = await gatherEvidence({ client, branch: project.baseBranch, files, kinds: s.evidence, snapshot });
      const outcome = await runAudit(agent.config, {
        sentinel: s,
        repoFullName: project.repoFullName,
        files,
        read: async (path) => {
          const bytes = snapshot?.files.get(path);
          // Not in it: too large for the snapshot, or no snapshot at all.
          return bytes ? bytes.toString("utf8") : client.readFile(path, project.baseBranch);
        },
        evidence,
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
