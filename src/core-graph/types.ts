/** Who performed a write: an AI agent or a human. Kept on every change to measure curator agreement. */
export type Actor = `agent:${string}` | `human:${string}`;
