# Privacy Policy

**Version:** 2026-09-24
**Status:** draft, pending review by qualified counsel before this closed
beta is offered commercially.

## What Formic collects

- **Your GitHub profile** (id, login, name, avatar) and a GitHub App token,
  to sign you in and act as you on repositories you install the app on.
- **Repository content**: whatever a run reads or writes — code, issues,
  pull requests, CI logs — to do the work you asked for.
- **Your prompts and requests**: what you type into a card, the assistant, or
  a raw backlog request.
- **Credentials you choose to add**: AI provider API keys, an E2B sandbox
  key, or a Claude/ChatGPT subscription credential for CLI agents. Stored
  encrypted (AES-256-GCM) and never shown back to you.
- **Usage and cost data**: tokens spent, run outcomes, and event history, to
  show you the board and enforce spend ceilings.

## Where it goes

See `docs/legal/third-parties.md` for the full, current list of third
parties, what each receives, and where it is processed — including the
provider you pick per column, your sandbox provider, GitHub, and the
platform Formic runs on. Formic does not sell your data, and does not send
your code or prompts anywhere not on that list.

## Retention

Data is kept for as long as your account exists, so the board, its history
and its cost accounting stay intact. Deleting your account removes your
rows from Formic's database and revokes its GitHub token; see the account
deletion feature (once shipped — for now, ask the operator to remove your
data by hand). Formic does not control retention on the third parties above:
their own policies govern what they keep once they've processed a request.

## Security

Tokens and keys are encrypted at rest and never returned to the browser.
Access to another person's boards, presets or runs is enforced server-side.
Webhook deliveries must be signed. See `README.md`'s security notes for more.

## Your rights

You can ask to see what Formic holds about you, ask for it to be corrected,
or ask for your account and its data to be deleted, by contacting the
operator (see `docs/legal/terms.md`). Formic being a small, self-hosted beta
today, these requests are handled by hand rather than through an automated
flow, until that changes.

## Children

Formic is not directed at, and should not be used by, anyone under 18.

## Changes to this policy

Handled the same way as the Terms of Service: a material change bumps
`CURRENT_TERMS_VERSION`, and you are asked to accept it again before using
the board.

## Contact

Questions about this policy: open an issue on this repository, or use the
contact the operator has published for this deployment.
