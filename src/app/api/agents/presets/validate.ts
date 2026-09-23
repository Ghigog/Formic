import { agentPresetInputSchema } from "@/lib/domain/entities";
import { agentModel } from "@/lib/agents/models";

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
