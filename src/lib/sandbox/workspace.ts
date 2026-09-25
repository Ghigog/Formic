import type { ExecOptions, ExecResult, SandboxHandle } from "./types";
import { ScopeError, pathInScope } from "@/lib/domain/scope";

/**
 * What a coding agent is allowed to do to a checkout.
 *
 * The sandbox provides isolation; this provides the verbs, and one of them —
 * writeFile — is where the file scope is enforced. An agent reaches a
 * repository only through a Workspace, so there is exactly one place to
 * decide whether an edit is permitted rather than a check at every call site.
 *
 * Two implementations: one over a real sandbox, and one in memory for tests
 * and for the demo path that runs with no GitHub credential.
 */

export interface Workspace {
  readonly id: string;
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, contents: string): Promise<void>;
  /** Paths changed since the clone, relative to the repository root. */
  changedFiles(): Promise<string[]>;
  /** Unified diff for one path, or for everything when omitted. */
  diff(path?: string): Promise<string>;
  /** Whether a path is outside the ticket's file scope, when it has one. */
  outsideScope?(path: string): boolean;
}

/** Single-quote for bash, escaping embedded quotes. */
function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * A relative path that cannot climb out of the checkout. Rejected here rather
 * than at the shell, because a path is model output and the shell would
 * happily write wherever it was told.
 */
export function safeRelativePath(raw: string): string {
  const trimmed = raw.trim().replace(/^\.\//, "");
  if (trimmed === "") throw new ScopeError("Empty path.");
  if (trimmed.startsWith("/")) {
    throw new ScopeError(`Absolute paths are not writable: ${raw}`);
  }
  if (trimmed.split("/").includes("..")) {
    throw new ScopeError(`Path may not escape the repository: ${raw}`);
  }
  return trimmed;
}

class SandboxWorkspace implements Workspace {
  constructor(private readonly sandbox: SandboxHandle) {}

  get id(): string {
    return this.sandbox.id;
  }

  exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    return this.sandbox.exec(command, options);
  }

  readFile(path: string): Promise<string> {
    return this.sandbox.readFile(safeRelativePath(path));
  }

  async writeFile(path: string, contents: string): Promise<void> {
    const target = safeRelativePath(path);
    const dir = target.includes("/")
      ? target.slice(0, target.lastIndexOf("/"))
      : ".";

    // Base64 rather than a heredoc: the payload is arbitrary source code, and
    // every quoting scheme that passes it through a shell literally has a
    // sequence that terminates it early. Base64 has no such sequence.
    const encoded = Buffer.from(contents, "utf8").toString("base64");
    const result = await this.sandbox.exec(
      `mkdir -p ${quote(dir)} && printf '%s' ${quote(encoded)} | base64 -d > ${quote(target)}`,
    );

    if (result.exitCode !== 0) {
      throw new Error(
        `Could not write ${target}: ${result.stderr.trim() || result.stdout.trim()}`,
      );
    }
  }

  changedFiles(): Promise<string[]> {
    return this.sandbox.changedFiles();
  }

  async diff(path?: string): Promise<string> {
    // --intent-to-add so a newly created file shows as a diff rather than as
    // nothing at all, which is the shape most of these changes take.
    const target = path ? ` -- ${quote(safeRelativePath(path))}` : "";
    const result = await this.sandbox.exec(
      `git add -A --intent-to-add . && git diff HEAD${target}`,
    );
    return result.exitCode === 0 ? result.stdout : "";
  }
}

export function sandboxWorkspace(sandbox: SandboxHandle): Workspace {
  return new SandboxWorkspace(sandbox);
}

/**
 * The file scope, enforced. An agent that tries to write outside its declared
 * scope gets an error it can read and correct from, not a silent no-op — the
 * run only fails if it insists.
 */
export function scopedWorkspace(
  inner: Workspace,
  fileScope: readonly string[],
): Workspace {
  return {
    id: inner.id,
    exec: (command, options) => inner.exec(command, options),
    readFile: (path) => inner.readFile(path),
    changedFiles: () => inner.changedFiles(),
    diff: (path) => inner.diff(path),
    // async, so a rejected write rejects its promise rather than throwing
    // synchronously out of a call the caller is awaiting.
    writeFile: async (path, contents) => {
      const target = safeRelativePath(path);
      if (!pathInScope(target, fileScope)) {
        throw new ScopeError(
          `${target} is outside this ticket's file scope (${fileScope.join(", ")}). ` +
            `Keep the fix inside it; if the right fix needs that file, send the ticket back saying so.`,
        );
      }
      return inner.writeFile(target, contents);
    },
  };
}

/**
 * The file scope, as guidance. A write outside it goes through, and the
 * workspace says so, so the agent can tell the person why; the pipeline asks
 * for the files before any of that work goes further.
 */
export function guidedWorkspace(
  inner: Workspace,
  fileScope: readonly string[],
): Workspace {
  return {
    id: inner.id,
    exec: (command, options) => inner.exec(command, options),
    readFile: (path) => inner.readFile(path),
    changedFiles: () => inner.changedFiles(),
    diff: (path) => inner.diff(path),
    writeFile: async (path, contents) => inner.writeFile(safeRelativePath(path), contents),
    outsideScope: (path) => !pathInScope(safeRelativePath(path), fileScope),
  };
}

/**
 * A checkout with no sandbox behind it. Used by the tests and by the demo
 * path that runs with no GitHub credential, where there is nothing to clone
 * and nowhere to push.
 */
export class MemoryWorkspace implements Workspace {
  readonly id = "memory";
  private readonly files = new Map<string, string>();
  private readonly touched = new Set<string>();
  readonly commands: string[] = [];

  constructor(
    seed: Record<string, string> = {},
    private readonly execHandler: (command: string) => ExecResult = () => ({
      exitCode: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
    }),
  ) {
    for (const [path, contents] of Object.entries(seed)) {
      this.files.set(path, contents);
    }
  }

  async exec(command: string): Promise<ExecResult> {
    this.commands.push(command);
    return this.execHandler(command);
  }

  async readFile(path: string): Promise<string> {
    const target = safeRelativePath(path);
    const contents = this.files.get(target);
    if (contents === undefined) {
      throw new Error(`No such file: ${target}`);
    }
    return contents;
  }

  async writeFile(path: string, contents: string): Promise<void> {
    const target = safeRelativePath(path);
    this.files.set(target, contents);
    this.touched.add(target);
  }

  async changedFiles(): Promise<string[]> {
    return [...this.touched].sort();
  }

  async diff(path?: string): Promise<string> {
    const paths = path ? [safeRelativePath(path)] : [...this.touched].sort();
    return paths
      .map((p) => {
        const body = (this.files.get(p) ?? "")
          .split("\n")
          .map((line) => `+${line}`)
          .join("\n");
        return `--- /dev/null\n+++ b/${p}\n${body}`;
      })
      .join("\n");
  }
}
