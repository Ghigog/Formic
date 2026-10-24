import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { LimitSetting } from "@/lib/budget/budget-for";
import { repository } from "@/lib/db";
import { canSee, currentUser } from "@/lib/auth/user";
import type { UserRecord } from "@/lib/db/repository";
import {
  RUN_TIME_BUDGET_MODES,
  validateRunTimeBudgetSettings,
  type RunTimeBudgetSettings,
} from "@/lib/run-time-budget";
import {
  getEffortByPoints,
  getLimitSettings,
  getNotificationSettings,
  setNotificationSettings,
  getRunTimeBudgetSettings,
  updateLimitSettings,
  updateRunTimeBudgetSettings,
  setEffortByPoints,
} from "@/lib/user-settings";
import { authMode } from "@/lib/auth/session";
import { LIMIT_AXES, validateLimitSetting } from "@/lib/domain/limit-settings";
import { resetEnvCache } from "@/lib/secrets/env";
import { runnerSetup } from "@/lib/runner/setup";
import { hintFor, seal } from "@/lib/secrets/vault";

export const dynamic = "force-dynamic";

/** A new key; null removes the saved one; omitted leaves it. */
const keySchema = z.string().trim().min(1).max(500).nullable().optional();
const bodySchema = z.object({
  e2bKey: keySchema,
  projectId: z.string().min(1).optional(),
  autoMerge: z.boolean().optional(),
  agentsOff: z.boolean().optional(),
  autoEscalate: z.boolean().optional(),
  /** Whether members may run on the owner's keys when they have none of their own. */
  shareKeys: z.boolean().optional(),
  /** Whether the board runs the agent pipeline; turning it on needs a linked repository. */
  agents: z.boolean().optional(),
  /** An existing agent preset id, or null for the In Progress column's agent. */
  scoutPresetId: z.string().min(1).nullable().optional(),
});

function sealed(value: string | null | undefined, cipher: string, hint: string) {
  if (value === undefined) return {};
  if (value === null) return { [cipher]: null, [hint]: null };
  return { [cipher]: seal(value), [hint]: hintFor(value) };
}

/** The project if this person owns it; otherwise the refusal to send. */
async function ownedProject(user: UserRecord, projectId: string | null) {
  const project = projectId ? await repository().projectById(projectId) : null;
  if (!project || !canSee(user, project.ownerId)) {
    return { refusal: Response.json({ error: "Not your project." }, { status: 403 }) };
  }
  return { project };
}

/** Flat minutes and per-point values stay loose so the domain validation reports them by field. */
const budgetSchema = z
  .object({
    mode: z.enum(RUN_TIME_BUDGET_MODES),
    flatMinutes: z.number().nullable().optional(),
    /** The minutes one story point buys in PER_STORY_POINT mode; null keeps the default. */
    perPointRate: z.number().nullable().optional(),
    perPointMinutes: z.record(z.string(), z.unknown()).nullable().optional(),
    /** Token and attempt limits, validated by field below. */
    tokens: z.unknown().optional(),
    attempts: z.unknown().optional(),
  })
  // Money is not a setting: a cents field, or any other stray one, is refused.
  .strict();

const notificationsSchema = z
  .object({ ticketMoved: z.boolean(), epicCompleted: z.boolean(), needsAttention: z.boolean() })
  .partial()
  .strict();

const renewalSchema = z.object({
  renewalDay: z.unknown(),
  timezone: z.unknown().optional(),
});

