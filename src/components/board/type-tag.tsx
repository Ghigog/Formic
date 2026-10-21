import type { BugSeverity, WorkType } from "@/lib/domain/entities";

const LABELS: Record<WorkType, string> = {
  user_story: "User story",
  task: "Task",
  feature: "Feature",
  spike: "Spike",
  bug: "Bug",
};

/** Tag colours; a bug darkens from low to critical. */
const COLORS: Record<Exclude<WorkType, "bug">, string> = {
  user_story: "#7bc47f",
  task: "#8ecae6",
  feature: "#5fd4b8",
  spike: "#f2d649",
};
const BUG_COLORS: Record<BugSeverity, string> = {
  low: "#ef9a9a",
  medium: "#e57373",
  high: "#c62828",
  critical: "#7f1d1d",
};
const DARK_TEXT = "#1f2328";
const LIGHT_TEXT = "#ffffff";

/** The one coloured tag a card or the drawer shows for its type; a done bug reads SQUASHED. */
export function TypeTag({
  type,
  severity,
  squashed = false,
}: {
  type: WorkType;
  severity?: BugSeverity | null;
  squashed?: boolean;
}) {
  const bug = type === "bug";
  const label =
    bug && squashed
      ? "Squashed"
      : bug && severity
        ? `${LABELS[type]} · ${severity[0]!.toUpperCase()}${severity.slice(1)}`
        : LABELS[type];
  const background = bug ? BUG_COLORS[severity ?? "medium"] : COLORS[type];
  const dark = bug && (severity === "high" || severity === "critical" || severity == null);
  const style =
    bug && squashed
      ? undefined
      : { backgroundColor: background, color: dark ? LIGHT_TEXT : DARK_TEXT };
  return (
    <span
      data-type-tag={type}
      data-severity={bug ? (severity ?? undefined) : undefined}
      {...(bug && !squashed ? { "data-bugicon": "" } : {})}
      {...(type === "spike" ? { "data-spikeicon": "" } : {})}
      style={style}
      className={
        bug && squashed
          ? "bg-hairline text-muted inline-flex shrink-0 items-center rounded px-1.5 py-0.5 font-mono text-[9px] tracking-[0.08em] whitespace-nowrap uppercase"
          : "inline-flex shrink-0 items-center rounded px-1.5 py-0.5 font-mono text-[9px] tracking-[0.08em] whitespace-nowrap uppercase"
      }
    >
      {label}
    </span>
  );
}
