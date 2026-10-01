/** A chess queen: the Queen's mark on a card and her icon in the nest. */
export function QueenIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <circle cx="2.5" cy="4" r="1.2" />
      <circle cx="6" cy="2.6" r="1.2" />
      <circle cx="10" cy="2.6" r="1.2" />
      <circle cx="13.5" cy="4" r="1.2" />
      <path d="M2 5.5 4.5 11h7L14 5.5l-3 2.5-3-3.5L5 8Z" />
      <rect x="3.5" y="12" width="9" height="2.2" rx="1" />
    </svg>
  );
}
