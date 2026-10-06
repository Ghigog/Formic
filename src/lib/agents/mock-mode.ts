/**
 * Whether agents run as mocks.
 *
 * Mocks are a development and test affordance, and only ever chosen
 * explicitly with `AGENT_PROVIDER=mock`. They are never selected because a key
 * is missing: a column with no agent on a board a person is actually using is
 * *unassigned*, so its card stops and asks for one rather than being worked on
 * by a mock. See `resolveColumn` in ./presets.
 *
 * This is a leaf module on purpose. Both the agent registry and the GitHub
 * layer (`vcs`) read it, and neither may import the other: with mocks on, the
 * GitHub layer is mocked too, so a mock run stays self-contained and can never
 * open a real pull request, whatever token the process happens to hold.
 */
export function mockAgentsEnabled(): boolean {
  return process.env.AGENT_PROVIDER === "mock";
}