function validTimezone(value: unknown): value is string {
  if (typeof value !== "string" || !value) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** Stores the renewal day with its timezone; a null day removes both. */
async function putRenewalDay(userId: string, json: unknown) {
  const { renewalDay, timezone } = renewalSchema.parse(json);
  if (renewalDay === null) {
    await repository().updateTokenRenewal(userId, { tokenRenewalDay: null, tokenWindowTimezone: null });
    return Response.json({ renewalDay: null, timezone: null });
  }
  const errors: { renewalDay?: string; timezone?: string } = {};
  if (typeof renewalDay !== "number" || !Number.isInteger(renewalDay) || renewalDay < 1 || renewalDay > 31) {
    errors.renewalDay = "Enter a whole day from 1 to 31.";
  }
  if (!validTimezone(timezone)) errors.timezone = "Your timezone could not be read.";
  if (errors.renewalDay || errors.timezone) {
    return Response.json({ error: "Invalid renewal day.", errors }, { status: 400 });
  }
  const updated = await repository().updateTokenRenewal(userId, {
    tokenRenewalDay: renewalDay as number,
    tokenWindowTimezone: timezone as string,
  });
  return Response.json({ renewalDay: updated.tokenRenewalDay, timezone: updated.tokenWindowTimezone });
}

/**
 * A project's settings when `projectId` is given; otherwise this person's
 * limits on all three axes: time at the top level, then tokens and attempts.
 * Defaults when they never chose.
 */
export async function GET(req?: Request) {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Sign in first." }, { status: 401 });
  const projectId = req ? new URL(req.url).searchParams.get("projectId") : null;
  if (projectId !== null) {
    const found = await ownedProject(user, projectId);
    if (found.refusal) return found.refusal;
    return Response.json({
      autoMerge: found.project.autoMerge,
      agentsOff: found.project.agentsOff,
      autoEscalate: found.project.autoEscalate,
      shareKeys: found.project.shareKeys,
      agents: found.project.agents,
      scoutPresetId: found.project.scoutPresetId,
    });
  }
  return Response.json({
    ...(await getRunTimeBudgetSettings(user.id)),
    ...(await getLimitSettings(user.id)),
    effortByPoints: await getEffortByPoints(user.id),
    notifications: await getNotificationSettings(user.id),
  });
}

async function putRunTimeBudget(userId: string, json: unknown) {
  const body = budgetSchema.safeParse(json);
  if (!body.success) {
    return Response.json({ error: "Malformed.", errors: { mode: "Choose a valid mode." } }, { status: 400 });
  }
  const { mode, flatMinutes, perPointRate, perPointMinutes } = body.data;
  const errors: Record<string, string> = validateRunTimeBudgetSettings(
    { mode, flatMinutes, perPointRate },
    perPointMinutes ?? null,
  );
  for (const axis of LIMIT_AXES) {
    if (body.data[axis] === undefined) continue;
    for (const [field, message] of Object.entries(validateLimitSetting(body.data[axis]))) {
      errors[`${axis}.${field}`] = message;
    }
  }
  if (mode === "PER_POINT" && !errors.perPointMinutes && perPointMinutes == null) {
    errors.perPointMinutes = "Add at least one per-point value.";
  }
  if (Object.keys(errors).length > 0) {
    return Response.json({ error: "Invalid run time budget.", errors }, { status: 400 });
  }
  const settings: RunTimeBudgetSettings = {
    mode,
    flatMinutes,
    perPointRate,
    perPointMinutes: perPointMinutes
      ? Object.fromEntries(Object.entries(perPointMinutes).map(([k, v]) => [Number(k), v as number]))
      : null,
  };
  const time = await updateRunTimeBudgetSettings(userId, settings);
  const limits = await updateLimitSettings(userId, {
    ...(body.data.tokens !== undefined ? { tokens: body.data.tokens as LimitSetting } : {}),
    ...(body.data.attempts !== undefined ? { attempts: body.data.attempts as LimitSetting } : {}),
  });
  return Response.json({ ...time, ...limits });
}

/**
 * Local mode's GitHub credential is the server's, not a person's, so it lives
 * in `.env` rather than on a user row. Writing it there and reloading the
 * config in place makes the board go live without a restart. Every other line
 * of the file is left as it was.
 */
async function putGithubToken(json: { githubToken: unknown }) {
  if (authMode() !== "local") {
    return Response.json(
      { error: "Signed in with GitHub, your sign-in is the GitHub credential. Nothing to set here." },
      { status: 400 },
    );
  }
  const token = z.string().trim().min(1).max(500).nullable().safeParse(json.githubToken);
  if (!token.success) {
    return Response.json({ error: "That does not look like a token." }, { status: 400 });
  }

  const file = path.join(process.cwd(), ".env");
  let lines: string[] = [];
  try {
    lines = (await readFile(file, "utf8")).split("\n");
  } catch {
    // No .env yet: this creates one.
  }
  const kept = lines.filter((line) => !/^\s*GITHUB_TOKEN\s*=/.test(line));
  while (kept.length > 0 && (kept[kept.length - 1] ?? "").trim() === "") kept.pop();
  if (token.data !== null) kept.push(`GITHUB_TOKEN="${token.data.replace(/"/g, "")}"`);
  await writeFile(file, `${kept.join("\n")}\n`);

  if (token.data === null) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = token.data;
  resetEnvCache();

  return Response.json({ githubTokenHint: token.data ? hintFor(token.data) : null });
}

/** Saves this person's sandbox key (never returned), their run time budget when the body has a `mode`, their renewal day when it has a `renewalDay`, or local mode's server GitHub token when it has a `githubToken`. */
export async function PUT(req: Request) {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Sign in first." }, { status: 401 });
  const json = await req.json().catch(() => null);
  if (json && typeof json === "object" && "mode" in json) return putRunTimeBudget(user.id, json);
  if (json && typeof json === "object" && "renewalDay" in json) return putRenewalDay(user.id, json);
  if (json && typeof json === "object" && "effortByPoints" in json) {
    const on = z.boolean().safeParse((json as { effortByPoints: unknown }).effortByPoints);
    if (!on.success) return Response.json({ error: "effortByPoints is on or off." }, { status: 400 });
    return Response.json({ effortByPoints: await setEffortByPoints(user.id, on.data) });
  }
  if (json && typeof json === "object" && "notifications" in json) {
    const prefs = notificationsSchema.safeParse((json as { notifications: unknown }).notifications);
    if (!prefs.success) {
      return Response.json({ error: "Each notification kind is on or off." }, { status: 400 });
    }
    return Response.json({ notifications: await setNotificationSettings(user.id, prefs.data) });
  }
  if (json && typeof json === "object" && "githubToken" in json) {
    return putGithubToken(json as { githubToken: unknown });
  }
  const body = bodySchema.safeParse(json);
  if (!body.success) {
    return Response.json({ error: body.error.issues[0]?.message ?? "Malformed." }, { status: 400 });
  }

  const { projectId, autoMerge, agentsOff, autoEscalate, shareKeys, agents, scoutPresetId } = body.data;
  const forProject =
    autoMerge !== undefined || agentsOff !== undefined || autoEscalate !== undefined || shareKeys !== undefined ||
    agents !== undefined ||
    scoutPresetId !== undefined;
  if (forProject !== (projectId !== undefined)) {
    return Response.json(
      { error: "autoMerge, agentsOff, autoEscalate, shareKeys, agents, scoutPresetId and projectId go together." },
      { status: 400 },
    );
  }
  if (projectId !== undefined) {
    const found = await ownedProject(user, projectId);
    if (found.refusal) return found.refusal;
    if (scoutPresetId && !(await repository().presetForRun(scoutPresetId))) {
      return Response.json({ error: "That agent does not exist." }, { status: 400 });
    }
    if (agents && !found.project.repoFullName) {
      return Response.json({ error: "Link a repository before turning agents on." }, { status: 400 });
    }
    if (autoMerge !== undefined) await repository().setAutoMerge(found.project.id, autoMerge);
    if (agentsOff !== undefined) await repository().setAgentsOff(found.project.id, agentsOff);
    if (autoEscalate !== undefined) await repository().setAutoEscalate(found.project.id, autoEscalate);
    if (shareKeys !== undefined) await repository().setShareKeys(found.project.id, shareKeys);
    if (scoutPresetId !== undefined) await repository().setScoutAgent(found.project.id, scoutPresetId);
    if (agents !== undefined) await repository().setAgents(found.project.id, agents);
    // Turning agents on opens the runner setup pull request, as a new board does.
    const setup = agents ? await runnerSetup({ ...found.project, agents }) : undefined;
    return Response.json({
      ...(autoMerge !== undefined && { autoMerge }),
      ...(agentsOff !== undefined && { agentsOff }),
      ...(autoEscalate !== undefined && { autoEscalate }),
      ...(shareKeys !== undefined && { shareKeys }),
      ...(scoutPresetId !== undefined && { scoutPresetId }),
      ...(agents !== undefined && { agents }),
      ...(setup && { setup }),
    });
  }

  const updated = await repository().updateUser(user.id, {
    ...sealed(body.data.e2bKey, "e2bKeyCipher", "e2bKeyHint"),
  });
  return Response.json({ e2bKeyHint: updated.e2bKeyHint });
}
