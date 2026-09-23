import { agentPresetInputSchema } from "@/lib/domain/entities";
import { agentModel } from "@/lib/agents/models";
import { repository } from "@/lib/db";
import { canSee } from "@/lib/auth/user";
import type { UserRecord } from "@/lib/db/repository";

/** A preset body, or the first reason it is not one. */
export async function parsePreset(req: Request) {
  const parsed = agentPresetInputSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return { ok: false as const, error: parsed.error.issues[0]?.message ?? "Malformed preset." };
  }
  if (!agentModel(parsed.data.model)) {
    return { ok: false as const, error: `Unknown model ${parsed.data.model}.` };
  }
  return { ok: true as const, data: parsed.data };
}

/** Whether this person may use or change a preset. Unknown ids read as no. */
export async function ownsPreset(user: UserRecord, presetId: string): Promise<boolean> {
  const found = await repository().presetForRun(presetId);
  return !!found && canSee(user, found.preset.ownerId);
}
