import "server-only";

import { randomUUID } from "node:crypto";

import { E2BSandboxProvider } from "./e2b";
import { LocalSandboxProvider } from "./local";
import {
  type SandboxHandle,
  type SandboxProvider,
  type SpawnOptions,
} from "./types";
import { env } from "@/lib/secrets/env";
import { publish } from "@/lib/events/bus";

/**
 * Provider selection and the live sandbox registry.
 *
 * Every sandbox is tracked here so the ambient bar can report how many are
 * running and the global stop can dispose them all. A sandbox that is not in
 * this map is a leak by definition.
 */

declare global {
  // eslint-disable-next-line no-var
  var __formicSandboxes: Map<string, SandboxHandle> | undefined;
}

function live(): Map<string, SandboxHandle> {
  if (!globalThis.__formicSandboxes) globalThis.__formicSandboxes = new Map();
  return globalThis.__formicSandboxes;
}

export function sandboxProvider(): SandboxProvider {
  return env().SANDBOX_PROVIDER === "e2b"
    ? new E2BSandboxProvider()
    : new LocalSandboxProvider();
}

export function activeSandboxCount(): number {
  return live().size;
}

export async function spawnSandbox(
  projectId: string,
  options: SpawnOptions,
): Promise<SandboxHandle> {
  const provider = sandboxProvider();
  const handle = await provider.spawn(options);

  live().set(handle.id, handle);
  await announce(projectId, provider.name);

  // Wrap dispose so the registry cannot drift from reality, including when a
  // sandbox disposes itself on its TTL rather than being told to.
  const original = handle.dispose.bind(handle);
  handle.dispose = async () => {
    await original();
    live().delete(handle.id);
    await announce(projectId, provider.name);
  };

  return handle;
}

export async function disposeAllSandboxes(projectId: string): Promise<number> {
  const handles = [...live().values()];
  await Promise.allSettled(handles.map((h) => h.dispose()));
  live().clear();
  await announce(projectId, sandboxProvider().name);
  return handles.length;
}

async function announce(projectId: string, provider: string): Promise<void> {
  await publish(projectId, {
    type: "sandbox.count",
    active: activeSandboxCount(),
    provider,
  });
}

/**
 * Runs work against a fresh sandbox and disposes it no matter how the work
 * ends. The only supported way to obtain a sandbox from application code.
 */
export async function withSandbox<T>(
  projectId: string,
  options: SpawnOptions,
  work: (sandbox: SandboxHandle) => Promise<T>,
): Promise<T> {
  const handle = await spawnSandbox(projectId, options);
  try {
    return await work(handle);
  } finally {
    await handle.dispose();
  }
}

export function newBranchName(ticketKey: string): string {
  return `formic/${ticketKey.toLowerCase()}-${randomUUID().slice(0, 6)}`;
}

export * from "./types";
