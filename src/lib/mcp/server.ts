import "server-only";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { UserRecord } from "@/lib/db/repository";
import { COLUMNS } from "@/lib/domain/status";
import { getCard, getColony, listBoards, listCards, type ToolResult } from "./tools";

const reply = (result: ToolResult<unknown>) =>
  result.ok
    ? { content: [{ type: "text" as const, text: JSON.stringify(result.value) }] }
    : { content: [{ type: "text" as const, text: result.error }], isError: true };

/** A server for one request, whose tools read as one person. */
export function mcpServerFor(user: UserRecord): McpServer {
  const server = new McpServer({ name: "formic", version: "1.0.0" });
  const readOnly = { readOnlyHint: true };
  server.registerTool(
    "list_boards",
    { description: "The boards you can see.", annotations: readOnly },
    async () => reply({ ok: true, value: await listBoards(user) }),
  );
  server.registerTool(
    "list_cards",
    {
      description: "The cards on a board, optionally only those in one column.",
      inputSchema: { board: z.string(), column: z.enum(COLUMNS).optional() },
      annotations: readOnly,
    },
    async (input) => reply(await listCards(user, input)),
  );
  server.registerTool(
    "get_card",
    {
      description: "One card: an Epic with its PRD, or a ticket with its description and acceptance criteria.",
      inputSchema: { board: z.string(), card: z.string() },
      annotations: readOnly,
    },
    async (input) => reply(await getCard(user, input)),
  );
  server.registerTool(
    "get_colony",
    {
      description: "A board's colony level and XP progress within the level.",
      inputSchema: { board: z.string() },
      annotations: readOnly,
    },
    async (input) => reply(await getColony(user, input)),
  );
  return server;
}
