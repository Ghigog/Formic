import "server-only";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { UserRecord } from "@/lib/db/repository";
import { prdSchema } from "@/lib/domain/entities";
import { COLUMNS } from "@/lib/domain/status";
import {
  commentCard,
  createBacklogCard,
  createEpic,
  getCard,
  getColony,
  listBoards,
  listCards,
  moveCard,
  updateCard,
  type ToolResult,
} from "./tools";

const reply = (result: ToolResult<unknown>) =>
  result.ok
    ? { content: [{ type: "text" as const, text: JSON.stringify(result.value) }] }
    : { content: [{ type: "text" as const, text: result.error }], isError: true };

/** A server for one request, whose tools act as one person: read-only when their token is. */
export function mcpServerFor(user: UserRecord, readOnly: boolean): McpServer {
  const caller = { user, readOnly };
  const server = new McpServer({ name: "formic", version: "1.0.0" });
  const readHint = { readOnlyHint: true };
  server.registerTool(
    "list_boards",
    { description: "The boards you can see.", annotations: readHint },
    async () => reply({ ok: true, value: await listBoards(user) }),
  );
  server.registerTool(
    "list_cards",
    {
      description: "The cards on a board, optionally only those in one column.",
      inputSchema: { board: z.string(), column: z.enum(COLUMNS).optional() },
      annotations: readHint,
    },
    async (input) => reply(await listCards(user, input)),
  );
  server.registerTool(
    "get_card",
    {
      description: "One card: an Epic with its PRD, or a ticket with its description and acceptance criteria.",
      inputSchema: { board: z.string(), card: z.string() },
      annotations: readHint,
    },
    async (input) => reply(await getCard(user, input)),
  );
  server.registerTool(
    "get_colony",
    {
      description: "A board's colony level and XP progress within the level.",
      inputSchema: { board: z.string() },
      annotations: readHint,
    },
    async (input) => reply(await getColony(user, input)),
  );
  server.registerTool(
    "create_backlog_card",
    {
      description: "Adds a request to the board's Backlog, as the UI's New card does.",
      inputSchema: { board: z.string(), rawRequest: z.string().trim().min(3).max(4000) },
    },
    async (input) => reply(await createBacklogCard(caller, input)),
  );
  server.registerTool(
    "create_epic",
    {
      description: "Adds an Epic with its tickets, already broken down. Tickets name their dependencies by the key given here.",
      inputSchema: {
        board: z.string(),
        title: z.string().trim().min(1).max(120),
        rawRequest: z.string().trim().min(1).max(4000),
        tickets: z
          .array(
            z.object({
              key: z.string().min(1),
              title: z.string().trim().min(1),
              description: z.string(),
              acceptanceCriteria: z.array(z.string()),
              fileScope: z.array(z.string()).optional(),
              storyPoints: z.number().nullable().optional(),
              dependsOn: z.array(z.string()).optional(),
            }),
          )
          .min(1),
      },
    },
    async (input) => reply(await createEpic(caller, input)),
  );
  server.registerTool(
    "move_card",
    {
      description: "Moves a card to a column as dragging it would, and says why when the board refuses.",
      inputSchema: { board: z.string(), card: z.string(), to: z.enum(COLUMNS) },
    },
    async (input) => reply(await moveCard(caller, input)),
  );
  server.registerTool(
    "update_card",
    {
      description: "Edits a ticket's title, description, acceptance criteria, file scope or story points, or an Epic's PRD.",
      inputSchema: {
        board: z.string(),
        card: z.string(),
        title: z.string().trim().min(1).optional(),
        description: z.string().optional(),
        acceptanceCriteria: z.array(z.string()).optional(),
        fileScope: z.array(z.string()).optional(),
        storyPoints: z.number().nullable().optional(),
        prd: prdSchema.optional(),
      },
    },
    async ({ board, card, ...edit }) => reply(await updateCard(caller, { board, card, edit })),
  );
  server.registerTool(
    "comment_card",
    {
      description: "Writes a message in a card's chat as you. No agent answers it.",
      inputSchema: { board: z.string(), card: z.string(), text: z.string().trim().min(1).max(4000) },
    },
    async (input) => reply(await commentCard(caller, input)),
  );
  return server;
}
