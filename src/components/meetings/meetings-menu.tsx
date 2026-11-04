"use client";

import { useEffect, useMemo, useState } from "react";
import { useColony } from "@/components/colony/colony";
import { useMeetings } from "@/lib/hooks/use-meetings";
import { upNext } from "@/lib/meetings/due";
import { guestOptions } from "@/lib/meetings/guests";
import { Calendar, weekStart } from "./calendar";
import { MeetingCard } from "./meeting-card";
import { MeetingForm } from "./meeting-form";
import { UpNext } from "./up-next";

/** The next quarter hour, the slot New meeting starts in. */
function nextSlot(now: Date): Date {
  const d = new Date(now);
  d.setMinutes(Math.ceil((d.getMinutes() + 1) / 15) * 15, 0, 0);
  return d;
}

/** The Meetings menu, over the board in the Timeline's frame. */
export function MeetingsMenu({ repoName, unlockAllSentinels = false }: { repoName: string; unlockAllSentinels?: boolean }) {
  const c = useColony();
  if (!c?.meetingsOpen) return null;
  return <MeetingsView repoName={repoName} level={c.score.level} unlockAll={unlockAllSentinels} close={() => c.setMeetingsOpen(false)} />;
}

type Panel = { kind: "form"; at: Date; editing?: string } | { kind: "card"; id: string; at: Date } | null;

function MeetingsView({ repoName, level, unlockAll, close }: { repoName: string; level: number; unlockAll: boolean; close: () => void }) {
  const { meetings, error, create, update, remove } = useMeetings();
  const [now] = useState(() => new Date());
  const [panel, setPanel] = useState<Panel>(null);
  const [busy, setBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const guests = useMemo(() => guestOptions(level, unlockAll), [level, unlockAll]);
  const next = upNext(meetings, now);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const card = panel?.kind === "card" ? meetings.find((m) => m.id === panel.id) : undefined;
  const editing = panel?.kind === "form" && panel.editing ? meetings.find((m) => m.id === panel.editing) : undefined;

  return (
    <div
      role="region"
      aria-label="Meetings"
      className="bg-cream fixed top-14 right-0 bottom-14 left-0 z-[60] box-border overflow-auto px-4 pt-5 pb-8 md:top-16 md:px-6"
    >
      <div className="mx-auto flex max-w-5xl flex-col gap-5">
        <div className="flex flex-wrap items-end gap-4">
          <div className="flex flex-1 flex-col gap-1">
            <span className="text-muted font-mono text-[10px] tracking-[0.12em] uppercase">Ceremonies · {repoName}</span>
            <h1 className="m-0 font-serif text-[28px] leading-none font-semibold tracking-[-0.01em]">Meetings</h1>
          </div>
          <button
            type="button"
            data-tour="meetings-new"
            onClick={() => setPanel({ kind: "form", at: nextSlot(new Date()) })}
            className="bg-terracotta-cta inline-flex h-9 items-center rounded-lg px-3.5 text-[13px] font-semibold text-white"
          >
            New meeting
          </button>
        </div>

        {error && (
          <p role="alert" className="bg-crimson/10 text-ink rounded-md px-3 py-2 text-[13px]">
            {error}
          </p>
        )}

        {panel?.kind === "form" && (
          <MeetingForm
            key={`${panel.at.getTime()}-${panel.editing ?? ""}`}
            at={panel.at}
            meeting={editing}
            guests={guests}
            onCancel={() => setPanel(null)}
            onSave={async (input) => {
              if (panel.editing) await update(panel.editing, input);
              else await create(input);
              setPanel(null);
            }}
          />
        )}

        {card && panel?.kind === "card" && (
          <MeetingCard
            meeting={card}
            at={panel.at}
            busy={busy}
            error={deleteError}
            onClose={() => setPanel(null)}
            onEdit={() => setPanel({ kind: "form", at: card.startsAt, editing: card.id })}
            onDelete={async () => {
              setBusy(true);
              setDeleteError(null);
              try {
                await remove(card.id);
                setPanel(null);
              } catch (e) {
                setDeleteError(e instanceof Error ? e.message : String(e));
              } finally {
                setBusy(false);
              }
            }}
          />
        )}

        {next ? (
          <UpNext next={next} />
        ) : (
          <p data-tour="meetings-empty" className="text-muted border-line rounded-xl border border-dashed p-6 text-center text-[14px]">
            No meetings yet. Let&apos;s plan one.
          </p>
        )}

        <Calendar
          meetings={meetings}
          from={weekStart(now)}
          onPick={(at) => setPanel({ kind: "form", at })}
          onOpen={(id, at) => setPanel({ kind: "card", id, at })}
        />
      </div>
    </div>
  );
}
