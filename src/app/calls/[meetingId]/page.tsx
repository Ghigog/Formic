import { redirect } from "next/navigation";

import { CallChat } from "@/components/calls/call-chat";
import { currentUser } from "@/lib/auth/user";

export const dynamic = "force-dynamic";

export default async function CallPage({ params }: { params: Promise<{ meetingId: string }> }) {
  const { meetingId } = await params;
  if (!(await currentUser())) redirect(`/login?next=/calls/${meetingId}`);
  return <CallChat meetingId={meetingId} />;
}
