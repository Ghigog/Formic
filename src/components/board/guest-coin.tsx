import { guestLabel, type GuestId } from "@/lib/assistant/guest-ids";

/** The octagon every Formic badge is cut to (design/DESIGN.md: octagonal coin badge). */
export const OCTAGON =
  "[clip-path:polygon(9px_0,calc(100%-9px)_0,100%_9px,100%_calc(100%-9px),calc(100%-9px)_100%,9px_100%,0_calc(100%-9px),0_9px)]";

/** Each guest's colour: the column agents in the board's own, the PM in anthracite, Sentinels in jade. */
function guestInk(id: GuestId): { ground: string; ink: string } {
  if (id === "assistant" || id === "pm") return { ground: "var(--anthracite)", ink: "var(--cream)" };
  if (id.startsWith("sentinel:")) return { ground: "var(--jade)", ink: "#fff" };
  if (id === "product") return { ground: "var(--color-cta)", ink: "#fff" };
  if (id === "architect") return { ground: "var(--clay)", ink: "#fff" };
  if (id === "coder") return { ground: "var(--rust)", ink: "#fff" };
  return { ground: "var(--terracotta-deep)", ink: "#fff" };
}

/** A guest's coin: their initials on their colour, cut to the octagon. */
export function GuestCoin({ id, size = 28 }: { id: GuestId; size?: number }) {
  const label = guestLabel(id);
  const initials = label.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  const { ground, ink } = guestInk(id);
  return (
    <span
      aria-hidden="true"
      className={`inline-flex shrink-0 items-center justify-center font-mono font-semibold ${OCTAGON}`}
      style={{ width: size, height: size, background: ground, color: ink, fontSize: Math.round(size * 0.36) }}
    >
      {initials}
    </span>
  );
}
