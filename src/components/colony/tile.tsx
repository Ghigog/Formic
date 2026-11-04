import type { ReactNode } from "react";
import { InfoTip } from "./info-tip";

/**
 * One of the colony popover's four tiles: its mark large and faint behind, its
 * number in front, and the i in the corner. The tile is not positioned, so the
 * i's note opens against the row around it, full width.
 */
export function Tile({
  data,
  icon,
  value,
  valueData,
  tipLabel,
  tip,
  children,
  className = "",
  ...rest
}: {
  data: string;
  icon: ReactNode;
  value: ReactNode;
  valueData?: Record<string, string>;
  tipLabel: string;
  tip: ReactNode;
  /** Controls that sit over the tile (a button, a bell). */
  children?: ReactNode;
  className?: string;
} & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-colony-tile={data}
      className={`bg-panel grid min-h-[44px] aspect-square grid-cols-1 grid-rows-1 overflow-visible rounded-lg ${className}`}
      {...rest}
    >
      <span
        aria-hidden="true"
        className="text-clay pointer-events-none col-start-1 row-start-1 flex items-center justify-center opacity-15 [&>svg]:size-12"
      >
        {icon}
      </span>
      {/* Under the number, and under the i so that stays pressable. */}
      {children}
      <span
        {...valueData}
        className="text-ink pointer-events-none relative z-10 col-start-1 row-start-1 flex items-center justify-center font-serif text-[26px] leading-none font-semibold"
      >
        {value}
      </span>
      <span className="col-start-1 row-start-1 pointer-events-none flex items-start justify-end p-1.5 [&>span]:pointer-events-auto">
        <InfoTip label={tipLabel}>{tip}</InfoTip>
      </span>
    </div>
  );
}
