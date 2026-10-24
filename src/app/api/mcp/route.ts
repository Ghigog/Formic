import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { verifyToken } from "@/lib/access-tokens";
import { withActor } from "@/lib/auth/actor";
import { mcpServerFor } from "@/lib/mcp/server";

export const dynamic = "force-dynamic";

const unauthorized = () =>
  Response.json({ error: "Send a valid access token as a Bearer token." }, { status: 401, headers: { "WWW-Authenticate": "Bearer" } });

/** MCP over Streamable HTTP, stateless: a fresh server for each request, as the token's owner. */
async function handle(req: Request): Promise<Response> {
  const secret = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") ?? "")?.[1]?.trim();
  const verified = secret ? await verifyToken(secret) : null;
  if (!verified) return unauthorized();

  return withActor(verified.user.id, async () => {
    const server = mcpServerFor(verified.user);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(req);
  });
}

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
