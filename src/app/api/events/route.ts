import { NextRequest } from "next/server";
import { repository } from "@/lib/db";
import { isDroppable, replay, subscribe } from "@/lib/events/bus";
import type { SequencedEvent } from "@/lib/domain/events";
import { activeProject } from "@/lib/board/project";
import { collectCliRuns } from "@/lib/runner/runner";
import { sweepOpenPullRequests } from "@/lib/review/pipeline";

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
  const project = await activeProject();
  // 204 is the one status that tells EventSource to stop reconnecting.
  if (!project) return new Response(null, { status: 204 });

  const lastEventId =
    req.headers.get("last-event-id") ??
    req.nextUrl.searchParams.get("lastEventId");
  const cursor = lastEventId ? Number(lastEventId) : 0;

  const encoder = new TextEncoder();
  let queued = 0;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;

      // Events can arrive twice (in-process bus and the durable tail below),
      // so dedupe by sequence number rather than trust arrival order.
      const delivered = new Set<number>();
      // A fresh connection tails from now; a reconnect from its cursor.
      let polledThrough =
        Number.isFinite(cursor) && cursor > 0
          ? cursor
          : await repository().latestEventSeq(project.id);

      const send = (e: SequencedEvent) => {
        if (closed || delivered.has(e.seq)) return;
        delivered.add(e.seq);
        if (delivered.size > 2_000) {
          delivered.delete(delivered.values().next().value as number);
        }

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

      // The in-process bus only reaches subscribers in this instance. On
      // serverless the run publishing an event is often in another one, so
      // also tail the durable log; `send` drops anything already delivered.
      let polling = false;
      const tail = setInterval(async () => {
        if (closed || polling) return;
        polling = true;
        // While someone watches the board, agent runs whose webhook never
        // came are found on GitHub. Throttled inside; never holds the tail.
        void collectCliRuns(project.id).catch((e: unknown) =>
          console.warn("[formic] could not check the agents' runs:", e),
        );
        void sweepOpenPullRequests(project.id).catch((e: unknown) =>
          console.warn("[formic] could not check the open pull requests:", e),
        );
        try {
          for (const e of await replay(project.id, polledThrough)) {
            send(e);
            polledThrough = Math.max(polledThrough, e.seq);
          }
        } catch {
          // A missed poll is retried on the next tick.
        } finally {
          polling = false;
        }
      }, 2_000);

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
        clearInterval(tail);
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
