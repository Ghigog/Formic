# Notes for agents working on Formic

## Where production runs

Production is **one AWS Lightsail instance**, not Vercel.

- **URL:** https://52-200-209-60.sslip.io (an `sslip.io` name for the
  instance's IP; there is no custom domain).
- **Server:** Node serves the app, Caddy puts HTTPS in front, Postgres runs on
  the same machine. Set up by `deploy/server/setup.sh`; guide in
  [`docs/aws.md`](docs/aws.md).
- **Config:** `/opt/formic/shared/.env` on the server, not a hosting
  dashboard. `FORMIC_URL` is set there to the URL above.
- **Deploys:** manual, from `main`: Actions → CI → Run workflow. With the
  `DEPLOY_HOST` repository variable set, the `deploy` job builds on the CI
  runner, ships the build over SSH, and `deploy/server/deploy.sh` migrates
  and switches to it.
- **GitLab:** gitlab.com projects work once `GITLAB_CLIENT_ID` and
  `GITLAB_CLIENT_SECRET` are in that `.env` ([`docs/gitlab.md`](docs/gitlab.md)).
  A board on one is named `gitlab:group/project`.
- **No preview deploys.** A PR is never deployed anywhere; CI runs its tests
  against throwaway databases.

So, when reasoning about production:

- Don't assume Vercel features or variables (`VERCEL`, `VERCEL_ENV`,
  `VERCEL_URL`, preview deployments, the Vercel dashboard). They are unset in
  production. The Vercel code paths and `docs/vercel.md` are kept for anyone
  who deploys there, but they are not this deployment.
- Requests reach Next through Caddy, so `req.url` is not the public address:
  use `FORMIC_URL` (`src/lib/origin.ts`).
- Functions have no time limit here: agent runs keep going after a response.
- Anything needing a domain you control (DNS records, email sending domains)
  isn't available: `sslip.io` and `vercel.app` names can't take DNS records.
  Sign-in emails go out over SMTP through a Gmail account with an app
  password (`SMTP_*` and `FORMIC_EMAIL_FROM` in the server's `.env`), not
  Resend.
