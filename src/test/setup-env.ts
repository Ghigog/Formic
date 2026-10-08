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
  "VERCEL_PROJECT_PRODUCTION_URL",
];

for (const name of REAL) delete process.env[name];

// A Formic GitHub Actions job sets its own FORMIC_* variables (FORMIC_PROGRESS,
// FORMIC_NOTES, FORMIC_DONE, FORMIC_START, FORMIC_CHECKPOINT,
// FORMIC_ATTACHMENTS), and the loop entry reads FORMIC_PROGRESS at runtime
// (src/lib/runner/loop-entry.ts). Left in place, a test running inside the
// platform's own runner would see the job's checkpoint variables and stop being
// hermetic: the same run would green locally and red in the job. Strip every
// FORMIC_* variable, so a test that needs one sets it with vi.stubEnv and its
// value is the test's own.
for (const name of Object.keys(process.env)) {
  if (name.startsWith("FORMIC_")) delete process.env[name];
}
