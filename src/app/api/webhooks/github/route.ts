import { NextRequest } from "next/server";

import { launch } from "@/lib/agents/pipeline";
import { repository } from "@/lib/db";
import { markMergedExternally, reviewPullRequest } from "@/lib/review/pipeline";
import { interpret, verifySignature } from "@/lib/review/webhook";
import { completeCliRun } from "@/lib/runner/runner";
import { env } from "@/lib/secrets/env";

export const dynamic = "force-dynamic";

/**
 * PROT-07. The GitHub webhook receiver.
 *
 * Three rules, in this order: never trust an unsigned delivery, never handle
 * the same result twice, and never make GitHub wait for an agent. The work is
 * detached and this returns immediately — a webhook endpoint that blocks on a
 * sandbox gets its deliveries retried on top of the run it is still doing.
 */
export async function POST(req: NextRequest) {
  const secret = env().GITHUB_WEBHOOK_SECRET;

  if (!secret) {
    // Refusing is the only safe answer: accepting unsigned deliveries would
    // let anyone who finds this URL drive an agent with a credit card.
    return Response.json(
      { ok: false, reason: "GITHUB_WEBHOOK_SECRET is not configured." },
      { status: 503 },
    );
  }

  const raw = await req.text();
  const signature = req.headers.get("x-hub-signature-256");

  if (!verifySignature(raw, signature, secret)) {
    return Response.json(
      { ok: false, reason: "Bad signature." },
      { status: 401 },
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return Response.json({ ok: false, reason: "Malformed body." }, { status: 400 });
  }

  const signals = interpret(req.headers.get("x-github-event") ?? "", payload);
  if (signals.length === 0) {
    return Response.json({ ok: true, handled: 0, ignored: true }, { status: 202 });
  }

  // One GitHub App webhook serves every repository, and one repository can
  // be on several people's boards. Every project on it hears the signal;
  // only the one whose ticket holds that pull request acts on it.
  const repo = repository();
  const fullName = (payload as { repository?: { full_name?: unknown } })
    ?.repository?.full_name;
  const projects = typeof fullName === "string" ? await repo.projectsForRepo(fullName) : [];
  let handled = 0;

  for (const signal of signals) {
    // At-least-once delivery, made exactly-once here. The key is the result
    // itself, not the delivery id, so a redelivery under a new id is still
    // the same result and still does nothing.
    if (!(await repo.claimDelivery(signal.key))) continue;
    handled++;

    for (const project of projects) {
      if (signal.kind === "runner") {
        launch(
          () => completeCliRun(project.id, signal),
          `agent run ${signal.job} finishing`,
        );
      } else if (signal.kind === "ci") {
        launch(
          () => reviewPullRequest(project.id, signal.prNumber, signal.headSha),
          `review of pull request ${signal.prNumber}`,
        );
      } else {
        launch(
          () => markMergedExternally(project.id, signal.prNumber),
          `external merge of pull request ${signal.prNumber}`,
        );
      }
    }
  }

  return Response.json(
    { ok: true, handled, received: signals.length },
    { status: 202 },
  );
}
