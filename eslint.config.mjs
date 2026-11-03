import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

/**
 * Next.js's own rules (React, hooks, accessibility, Core Web Vitals) and
 * typescript-eslint's recommended set. Prisma's generated client, and the
 * loop entry installed beside the workflow, are build artifacts — minified
 * and not ours to lint.
 */
export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    linterOptions: { reportUnusedDisableDirectives: "error" },
    rules: {
      // A leading underscore marks a parameter or binding kept on purpose:
      // an interface's argument a mock ignores, a key dropped by a rest.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
    },
  },
  {
    // The domain layer is framework-free: a value import may only come from
    // zod or from the domain itself. `import type` stays legal.
    files: ["src/lib/domain/**/*.ts"],
    ignores: ["**/*.test.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "^(?!zod$|\\.{1,2}(/|$)|@/lib/domain(/|$))",
              allowTypeImports: true,
              message:
                "src/lib/domain may only value-import from zod or other domain files. Use `import type` or move the shared value into src/lib/domain.",
            },
          ],
        },
      ],
    },
  },
  globalIgnores([
    ".next/**",
    "src/generated/**",
    // The loop entry a job runs is committed beside its workflow (RUNNER_ENTRY_PATH
    // in src/lib/runner/workflow.ts), minified, with the same code as src/generated.
    ".github/formic/**",
    "coverage/**",
    "playwright-report/**",
    "test-results/**",
    "next-env.d.ts",
  ]),
]);
