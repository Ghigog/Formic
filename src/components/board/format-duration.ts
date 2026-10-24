/** "3m", "2h 5m", "1d 4h"; a dash for a synthetic entry, whose time is lost. */
export function formatDuration(ms: number | null): string {
  if (ms == null) return "–";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}
