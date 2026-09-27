import { redirect } from "next/navigation";
import Link from "next/link";
import { repository } from "@/lib/db";
import { activeProject } from "@/lib/board/project";
import { currentUser } from "@/lib/auth/user";

export const dynamic = "force-dynamic";

/**
 * Every closed ticket for the active project, read-only. Reached from the
 * account menu; there is no way back onto the board from here, since closing
 * a ticket is one-way — nothing here can be undone.
 */
export default async function ArchivePage() {
  const user = await currentUser();
  if (!user) redirect("/login?next=/archive");

  const project = await activeProject();
  const tickets = project ? await repository().closedTickets(project.id) : [];

  return (
    <div className="bg-cream min-h-dvh">
      <header className="border-line bg-card flex h-16 items-center gap-3 border-b px-4 md:px-6">
        <Link href="/" className="text-muted hover:text-ink text-[13px] font-medium">
          ← Board
        </Link>
        <span aria-hidden className="bg-line h-6 w-px" />
        <h1 className="font-serif text-[19px] font-semibold">Archive</h1>
      </header>

      <main className="mx-auto flex max-w-2xl flex-col gap-4 px-4 py-6">
        {tickets.length === 0 ? (
          <p className="text-muted text-[13px]">
            Nothing archived yet. Drag a ticket onto the "New request" button to close it.
          </p>
        ) : (
          <ul className="bg-card border-line divide-line divide-y rounded-xl border">
            {tickets.map((t) => (
              <li key={t.id} className="flex items-center justify-between gap-4 px-4 py-3">
                <div className="min-w-0">
                  <p className="text-ink truncate text-[13px] font-medium">{t.title}</p>
                  <p className="text-muted truncate font-mono text-[11px]">
                    {t.key} · {t.epicKey} {t.epicTitle}
                  </p>
                </div>
                <span className="text-muted shrink-0 text-[11px]">
                  {new Date(t.closedAt).toLocaleDateString(undefined, {
                    year: "numeric",
                    month: "short",
                    day: "numeric",
                  })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
