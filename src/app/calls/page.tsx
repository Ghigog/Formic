import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth/user";
import { activeProject } from "@/lib/board/project";
import { repository } from "@/lib/db";
import { guestOptions } from "@/lib/calls/guests";
import { scoreOf } from "@/lib/colony/game";
import { CallsView } from "@/components/calls/calls-view";

export const dynamic = "force-dynamic";

export default async function CallsPage() {
  const user = await currentUser();
  if (!user) redirect("/login?next=/calls");
  const project = await activeProject();
  if (!project) redirect("/");
  // Only Sentinels the colony has unlocked can be invited.
  const { level } = scoreOf(await repository().boardCards(project.id));
  return <CallsView guests={guestOptions(level)} />;
}
