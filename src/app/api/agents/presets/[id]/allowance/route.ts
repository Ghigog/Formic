import { z } from "zod";
import { repository } from "@/lib/db";
import { currentUser } from "@/lib/auth/user";
import { DEFAULT_ALLOWANCE_WINDOW_DAYS } from "@/lib/domain/limit-settings";
import { ownsPreset } from "../../validate";

export const dynamic = "force-dynamic";

/** Strict: money is not a setting, so a cents field is refused. */
const bodySchema = z
  .object({
    tokens: z.number().int().min(1).nullable(),
    /** Rolling days; omitted or null means 30. */
    windowDays: z.number().int().min(1).max(366).nullable().default(null),
  })
  .strict();

/** An agent's token allowance: tokens per rolling window. Null tokens clears it. */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await currentUser();
  if (!user) return Response.json({ error: "Sign in first." }, { status: 401 });
  const body = bodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return Response.json({ error: body.error.issues[0]?.message ?? "Malformed." }, { status: 400 });
  }
  if (!(await ownsPreset(user, id))) {
    return Response.json({ error: "That agent no longer exists." }, { status: 404 });
  }
  await repository().setPresetAllowance(id, body.data);
  const found = await repository().presetForRun(id);
  return Response.json({
    tokens: found?.preset.tokenAllowance ?? null,
    windowDays: found?.preset.tokenAllowanceWindowDays ?? DEFAULT_ALLOWANCE_WINDOW_DAYS,
  });
}
