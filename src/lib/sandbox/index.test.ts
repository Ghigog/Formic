import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { E2BSandboxProvider } from "./e2b";
import {
  LOCAL_SANDBOX_ON_VERCEL,
  activeSandboxCount,
  disposeSandboxes,
  newBranchName,
  sandboxProvider,
  spawnSandbox,
  withSandbox,
} from "./index";
import { LocalSandboxProvider } from "./local";
import { resetEnvCache } from "@/lib/secrets/env";
import { publish } from "@/lib/events/bus";

vi.mock("@/lib/events/bus", () => ({ publish: vi.fn() }));

const fakes = vi.hoisted(() => {
  let n = 0;
  const make = (name: string) => {
    const disposeById = vi.fn(async (_id: string, _key?: string | null) => {});
    return class {
      static disposeById = disposeById;
      name = name;
      disposeById = disposeById;
      async spawn() {
        const id = `${name}-${++n}`;
        return { id, dispose: vi.fn(async () => {}) };
      }
    };
  };
  return { E2B: make("e2b"), Local: make("local") };
});

vi.mock("./e2b", () => ({ E2BSandboxProvider: fakes.E2B }));
vi.mock("./local", () => ({ LocalSandboxProvider: fakes.Local }));

beforeEach(() => {
  globalThis.__formicSandboxes = undefined;
  vi.mocked(publish).mockClear();
});

/**
 * The provider selector reads SANDBOX_PROVIDER (defaulting to local) and
 * refuses the local provider on Vercel.
 */

afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvCache();
});

describe("sandboxProvider", () => {
  it("returns the E2B provider when SANDBOX_PROVIDER is e2b", () => {
    vi.stubEnv("SANDBOX_PROVIDER", "e2b");
    expect(sandboxProvider()).toBeInstanceOf(E2BSandboxProvider);
  });

  it("returns the local provider when SANDBOX_PROVIDER is local", () => {
    vi.stubEnv("SANDBOX_PROVIDER", "local");
    vi.stubEnv("VERCEL", "");
    expect(sandboxProvider()).toBeInstanceOf(LocalSandboxProvider);
  });

  it("falls back to the local provider when SANDBOX_PROVIDER is unset", () => {
    vi.stubEnv("SANDBOX_PROVIDER", undefined);
    vi.stubEnv("VERCEL", "");
    expect(sandboxProvider()).toBeInstanceOf(LocalSandboxProvider);
  });

  it("refuses the local provider on Vercel", () => {
    vi.stubEnv("SANDBOX_PROVIDER", "local");
    vi.stubEnv("VERCEL", "1");
    expect(() => sandboxProvider()).toThrow(LOCAL_SANDBOX_ON_VERCEL);
  });

  it("still returns E2B on Vercel", () => {
    vi.stubEnv("SANDBOX_PROVIDER", "e2b");
    vi.stubEnv("VERCEL", "1");
    expect(sandboxProvider()).toBeInstanceOf(E2BSandboxProvider);
  });
});

describe("sandbox registry", () => {
  const opts = {} as never;

  function useLocal() {
    vi.stubEnv("SANDBOX_PROVIDER", "local");
    vi.stubEnv("VERCEL", "");
  }

  it("tracks a spawned sandbox and announces the count", async () => {
    useLocal();
    const handle = await spawnSandbox("p1", opts);
    expect(activeSandboxCount()).toBe(1);
    expect(publish).toHaveBeenLastCalledWith("p1", {
      type: "sandbox.count",
      active: 1,
      provider: "local",
    });
    await handle.dispose();
    expect(activeSandboxCount()).toBe(0);
    expect(publish).toHaveBeenLastCalledWith("p1", {
      type: "sandbox.count",
      active: 0,
      provider: "local",
    });
  });

  it("withSandbox disposes after the work, even when it throws", async () => {
    useLocal();
    await expect(
      withSandbox("p1", opts, async () => {
        expect(activeSandboxCount()).toBe(1);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(activeSandboxCount()).toBe(0);
    await expect(withSandbox("p1", opts, async () => 42)).resolves.toBe(42);
    expect(activeSandboxCount()).toBe(0);
  });

  it("disposeSandboxes returns 0 for no ids without announcing", async () => {
    useLocal();
    expect(await disposeSandboxes("p1", [])).toBe(0);
    expect(publish).not.toHaveBeenCalled();
  });

  it("disposeSandboxes disposes live handles and kills unknown ids by provider", async () => {
    vi.stubEnv("SANDBOX_PROVIDER", "e2b");
    const handle = await spawnSandbox("p1", opts);
    const count = await disposeSandboxes("p1", [handle.id, "remote-1"], "key");
    expect(count).toBe(2);
    expect(activeSandboxCount()).toBe(0);
    const killed = fakes.E2B.disposeById;
    expect(killed).toHaveBeenCalledWith("remote-1", "key");
    expect(killed).not.toHaveBeenCalledWith(handle.id, "key");
  });
});

describe("newBranchName", () => {
  it("lowercases the ticket key and adds a short random suffix", () => {
    expect(newBranchName("EPIC-1-T2")).toMatch(
      /^formic\/epic-1-t2-[0-9a-f]{6}$/,
    );
  });
});
