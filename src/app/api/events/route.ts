import { NextRequest } from "next/server";
import { repository } from "@/lib/db";
import { isDroppable, replay, subscribe } from "@/lib/events/bus";
import type { SequencedEvent } from "@/lib/domain/events";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Server-sent events, one stream per project.
 *
 * SSE rather than websockets: the traffic is one-directional (commands go over
 * normal requests), it survives proxies, and the browser reconnects on its own
 * with Last-Event-ID, which is exactly the replay cursor this needs.
 */

/** Frames buffered for a slow client before droppable events start falling. */
const HIGH_WATER = 256;

export async function GET(req: NextRequest) {
  const project = await repository().defaultProject();

  const lastEventId =
    req.headers.get("last-event-id") ??
    req.nextUrl.searchParams.get("lastEventId");
  const cursor = lastEventId ? Number(lastEventId) : 0;

  const encoder = new TextEncoder();
  let queued = 0;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;

      const send = (e: SequencedEvent) => {
        if (closed) return;

        // Backpressure: once the buffer is deep, log and progress frames are
        // dropped so state changes still get through.
        if (queued > HIGH_WATER && isDroppable(e.event)) return;

        try {
          queued++;
          controller.enqueue(
            encoder.encode(
              `id: ${e.seq}\nevent: ${e.event.type}\ndata: ${JSON.stringify(e)}\n\n`,
            ),
          );
        } catch {
          closed = true;
        } finally {
          queued--;
        }
      };

      controller.enqueue(encoder.encode(": connected\n\n"));

      // Replay anything missed while disconnected, before live delivery.
      if (Number.isFinite(cursor) && cursor > 0) {
        for (const e of await replay(project.id, cursor)) send(e);
      }

      const unsubscribe = subscribe(project.id, send);

      // Comment frames keep intermediaries from closing an idle connection.
      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          closed = true;
        }
      }, 25_000);

      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // Already closed by the runtime.
        }
      };

      req.signal.addEventListener("abort", cleanup, { once: true });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Nginx and friends buffer text/event-stream by default.
      "X-Accel-Buffering": "no",
    },
  });
}
