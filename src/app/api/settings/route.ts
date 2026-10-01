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
  getLimitSettings,
  getRunTimeBudgetSettings,
  updateLimitSettings,
  updateRunTimeBudgetSettings,
} from "@/lib/user-settings";
import { LIMIT_AXES, validateLimitSetting } from "@/lib/domain/limit-settings";
import { hintFor, seal } from "@/lib/secrets/vault";

export const dynamic = "force-dynamic";

/** A new key; null removes the saved one; omitted leaves it. */
const keySchema = z.string().trim().min(1).max(500).nullable().optional();
const bodySchema = z.object({
  e2bKey: keySchema,
  projectId: z.string().min(1).optional(),
  autoMerge: z.boolean().optional(),
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
    perPointMinutes: z.record(z.string(), z.unknown()).nullable().optional(),
    /** Token and attempt limits, validated by field below. */
    tokens: z.unknown().optional(),
    attempts: z.unknown().optional(),
  })
  // Money is not a setting: a cents field, or any other stray one, is refused.
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
    return Response.json({ autoMerge: found.project.autoMerge });
  }
  return Response.json({ ...(await getRunTimeBudgetSettings(user.id)), ...(await getLimitSettings(user.id)) });
}

async function putRunTimeBudget(userId: string, json: unknown) {
  const body = budgetSchema.safeParse(json);
  if (!body.success) {
    return Response.json({ error: "Malformed.", errors: { mode: "Choose a valid mode." } }, { status: 400 });
  }
  const { mode, flatMinutes, perPointMinutes } = body.data;
  const errors: Record<string, string> = validateRunTimeBudgetSettings({ mode, flatMinutes }, perPointMinutes ?? null);
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

/** Saves this person's sandbox key (never returned), their run time budget when the body has a `mode`, or their renewal day when it has a `renewalDay`. */
export async function PUT(req: Request) {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Sign in first." }, { status: 401 });
  const json = await req.json().catch(() => null);
  if (json && typeof json === "object" && "mode" in json) return putRunTimeBudget(user.id, json);
  if (json && typeof json === "object" && "renewalDay" in json) return putRenewalDay(user.id, json);
  const body = bodySchema.safeParse(json);
  if (!body.success) {
    return Response.json({ error: body.error.issues[0]?.message ?? "Malformed." }, { status: 400 });
  }

  if ((body.data.autoMerge === undefined) !== (body.data.projectId === undefined)) {
    return Response.json({ error: "autoMerge and projectId go together." }, { status: 400 });
  }
  if (body.data.projectId !== undefined && body.data.autoMerge !== undefined) {
    const found = await ownedProject(user, body.data.projectId);
    if (found.refusal) return found.refusal;
    await repository().setAutoMerge(found.project.id, body.data.autoMerge);
    return Response.json({ autoMerge: body.data.autoMerge });
  }

  const updated = await repository().updateUser(user.id, {
    ...sealed(body.data.e2bKey, "e2bKeyCipher", "e2bKeyHint"),
  });
  return Response.json({ e2bKeyHint: updated.e2bKeyHint });
}
