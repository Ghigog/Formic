# Third parties

**Version:** 2026-09-24 (matches `CURRENT_TERMS_VERSION` in
`src/lib/auth/user.ts`)

Formic is a coordination layer. To do its job it sends your repository's
code, your prompts, and sometimes your own credentials to the third parties
below, on your behalf. This is the full list. Nothing else receives your
code or prompts.

## AI providers

Whichever you pick, per column, on your own account or key.

- **Anthropic (Claude)** — code, prompts and file contents for the columns
  you run on it. Anthropic's API. United States.
- **OpenAI (GPT, Codex)** — same, for columns run on OpenAI or on your ChatGPT
  sign-in via Codex. United States.
- **Google (Gemini)** — same, for columns run on Gemini or the Gemini CLI.
  United States. Google's own terms say free-tier prompts may be used to
  improve Google's products; Formic's Settings page repeats this warning
  next to the Gemini key field.
- **DeepSeek** — same, for columns run on DeepSeek. **Servers and company are
  in the People's Republic of China**; code and prompts sent to DeepSeek are
  processed there and subject to Chinese law, including lawful government
  access. Do not point DeepSeek at a repository you cannot send there.
- **OpenRouter** — same, for columns run on OpenRouter. Routes to whichever
  underlying model you pick through it; that model's own data handling
  applies in addition to OpenRouter's.
- **Groq** — same, for columns run on Groq. United States.

### Subscription and sign-in credentials

Claude Code and Codex let you run a column on a Claude subscription token or
a ChatGPT sign-in instead of an API key. That credential is stored encrypted
and used only to run the official `claude` or `codex` CLI, unattended, inside
your repository's own GitHub Actions — the same tool and the same account
activity your provider's consumer terms already anticipate for automated,
scripted use. Anthropic's and OpenAI's consumer terms are written for a
person driving the CLI, not a scheduled job; running it this way is a
reasonable reading of "your own use" but has not been confirmed with either
provider in writing. You are responsible for your account staying in good
standing with your provider; Formic labels these options as running "on your
own plan, at your own risk" in Settings.

## Infrastructure

- **E2B** — runs Coder Agents in an isolated sandbox: your repository
  checkout, and whatever the agent writes or executes there, including
  package installs. On your own E2B key, or the operator's fallback key
  where offered. United States.
- **GitHub** — your repository contents, issues, pull requests, Actions runs
  and workflow secrets, through the Formic GitHub App and your own
  installation token. United States. You control this already: uninstalling
  the app or revoking access stops it.
- **Vercel** — hosts the Formic application and its database traffic passes
  through its network. United States.

## What is never sent anywhere

Your GitHub App token, sandbox key and AI provider keys are encrypted at
rest (AES-256-GCM) and are never sent back to your browser or logged.
