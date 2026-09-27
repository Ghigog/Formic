import { NextRequest } from "next/server";
import { z } from "zod";
import { trackError } from "@/lib/observability/error-tracking";

export const dynamic = "force-dynamic";

/**
 * Where `src/instrumentation-client.ts` forwards a browser error. Kept
 * outside AUD-10's listed file scope because client error tracking has
 * nowhere else to land: the browser cannot log to the server's console or
 * reach `ALERT_WEBHOOK_URL` directly without exposing it to every visitor.
 */
const bodySchema = z.object({
  message: z.string().min(1).max(2000),
  stack: z.string().max(8000).optional(),
  route: z.string().max(2000).optional(),
});

export async function POST(req: NextRequest) {
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return new Response(null, { status: 204 });

  trackError({ ...parsed.data, source: "client" });
  return new Response(null, { status: 204 });
}
