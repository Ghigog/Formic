import { redirect } from "next/navigation";

import { CallChat } from "@/components/calls/call-chat";
import { currentUser } from "@/lib/auth/user";
import { activeProject } from "@/lib/board/project";
import { featureUnlocked, scoreOf } from "@/lib/colony/game";
import { repository } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function CallPage({ params }: { params: Promise<{ meetingId: string }> }) {
  const { meetingId } = await params;
  if (!(await currentUser())) redirect(`/login?next=/calls/${meetingId}`);
  // Calls stay hidden until the board reaches their level: send the person back.
  const project = await activeProject();
  const level = project ? scoreOf(await repository().boardCards(project.id)).level : 1;
  if (!featureUnlocked("calls", level)) redirect("/");
  return <CallChat meetingId={meetingId} />;
}
