import { redirect } from "next/navigation";

import { CallsView } from "@/components/calls/calls-view";
import { currentUser } from "@/lib/auth/user";

export const dynamic = "force-dynamic";

export default async function CallsPage() {
  if (!(await currentUser())) redirect("/login?next=/calls");
  return <CallsView />;
}
