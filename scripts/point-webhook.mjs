#!/usr/bin/env node
/**
 * Points the GitHub App's webhook at the host that is serving Formic, so CI
 * results and finished runs reach the board wherever it runs. The deploy job
 * calls this after deploying: at Railway when Vercel is out, and back at
 * Vercel once it deploys again. See docs/runbook.md.
 *
 *   GITHUB_APP_ID=… GITHUB_APP_PRIVATE_KEY=… node scripts/point-webhook.mjs https://host
 *
 * Only the URL changes; the secret, content type and events stay as they are.
 */

import { createSign } from "node:crypto";

const [origin] = process.argv.slice(2);
const appId = process.env.GITHUB_APP_ID?.trim();
const key = process.env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, "\n").trim();

if (!origin || !/^https:\/\/[^/]+$/.test(origin.replace(/\/+$/, ""))) {
  console.error("Usage: point-webhook.mjs https://host");
  process.exit(2);
}
if (!appId || !key) {
  console.log("::warning::GITHUB_APP_ID or GITHUB_APP_PRIVATE_KEY is not set, so the GitHub App's webhook was left where it was.");
  process.exit(0);
}

const b64 = (v) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iat: now - 60, exp: now + 540, iss: appId })}`;
const jwt = `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(key, "base64url")}`;

const api = (method, body) =>
  fetch("https://api.github.com/app/hook/config", {
    method,
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

const url = `${origin.replace(/\/+$/, "")}/api/webhooks/github`;
const current = await api("GET");
if (!current.ok) {
  console.error(`::error::Could not read the GitHub App's webhook (${current.status}): ${await current.text()}`);
  process.exit(1);
}
const { url: was } = await current.json();
if (was === url) {
  console.log(`The GitHub App's webhook already points at ${url}.`);
  process.exit(0);
}

const updated = await api("PATCH", { url });
if (!updated.ok) {
  console.error(`::error::Could not move the GitHub App's webhook (${updated.status}): ${await updated.text()}`);
  process.exit(1);
}
console.log(`Moved the GitHub App's webhook from ${was} to ${url}.`);
