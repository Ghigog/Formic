/**
 * Tests never touch anything real. A developer's shell, or a cloud session,
 * may carry a GitHub token or a database address; left in place, a test
 * that forgets to install the mock would push branches to that repository
 * or write to that database. Every real credential is removed before any
 * test runs. A test that needs one sets it with vi.stubEnv.
 */
const REAL = [
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GITHUB_REPO",
  "GITHUB_APP_CLIENT_ID",
  "GITHUB_APP_CLIENT_SECRET",
  "GITHUB_WEBHOOK_SECRET",
  "DATABASE_URL",
  "POSTGRES_PRISMA_URL",
  "POSTGRES_URL",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "E2B_API_KEY",
  "FORMIC_URL",
  "VERCEL_PROJECT_PRODUCTION_URL",
];

for (const name of REAL) delete process.env[name];
