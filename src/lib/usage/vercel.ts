import "server-only";

/**
 * Vercel's own meter for the account, read from its billing API: the same
 * call `vercel usage` makes (POST /v2/billing/costs, with the quantity of each
 * product per day). It lags and is too slow to ask on every request, so the
 * governor (src/lib/usage/governor.ts) counts for itself and uses this to
 * correct its count: once a day, and again whenever its own count says the
 * line is near.
 *
 * Needs FORMIC_VERCEL_TOKEN, a Vercel access token, and FORMIC_VERCEL_TEAM_ID
 * when the project belongs to a team rather than a personal (Hobby) account.
 * The allowances are the account's, so the whole account is read, not only
 * this project.
 */

const API = "https://api.vercel.com";
const TIMEOUT_MS = 5_000;
const DAY_MS = 86_400_000;

/** One UTC day of what Vercel metered. */
export interface VercelDay {
  cpuHours: number;
  invocations: number;
  memoryGbHours: number;
}

export interface VercelUsage {
  /** When Vercel answered, ISO. */
  queriedAt: string;
  /** The account's billing period as UTC days, when Vercel gave one. */
  period: { start: string; end: string } | null;
  /** Per UTC day, "YYYY-MM-DD". */
  days: Record<string, VercelDay>;
  /** The unit each product came back in, as read, so /api/health shows what was assumed. */
  units: Partial<Record<keyof VercelDay, string>>;
}

export function vercelConfigured(): boolean {
  return !!process.env.FORMIC_VERCEL_TOKEN?.trim();
}

/** Reads the account's usage from `since` (a UTC day) to now. Throws when Vercel can't be read. */
export async function fetchVercelUsage(since: string, now = Date.now()): Promise<VercelUsage> {
  const period = await billingPeriod();
  const from = period && period.start < since ? period.start : since;
  const body = (await call("/v2/billing/costs", {
    method: "POST",
    body: JSON.stringify({
      from: new Date(`${from}T00:00:00Z`).toISOString(),
      to: new Date(now).toISOString(),
      metrics: ["gross_cost", "quantity"],
      format: "timeseries",
      views: { byProduct: { groupBy: ["product"] } },
    }),
  })) as CostsResponse;
  return { ...parseCosts(body), period };
}

/** The billing period, from the account the token belongs to (or the team). Null when it isn't given. */
async function billingPeriod(): Promise<VercelUsage["period"]> {
  const team = teamId();
  const body = (await call(team ? `/v2/teams/${encodeURIComponent(team)}` : "/v2/user")) as {
    user?: Owner;
  } & Owner;
  const billing = (body.user ?? body).billing;
  // As the CLI reads it: the monthly subscription's period, else the plan's.
  const p =
    billing?.subscriptions?.find((s) => s.frequency?.interval === "month" && s.frequency?.intervalCount === 1)
      ?.period ?? billing?.period;
  const start = p?.start != null ? new Date(p.start) : null;
  const end = p?.end != null ? new Date(p.end) : null;
  if (!start || !end || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  return { start: day(start.getTime()), end: day(end.getTime()) };
}

interface Period {
  start?: string | number;
  end?: string | number;
}
interface Owner {
  billing?: {
    period?: Period;
    subscriptions?: { frequency?: { interval?: string; intervalCount?: number }; period?: Period }[];
  };
}

interface CostsResponse {
  queriedAt?: string;
  metrics?: { slug: string; title?: string; unit?: { kind?: string; name?: string; singular?: string; plural?: string } }[];
  results?: {
    times?: string[];
    dimensionsMeta?: { product?: { values?: Record<string, { title?: string }> } };
    views?: Record<string, { results?: CostsResult[] }>;
  };
}
interface CostsResult {
  dimensionValues?: { product?: string };
  metrics?: string[];
  values?: (number | null)[][];
}

/** Which of a product's names is which allowance. Sandbox CPU is billed apart from Functions'. */
function kindOf(name: string): keyof VercelDay | null {
  const n = name.toLowerCase();
  if (n.includes("sandbox")) return null;
  if (/active[\s_-]*cpu/.test(n)) return "cpuHours";
  if (/provisioned[\s_-]*memory/.test(n)) return "memoryGbHours";
  if (/function[\s_-]*invocation/.test(n)) return "invocations";
  return null;
}

/** How many of a duration unit make an hour. */
function perHour(unit: string): number {
  const u = unit.toLowerCase();
  if (/^(ms|millisecond)/.test(u)) return 3_600_000;
  if (/^(s|sec|second)/.test(u)) return 3_600;
  if (/^(m|min|minute)/.test(u)) return 60;
  return 1;
}

export function parseCosts(res: CostsResponse): Omit<VercelUsage, "period"> {
  const times = res.results?.times ?? [];
  const titles = res.results?.dimensionsMeta?.product?.values ?? {};
  const rows = res.results?.views?.byProduct?.results ?? [];
  const days: Record<string, VercelDay> = {};
  const units: VercelUsage["units"] = {};
  for (const row of rows) {
    const product = row.dimensionValues?.product;
    if (!product) continue;
    const kind = kindOf(product) ?? kindOf(titles[product]?.title ?? "");
    if (!kind) continue;
    const index = (row.metrics ?? []).findIndex((m) => m !== "gross_cost");
    if (index === -1) continue;
    const metric = res.metrics?.find((m) => m.slug === row.metrics![index]);
    const unit = metric?.unit?.plural ?? metric?.unit?.name ?? metric?.unit?.singular ?? "";
    units[kind] = unit || "(none given)";
    // Active CPU may come back in any duration; the others in their own unit.
    const divisor = kind === "cpuHours" && metric?.unit?.kind === "duration" ? perHour(unit) : 1;
    times.forEach((t, i) => {
      const value = row.values?.[i]?.[index];
      if (typeof value !== "number" || !Number.isFinite(value)) return;
      const d = day(Date.parse(t));
      days[d] ??= { cpuHours: 0, invocations: 0, memoryGbHours: 0 };
      days[d][kind] += value / divisor;
    });
  }
  return { queriedAt: res.queriedAt ?? new Date().toISOString(), days, units };
}

async function call(path: string, init: RequestInit = {}): Promise<unknown> {
  const url = new URL(API + path);
  const team = teamId();
  if (team && !path.startsWith("/v2/teams/")) url.searchParams.set("teamId", team);
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${process.env.FORMIC_VERCEL_TOKEN?.trim()}`,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Vercel ${path} answered ${res.status}`);
  return res.json();
}

function teamId(): string | undefined {
  return process.env.FORMIC_VERCEL_TEAM_ID?.trim() || undefined;
}

function day(at: number): string {
  return new Date(Math.floor(at / DAY_MS) * DAY_MS).toISOString().slice(0, 10);
}
