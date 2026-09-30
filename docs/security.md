# Security

How the repository keeps the supply chain, and what to do when something in
it turns out to be weak.

## Actions are pinned by commit SHA

Every third-party action in `.github/workflows/` is referenced by the full
commit SHA its release tag points at, with the tag kept as a `# vX.Y.Z`
comment so a human can still read which version runs:

```yaml
- uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0
```

A tag can be moved on GitHub's side, and a workflow that references one runs
whatever the tag points at *then* — with our secrets attached. A commit SHA
cannot be moved, so the workflow runs the code that was reviewed.

**Never add an action by tag or branch.** Look up the SHA the release tag
points at (for example `git ls-remote https://github.com/actions/checkout
refs/tags/v4.4.0`, or the tag's page on GitHub) and reference that, with the
tag in the comment.

### Keeping the pins current

Dependabot (`.github/dependabot.yml`) opens a pull request whenever one of
the pinned actions publishes a new release: the diff bumps the SHA and the
comment together. Review it like any code change — the action's own
release notes say what moved — and merge. A pin that goes unmerged stops
being a pin on a version anyone has looked at, so don't let them queue up.

`formic-agent.yml` is installed by Formic and replaced when its version
changes; Formic pins the actions in it the same way, and Formic's own
Dependabot keeps them current.

## npm audit and the Prisma tooling overrides

`npm audit` should report no vulnerabilities. The tooling dependencies
have a history of pulling in vulnerable code that the app itself never
loads, and the `overrides` in `package.json` exist to keep both sides true:

- **`mysql2` → `3.24.5`.** The `prisma` CLI depends on `mysql2@3.15.3`,
  which had advisories for an auth-plugin downgrade leaking plaintext
  credentials and an unbounded zlib inflate in the compressed protocol
  (GHSA-3f6p-5ww8-9rcr, GHSA-rgwj-5xj2-c3m3). The app talks to Postgres
  only, so nothing here opens a MySQL connection — but the audit signal
  is worth keeping clean.
- **`deepmerge-ts` → `8.0.2`.** `@prisma/config`, which `prisma.config.ts`
  loads, depended on `deepmerge-ts@7.1.5` (stack exhaustion on recursive
  object graphs, GHSA-ggr8-5vv4-36mx). `prisma.config.ts` merges no
  recursive structures, so it was not reachable either.

Overrides pin exact versions: `prisma` still declares its own range, but
`npm ci` installs the override everywhere, which is what keeps
`npm audit` quiet and `prisma generate` working. Both have been verified
to work with `prisma@7` (`prisma generate`, `prisma db push`, migrate
status, Studio's config loading all exercise them).

When a new `prisma` release comes in and `npm audit` starts reporting
advisories again, first try raising these overrides to a patched version.
Drop an override only when the package above it declares a fixed version
on its own — leaving a stale override in place masks what Prisma actually
ships, which is worse than the advisory it hides. Dependabot (npm
ecosystem) opens the update pull requests; check the audit report in the
diff before merging.
