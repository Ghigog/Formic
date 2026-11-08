# GitLab

Formic works on gitlab.com projects as well as GitHub repositories. People
always sign in by email first, then connect GitLab from Settings, the way
GitHub can be connected. gitlab.com only for now; a self-managed GitLab would
need its own address in `src/lib/auth/gitlab.ts` and `src/lib/vcs/gitlab-api.ts`.

## Setting it up (once, per deployment)

1. On gitlab.com: User settings, Applications, Add new application.
   - Name: Formic.
   - Redirect URI: `<FORMIC_URL>/api/auth/gitlab/callback`. On the production
     server that is `https://52-200-209-60.sslip.io/api/auth/gitlab/callback`.
   - Confidential: yes. Scopes: `api`.
2. Put its id and secret in the server's `.env`
   (`/opt/formic/shared/.env` in production) and restart:
   ```
   GITLAB_CLIENT_ID=...
   GITLAB_CLIENT_SECRET=...
   ```
3. Settings now shows a GitLab section, and the project picker lists the
   GitLab projects each person can push to.

In local mode, set `GITLAB_TOKEN` to a personal access token with the `api`
scope instead.

## How a board knows

A board on a GitLab project is named `gitlab:group/project`
(`src/lib/vcs/host.ts`). `vcs()` gives it the GitLab client
(`src/lib/vcs/gitlab.ts`), and its credentials carry the owner's GitLab
token as `repoToken`.

## Agents in GitLab CI

The first agent picked on a GitLab board asks before anything changes, as on
GitHub. On yes, Formic:

1. Lets the project's jobs push with their own token, and lets developers run
   pipelines with variables (`ci_push_repository_for_job_token_allowed`,
   `ci_pipeline_variables_minimum_override_role`). That takes a Maintainer;
   anyone else is told what to ask one for.
2. Registers a webhook for job events at `/api/webhooks/gitlab`, with a token
   derived from `FORMIC_SECRET` and the project's path, so a finished run is
   taken at once. Without `FORMIC_URL` there is no webhook, and the board's
   own sweep collects runs while it is open.
3. Opens one merge request adding `.gitlab/formic-agent.yml` and including it
   from `.gitlab-ci.yml`, keeping the rest of that file and its comments.

The job (`src/lib/runner/gitlab-ci-config.ts`) mirrors the GitHub workflow.
It only runs in pipelines Formic starts (`FORMIC_RUN` set), reads the run's
inputs from pipeline variables, and pushes the agent's work to a
`formic-staging/` branch. Agents read their sign-in from CI/CD variables
named `FORMIC_…`, which people add themselves; Formic stores only the names.
A Codex `auth.json` is multi-line, so it goes in a File variable.

Agents on an API key run the same runner release the GitHub Action pins,
downloaded at that commit and checked against its SHA-256 (`RUNNER_BUNDLE`)
before it runs.

## Where GitLab differs

GitLab's API has no equivalent for a few things Formic does on GitHub, so it
uses the nearest thing that never rewrites history:

- **Moving a branch to a commit**: checked to be a fast-forward, then the
  branch is made again at that commit. Protected branches refuse, which is
  wanted.
- **Merging one branch into another** (bringing a pull request up to date,
  merging into `formic/integration`): a merge request from one into the other,
  merged with a merge commit. GitLab's own "update" rebases, so it is not used.
- **Checkpoints**: a `formic-checkpoints/<card>` branch per card, its commit
  marked `[skip ci]`.
- **A merge an agent resolved**: the job pushes the real merge commit.
- **Sub-issues**: GitLab's free tier has none, so an Epic's issue is linked
  to its tickets' issues.
- **Security facts** for Sentinels: GitLab's security reports are not read
  yet; branch protection and visibility are.

A pipeline Formic starts also runs the project's own jobs, unless their rules
skip pipelines started through the API (`$CI_PIPELINE_SOURCE == "api"`).

## Not yet verified against gitlab.com

Everything above is tested against a fake gitlab.com and, for the job's
script, run end to end against a local git origin. It has not yet run against
a real gitlab.com project. The parts most worth watching on the first real
run: the two project settings in step 1, pipeline variables reaching the job,
and the job token's push.
