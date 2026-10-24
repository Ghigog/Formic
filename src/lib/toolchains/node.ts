import type { Toolchain } from "./types";

/**
 * Node, by its lockfile. Installed in the job only: an in-process run has
 * always left `npm ci` to the agent, which knows whether the ticket needs it,
 * and its sandbox minutes are the ones that cost.
 */
export const node: Toolchain = {
  id: "node",
  name: "Node",
  markers: ["package-lock.json", "pnpm-lock.yaml", "yarn.lock"],
  setup: (host) =>
    host === "job"
      ? `# Installed, never handed back: kept out of what the agent commits.
echo "node_modules/" >> .git/info/exclude
if [ -f package-lock.json ]; then npm ci --prefer-offline --no-audit --fund=false
elif [ -f pnpm-lock.yaml ]; then corepack enable && pnpm install --frozen-lockfile
elif [ -f yarn.lock ]; then corepack enable && yarn install
fi`
      : null,
  cache: {
    paths: ["~/.npm", "~/.cache/yarn", "~/.local/share/pnpm/store"],
    keyFiles: ["**/package-lock.json", "**/yarn.lock", "**/pnpm-lock.yaml"],
  },
  ci: null,
};
