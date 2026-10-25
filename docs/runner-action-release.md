# Publishing the runner Action

How to publish the Formic runner as its own GitHub Action, and why each step is there. This is EPIC-146-T2.

## The idea in one minute

When Formic gives a ticket to an agent, a GitHub workflow runs in that repository. The code that does the work is called the **runner**.

Right now the workflow downloads the runner from Formic each time. So if someone took over Formic, they could swap the download and run their own code in every connected repository. That is the problem this epic fixes.

The fix:

1. Put the runner in its **own public repository**, so anyone can read it.
2. Give it a **release** (`v1.0.0`), along with a **provenance attestation**. That is a signed record from GitHub saying "this exact file was built from this exact source". It proves nobody slipped in a different file.
3. Workflows point at the release by its **commit SHA**, the 40-character ID of one exact snapshot of the repository. A SHA can never be changed to point at something else, so a workflow pinned to it always runs the code that was reviewed.

T2 is steps 1 and 2, and recording the SHA. T3 then puts that SHA into the workflow Formic installs.

## What goes in the public repository

```
formic-runner/
├── action.yml                      what the Action is and the inputs it takes
├── README.md                       what it is, for people reading it
├── dist/index.mjs                  the runner itself, readable, not minified
├── dist/index.mjs.map              source map, so it can be read against the source
└── .github/workflows/release.yml   checks and attests each release
```

Why the built `dist/` is committed: a workflow that uses an Action by SHA runs exactly the files at that commit. It does not build anything first. So the runner file has to be in the repository.

Why that is still safe: the first line of `dist/index.mjs` names the Formic commit it was built from. On every release, `release.yml` rebuilds the runner from that Formic commit and compares the result with the committed file. If they differ by even one character, the release fails. If they match, it attests the file. The repository can't ship anything that didn't come from Formic's source.

## Steps

### 1. Create the empty repository

**Who:** you, on github.com. **Time:** one minute.

1. Open <https://github.com/new>.
2. Owner: `Ghigog`. Name: `formic-runner`.
3. Pick **Public**. (Anyone has to be able to read it, and attestations on a personal account need a public repository.)
4. Leave every "Add a README / .gitignore / license" box **unticked**, so the repository starts completely empty.
5. Click **Create repository**.

### 2. Fill it

**Who:** Claude, or anyone with Node 22 and a clone of Formic.

From a Formic checkout on `main`, with `npm ci` done:

```bash
git clone https://github.com/Ghigog/formic-runner.git ../formic-runner
FORMIC_BUILD_COMMIT=$(git rev-parse HEAD) node scripts/build-runner-action.mjs ../formic-runner/dist
cp runner-action/action.yml runner-action/README.md ../formic-runner/
mkdir -p ../formic-runner/.github/workflows
cp runner-action/release.yml ../formic-runner/.github/workflows/release.yml
cd ../formic-runner
git add -A
git commit -m "Formic runner, built from Formic $(head -1 dist/index.mjs | grep -oE '[0-9a-f]{40}')"
git push -u origin main
```

Build from a commit that is already pushed to Formic's `main`, so the release check can find it.

### 3. Tag v1.0.0

**Who:** the same person as step 2.

```bash
git tag v1.0.0
git push origin v1.0.0
```

A tag is a name pinned to one commit. Pushing a tag that starts with `v` starts `release.yml`.

### 4. Confirm the release passed

**Who:** you, on github.com.

1. Open <https://github.com/Ghigog/formic-runner/actions>. The **Release** run for `v1.0.0` should have a green tick.
2. Open <https://github.com/Ghigog/formic-runner/attestations>. There should be one for `dist/index.mjs`.

A red cross on "Check the committed runner matches the source" means `dist/` was built from different source than the commit it names. Redo step 2 from a clean `main`, delete the tag, and tag again.

Anyone can check the attestation for themselves:

```bash
gh attestation verify dist/index.mjs --repo Ghigog/formic-runner
```

### 5. Record the SHA for T3

```bash
git rev-parse v1.0.0
```

Write the 40 characters and the version under **Release record** below. T3 uses them to write the workflow line:

```yaml
uses: Ghigog/formic-runner@<the 40 characters> # v1.0.0
```

## Later releases

Same steps 2 to 5 with the next version (`v1.0.1`, `v1.1.0`, …). The repository already exists, so skip step 1. Add each one to the record.

## Release record

| Version | Commit SHA | Built from Formic |
| --- | --- | --- |
| v1.0.0 | `90a9f3cb8e99ae7592998805361d23e6c7cde474` | `0a77209fde34dd2974afce502fd6fef3f0e1a93d` |
