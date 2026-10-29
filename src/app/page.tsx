import { redirect } from "next/navigation";
import { BoardShell } from "@/components/board/board-shell";
import { Welcome } from "@/components/board/welcome";
import { boardPropsFor } from "@/lib/board/board-props";
import { activeProject } from "@/lib/board/project";
import { currentUser } from "@/lib/auth/user";
import { authMode } from "@/lib/auth/session";
import type { Account } from "@/components/board/account-menu";

export const dynamic = "force-dynamic";

export default async function BoardPage() {
  const user = await currentUser();
  if (!user) redirect("/login");

  const account: Account = {
    login: user.login,
    name: user.name,
    avatarUrl: user.avatarUrl,
    signedIn: authMode() === "github",
  };

  const project = await activeProject();
  if (!project) return <Welcome account={account} />;

  const props = await boardPropsFor(project, user);
  return <BoardShell account={account} {...props} />;
}
