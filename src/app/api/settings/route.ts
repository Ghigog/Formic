import { z } from "zod";
import { repository } from "@/lib/db";
import { currentUser } from "@/lib/auth/user";
import {
  RUN_TIME_BUDGET_MODES,
  validateRunTimeBudgetSettings,
  type RunTimeBudgetSettings,
} from "@/lib/run-time-budget";
import { getRunTimeBudgetSettings, updateRunTimeBudgetSettings } from "@/lib/user-settings";
import { hintFor, seal } from "@/lib/secrets/vault";

export const dynamic = "force-dynamic";

/** A new key; null removes the saved one; omitted leaves it. */
const keySchema = z.string().trim().min(1).max(500).nullable().optional();
const bodySchema = z.object({ e2bKey: keySchema });

function sealed(value: string | null | undefined, cipher: string, hint: string) {
  if (value === undefined) return {};
  if (value === null) return { [cipher]: null, [hint]: null };
  return { [cipher]: seal(value), [hint]: hintFor(value) };
}

/** Flat minutes and per-point values stay loose so the domain validation reports them by field. */
const budgetSchema = z.object({
  mode: z.enum(RUN_TIME_BUDGET_MODES),
  flatMinutes: z.number().nullable().optional(),
  perPointMinutes: z.record(z.string(), z.unknown()).nullable().optional(),
});

/** This person's run time budget; the default when they never chose. */
export async function GET() {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Sign in first." }, { status: 401 });
  return Response.json(await getRunTimeBudgetSettings(user.id));
}

async function putRunTimeBudget(userId: string, json: unknown) {
  const body = budgetSchema.safeParse(json);
  if (!body.success) {
    return Response.json({ error: "Malformed.", errors: { mode: "Choose a valid mode." } }, { status: 400 });
  }
  const { mode, flatMinutes, perPointMinutes } = body.data;
  const errors = validateRunTimeBudgetSettings({ mode, flatMinutes }, perPointMinutes ?? null);
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
  return Response.json(await updateRunTimeBudgetSettings(userId, settings));
}

/** Saves this person's sandbox key (never returned), or their run time budget when the body has a `mode`. */
export async function PUT(req: Request) {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Sign in first." }, { status: 401 });
  const json = await req.json().catch(() => null);
  if (json && typeof json === "object" && "mode" in json) return putRunTimeBudget(user.id, json);
  const body = bodySchema.safeParse(json);
  if (!body.success) {
    return Response.json({ error: body.error.issues[0]?.message ?? "Malformed." }, { status: 400 });
  }

  const updated = await repository().updateUser(user.id, {
    ...sealed(body.data.e2bKey, "e2bKeyCipher", "e2bKeyHint"),
  });
  return Response.json({ e2bKeyHint: updated.e2bKeyHint });
}
