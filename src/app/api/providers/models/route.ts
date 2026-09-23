import { z } from "zod";
import { repository } from "@/lib/db";
import { currentUser, canSee } from "@/lib/auth/user";
import { authMode } from "@/lib/auth/session";
import { PROVIDER_IDS, provider } from "@/lib/llm/providers";
import { listOpenAiModels } from "@/lib/llm/openai-compat";
import { anthropicClient } from "@/lib/agents/anthropic";
import { open } from "@/lib/secrets/vault";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  provider: z.enum(PROVIDER_IDS),
  /** A key typed into the editor and not saved yet. */
  apiKey: z.string().trim().min(1).optional(),
  /** Or the saved key of a template being edited. */
  presetId: z.string().min(1).optional(),
});

/**
 * The models a key can use, asked of the provider itself, so the list is
 * never out of date. The key is used for this one request and not kept.
 */
export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Sign in first." }, { status: 401 });
  const body = bodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return Response.json({ error: "Expected a provider." }, { status: 400 });

  const info = provider(body.data.provider)!;
  // A CLI agent's models are whatever its CLI accepts; there is nothing to ask.
  if (info.kind === "cli") return Response.json({ ok: true, models: info.suggestedModels });
  let key = body.data.apiKey ?? null;
  if (!key && body.data.presetId) {
    const found = await repository().presetForRun(body.data.presetId);
    if (found && canSee(user, found.preset.ownerId) && found.apiKeyCipher) {
      key = open(found.apiKeyCipher);
    }
  }
  if (!key && authMode() === "local") key = process.env[info.envKey] || null;
  if (!key) {
    return Response.json({ ok: false, reason: `Add a ${info.label} API key to see its models.` });
  }

  try {
    let models: string[];
    if (info.kind === "anthropic") {
      models = [];
      for await (const m of anthropicClient(key).models.list()) models.push(m.id);
    } else {
      models = await listOpenAiModels(info, key);
    }
    return Response.json({ ok: true, models });
  } catch (e) {
    return Response.json({
      ok: false,
      reason: e instanceof Error ? e.message : `Could not list ${info.label} models.`,
    });
  }
}
