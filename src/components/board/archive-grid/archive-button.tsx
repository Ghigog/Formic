"use client";

export function ArchiveButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="border-line text-ink rounded-md border px-2.5 py-1 text-xs"
    >
      Archive
    </button>
  );
}
