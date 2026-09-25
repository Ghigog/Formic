# AUD-05 legal review notes

Not a substitute for review by qualified counsel — a working record of what
was checked, and the decisions made from it, so a lawyer reviewing
`terms.md` and `privacy.md` before the beta goes commercial has the context.

## Provider terms: subscription tokens and sign-ins

Claude Code and Codex run on a person's own Claude subscription token or
ChatGPT sign-in rather than an API key, unattended, inside the repository's
own GitHub Actions.

- **Reasonable, not confirmed.** Both providers' consumer terms anticipate
  a person driving their official CLI (`claude`, `codex`) themselves; Formic
  runs the same, official CLI, unattended, on the account holder's own
  repository and their own compute (GitHub Actions minutes they pay for).
  That is a defensible reading of "your own use," but neither provider has
  confirmed it in writing for this pattern.
- **Decision:** ship it, labelled. `docs/legal/third-parties.md` and
  `docs/legal/terms.md` disclose the risk and put the account-standing
  responsibility on the user. The provider picker in Settings
  (`src/lib/llm/providers.ts`) should carry the same "on your own plan, at
  your own risk" language next to these two options — tracked separately
  (outside this ticket's file scope), since that file is not in it.
- **Revisit if:** either provider publishes terms that specifically address
  unattended CI use of a consumer credential.

## DeepSeek data residency

DeepSeek is a PRC company; prompts and code sent to it are processed on
servers there, under Chinese law. This is disclosed in
`docs/legal/third-parties.md`.

- **Decision:** keep DeepSeek available (its low cost is the point of
  offering it) but label it clearly rather than block it, since blocking a
  provider outright is a product decision with no clear legal requirement
  behind it yet, and Formic already lets each user opt in per column with
  their own key — nobody is defaulted onto DeepSeek. The same "processed in
  China" label belongs next to DeepSeek in Settings; tracked separately, for
  the same file-scope reason as above.
- **Revisit if:** a customer's own compliance obligations (export control,
  a client contract, sector regulation) rule DeepSeek out for them
  specifically — that is on them to decide with the disclosure given.

## Vercel plan

Vercel's Hobby plan's terms prohibit commercial use. Formic charges nobody
today, but a closed beta that expects to become a paid product should not
build on a plan whose terms it plans to outgrow.

- **Decision:** move to a Pro (or higher) plan before or at the point the
  beta stops being purely non-commercial. This is an account/billing change
  outside the repository; see the ticket's "for you" list.

## LICENSE

Formic is not open source today: the product is the hosted service, and the
source has commercial value the operator has not decided to give away.

- **Decision:** proprietary, all-rights-reserved `LICENSE`, distinct from
  the Terms of Service that governs using the hosted product. Revisit if the
  project's plans change (e.g. an open-core model).

## What still needs a human

- Counsel's review of `terms.md` and `privacy.md`, in particular the
  liability and indemnification language, before the beta is offered to
  anyone outside a trusted, consenting group.
- Confirmation (or a support ticket to Anthropic/OpenAI) on the subscription
  credential question above, if usage grows enough for it to matter.
- The Settings-page labelling changes named above, filed as a follow-up
  ticket against `src/lib/llm/providers.ts` and its editor.
