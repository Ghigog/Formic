/**
 * The terms and privacy policy shown for acceptance. Kept in sync by hand
 * with the published documents in docs/legal/ — those are the same text,
 * for reading outside the app.
 */

export const TERMS_MD = `
## What Formic does

Formic orchestrates AI agents against a repository you connect: it turns a
raw request into a PRD, a PRD into tickets, and runs coding agents in
sandboxes that push branches and open pull requests. See the third-party
list below for exactly which outside services your code, prompts and
credentials pass through to do this.

## Agents act with permissions off

Coder and CLI agents run unattended, with their tool's permission prompts
disabled, so a run can finish without a person approving each step. An
agent can read, write, execute and delete anything reachable from its
sandbox or its GitHub Actions checkout, within the ticket's declared file
scope, which Formic checks server-side before anything reaches a real
branch — but that check applies to the diff an agent produces, not to
what it may run locally to get there. Review every pull request before
merging it into a branch that matters.

**Liability for agent actions.** To the maximum extent the law allows,
Formic and its operator are not liable for any loss, damage or cost arising
from an action an agent takes in your repository, sandbox, or connected
accounts. You remain responsible for what you connect Formic to, for
reviewing agent output before it reaches a protected branch, and for the
credentials you provide it.

## Your credentials

You may provide Formic with API keys, an E2B sandbox key, or a Claude
subscription token / ChatGPT sign-in. You are responsible for keeping these
in good standing with their provider. Formic encrypts them at rest and
never displays a saved key back to you.

## No warranty

The service is provided "as is", without warranty of any kind. Beta
software has bugs; do not point it at a repository or branch you cannot
afford to have broken.

## Changes to these terms

When these terms change materially, a new version is published and
everyone — including someone who accepted an earlier version — is asked to
accept the new one before using the board again.
`.trim();

export const PRIVACY_MD = `
## What Formic collects

- Your GitHub profile and a GitHub App token, to sign you in and act as you.
- Repository content: whatever a run reads or writes to do the work you asked for.
- Your prompts and requests.
- Credentials you choose to add, encrypted at rest and never shown back to you.
- Usage and cost data, to show you the board and enforce spend ceilings.

## Where it goes

- **Anthropic, OpenAI, Google, DeepSeek, OpenRouter, Groq** — whichever AI
  provider you pick, per column: your code, files and prompts for that
  column. **DeepSeek processes data in the People's Republic of China**,
  under Chinese law.
- **E2B** — runs Coder Agents in an isolated sandbox: your checkout and what
  the agent does there.
- **GitHub** — your repository, issues, pull requests and Actions runs,
  through the Formic GitHub App and your own token.
- **Vercel** — hosts the application.

Formic does not sell your data, and sends your code or prompts nowhere not
on this list. Claude Code and Codex can also run on your own subscription
token or ChatGPT sign-in instead of an API key — labelled "on your own plan,
at your own risk" where you add one, since that pattern hasn't been
confirmed in writing by either provider.

## Retention and your rights

Data is kept for as long as your account exists. You can ask to see, correct
or delete what Formic holds about you by contacting the operator.

## Security

Tokens and keys are encrypted at rest (AES-256-GCM) and never returned to
the browser. Access to another person's boards, presets or runs is enforced
server-side.

## Changes to this policy

Handled the same way as the Terms of Service: a material change is
published as a new version, and you are asked to accept it again.
`.trim();
