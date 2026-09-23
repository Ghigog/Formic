import { listRepositories } from "@/lib/vcs/repositories";

export const dynamic = "force-dynamic";

/** What the repository picker offers. */
export async function GET() {
  const result = await listRepositories();
  return Response.json(result);
}
