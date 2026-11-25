/**
 * The app servers the board specs run against, one per worker. Each has its
 * own in-memory store, so a worker's cards are its own. The accounts server
 * takes the port between them (playwright.config.ts).
 */
export const E2E_PORT = Number(process.env.E2E_PORT ?? 3210);
export const E2E_SERVERS = [`http://127.0.0.1:${E2E_PORT}`, `http://127.0.0.1:${E2E_PORT + 2}`];
