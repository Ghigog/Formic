# Terms of Service / Beta Agreement

**Version:** 2026-09-24
**Status:** draft, pending review by qualified counsel before this closed
beta is offered commercially. Until reviewed, treat every clause below as a
statement of intent, not a binding contract.

Formic is closed-beta software. By signing in and connecting a repository
you agree to these terms.

## What Formic does

Formic orchestrates AI agents against a repository you connect: it turns a
raw request into a PRD, a PRD into tickets, and runs coding agents in
sandboxes that push branches and open pull requests. See `docs/legal/third-parties.md`
for exactly which outside services your code, prompts and credentials pass
through to do this.

## Agents act with permissions off

Coder and CLI agents run unattended, with their tool's permission prompts
disabled (for example `--dangerously-skip-permissions` or `yolo` mode), so
that a run can finish without a person approving each step. An agent can
read, write, execute and delete anything reachable from its sandbox or its
GitHub Actions checkout, within the ticket's declared file scope, which
Formic checks server-side before anything reaches a real branch — but the
scope check is applied to the diff an agent produces, not to what it may run
locally to get there (tests, installs, scripts). Review every pull request
before merging it into a branch that matters. Formic is a coordination layer,
not a substitute for that review.

**Liability for agent actions.** To the maximum extent the law allows,
Formic and its operator are not liable for any loss, damage or cost arising
from an action an agent takes in your repository, sandbox, or connected
accounts — including but not limited to a destructive command, a leaked
secret an agent's diff exposed, a broken build, or a merge you did not review
before approving. You remain responsible for what you connect Formic to, for
reviewing agent output before it reaches a protected branch, and for the
credentials you provide it. Formic's total liability for any claim relating
to the service is limited to the amount you paid for it in the three months
before the claim arose (zero, for beta users on no plan).

## Your credentials

You may provide Formic with API keys, an E2B sandbox key, or a Claude
subscription token / ChatGPT sign-in. You are responsible for keeping these
in good standing with their provider and for revoking them if you believe
they were exposed. Formic encrypts them at rest and never displays a saved
key back to you.

## No warranty

The service is provided "as is", without warranty of any kind, express or
implied. Beta software has bugs; do not point it at a repository or branch
you cannot afford to have broken.

## Changes to these terms

When these terms change materially, `CURRENT_TERMS_VERSION` in
`src/lib/auth/user.ts` is bumped, and everyone — including someone who
accepted an earlier version — is asked to accept the new one before using
the board again.

## Ending your access

You may stop using Formic at any time. The operator may suspend or end
access to the beta at its discretion, including for a user removed from
`FORMIC_ALLOWED_USERS`. See `docs/legal/privacy.md` for what happens to your
data when you leave.

## Contact

Questions about these terms: open an issue on this repository, or use the
contact the operator has published for this deployment.
