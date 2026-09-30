import { GROUP_GROUND, SENTINELS } from "@/lib/sentinels/roster";

import { TRACED } from "./portraits.traced";

/**
 * Every portrait the page can draw, keyed by the roster's `pic`.
 *
 * Each one is an SVG body drawn on a 200 canvas and inlined into the page — no
 * image requests — and each is generated from `design/portraits` by
 * `npm run build:portraits`, which is also where the figure gets its ink: the
 * art is drawn white, and white ships as the app's text colour so a theme can
 * change it. `portraits.test.ts` is what keeps this map, the roster and that
 * directory in step — a `pic` with no portrait fails the suite by name.
 */
export const PORTRAITS: Record<string, string> = TRACED;

/**
 * A pic's portrait, or a marked placeholder when the roster names one nobody
 * drew. The suite keeps that from happening, so this is the belt to its
 * braces: a pic that slips through renders as a letter on the column ground
 * rather than as an empty card.
 */
export function portraitFor(pic: string): string {
  return PORTRAITS[pic] ?? placeholder(pic);
}

/**
 * A portrait as the page inlines it: the art inside the frame every portrait
 * shares. The frame is fixed at 200 and slices to fill whatever box it is
 * dropped into — a card's header band, or the round avatar — so art is drawn
 * on its own canvas and scaled by the build, never redrawn for the frame.
 */
export function portraitSvg(pic: string): string {
  return (
    '<svg viewBox="0 0 200 200" width="100%" height="100%" preserveAspectRatio="xMidYMid slice" ' +
    `style="display:block">${portraitFor(pic)}</svg>`
  );
}

/** The ground a pic with no sentinel falls back to; the placeholder draws it. */
const COLUMN_GROUND = "var(--column)";

/**
 * The ground behind a portrait: the tint of the sentinel's group, painted by
 * the card and the avatar because a portrait draws no ground of its own. It is
 * a token rather than a colour, so the twelve follow the theme — and so the
 * ink the figure is painted in keeps reading against them.
 */
export function portraitGround(pic: string): string {
  const sentinel = SENTINELS.find((s) => s.pic === pic);
  return sentinel ? GROUP_GROUND[sentinel.group] : COLUMN_GROUND;
}

/**
 * The placeholder: the pic's initial in mono, inside a dashed ring, on the
 * column ground. It is drawn for both crops at once — the card header shows
 * at least y 32..168 of the 200 and the report avatar shows the inscribed
 * circle — so it reads as *missing* at 264px and at 52px alike.
 *
 * It is the one portrait drawn in tokens rather than ink, because it is the
 * app's own fallback rather than art, and it draws its own ground because
 * there is no sentinel here to tint one.
 */
function placeholder(pic: string): string {
  const initial = escaped((pic.trim()[0] ?? "?").toUpperCase());
  return (
    `<rect width="200" height="200" fill="${COLUMN_GROUND}"/>` +
    '<circle cx="100" cy="100" r="58" fill="none" stroke="var(--border-dashed)" stroke-width="3" stroke-dasharray="10 9"/>' +
    '<text x="100" y="128" text-anchor="middle" font-size="76" font-weight="600" fill="var(--dot-idle)" ' +
    `style="font-family:var(--font-mono)">${initial}</text>`
  );
}

/** XML-escaped, for the one place a key of the roster reaches the markup. */
function escaped(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
