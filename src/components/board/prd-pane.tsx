"use client";

import { useEffect, useState } from "react";
import type { Prd } from "@/lib/domain/entities";

/**
 * The PRD, in editorial serif per the design specification.
 *
 * Editable, because the Product Agent's output is a draft. A human overriding
 * it is the normal case, not an escape hatch, so the edit affordance is on the
 * page rather than behind a menu.
 */
export function PrdPane({
  prd,
  rawRequest,
  streaming,
  onSave,
}: {
  prd: Prd | null;
  rawRequest: string;
  /** Partial text while the Product Agent writes. */
  streaming?: string;
  onSave: (prd: Prd) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (prd) setDraft(JSON.stringify(prd, null, 2));
  }, [prd]);

  if (!prd) {
    return (
      <div className="p-4">
        <h3 className="text-fg-subtle font-mono text-[10px] tracking-wide uppercase">
          Raw request
        </h3>
        <p className="mt-1 font-serif text-[15px] leading-relaxed">{rawRequest}</p>

        {streaming ? (
          <>
            <p className="text-ochre-text mt-4 text-[11px]">
              Product Agent is writing the PRD…
            </p>
            <pre className="text-fg-muted mt-1 font-mono text-[10px] whitespace-pre-wrap">
              {streaming.slice(-1200)}
            </pre>
          </>
        ) : (
          <p className="text-fg-subtle mt-4 text-[12px]">
            No PRD yet.
          </p>
        )}
      </div>
    );
  }

  if (editing) {
    return (
      <div className="flex h-full flex-col p-4">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className="border-line bg-bg focus:border-amber min-h-64 flex-1 resize-none rounded border p-2 font-mono text-[11px] outline-none"
        />
        {error && (
          <p role="alert" className="text-crimson-text mt-1 text-[12px]">
            {error}
          </p>
        )}
        <div className="mt-2 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => {
              setEditing(false);
              setError(null);
              setDraft(JSON.stringify(prd, null, 2));
            }}
            className="text-fg-muted hover:text-fg px-2 py-1 text-[12px] font-medium"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={async () => {
              setSaving(true);
              setError(null);
              try {
                await onSave(JSON.parse(draft) as Prd);
                setEditing(false);
              } catch (e) {
                setError(
                  e instanceof SyntaxError
                    ? "That is not valid JSON."
                    : e instanceof Error
                      ? e.message
                      : "Could not save.",
                );
              } finally {
                setSaving(false);
              }
            }}
            className="bg-amber text-on-amber rounded px-3 py-1.5 text-[12px] font-semibold disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save PRD"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <article className="p-4 font-serif">
      <div className="flex items-start gap-2">
        <p className="flex-1 text-[15px] leading-relaxed">{prd.summary}</p>
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="border-line text-fg-muted hover:text-fg shrink-0 rounded border px-1.5 py-0.5 font-sans text-[11px] font-medium"
        >
          Edit
        </button>
      </div>

      <Section title="Problem">
        <p className="text-[14px] leading-relaxed">{prd.problem}</p>
      </Section>

      <Section title="Scope">
        <List items={prd.scope} />
      </Section>

      {prd.outOfScope.length > 0 && (
        <Section title="Out of scope">
          <List items={prd.outOfScope} />
        </Section>
      )}

      {prd.technicalContext.length > 0 && (
        <Section title="Technical context">
          <List items={prd.technicalContext} />
        </Section>
      )}

      {prd.userStories.length > 0 && (
        <Section title="User stories">
          <List items={prd.userStories} />
        </Section>
      )}

      <Section title="Success criteria">
        <List items={prd.successCriteria} />
      </Section>
    </article>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-4">
      <h3 className="text-fg-subtle font-sans font-mono text-[10px] tracking-wide uppercase">
        {title}
      </h3>
      <div className="mt-1">{children}</div>
    </section>
  );
}

function List({ items }: { items: string[] }) {
  return (
    <ul className="flex list-disc flex-col gap-1 pl-4 text-[14px] leading-relaxed">
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </ul>
  );
}
