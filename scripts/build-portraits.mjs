#!/usr/bin/env node
/**
 * Turns the sentinels' source art into the strings the page inlines.
 *
 * `design/portraits/*.svg` holds one drawing per sentinel, named by its roster
 * `pic` key. What the page needs is an SVG *body* on a 200 canvas — it wraps
 * the string in a fixed `viewBox="0 0 200 200"` and slices it into a card
 * header and a round avatar — so this scales each drawing to that canvas,
 * bakes the drawing's ground in front of it, and writes the result into
 * `src/components/sentinels/portraits.traced.ts`, which `portraits.ts` merges
 * with the hand-drawn portraits.
 *
 * What it takes from the art, and where from:
 *
 * - **The canvas**, from the root `viewBox` (falling back to `width` and
 *   `height`). The drawing is made on whatever canvas Inkscape was set to —
 *   512 for every portrait here — and never on the 200 the page frames it in.
 *   A non-square canvas is scaled by its longer side, which is what
 *   `preserveAspectRatio="… slice"` does with it, so the frame is never
 *   letterboxed.
 * - **The drawing**, as drawn: strokes, group structure and any colour the
 *   artist chose survive, rounded to one decimal place — a tenth of a unit on
 *   a 512 canvas is a fiftieth of a pixel where the card draws it.
 * - **Nothing else.** The app paints what is around the figure. A white fill
 *   is the marker that means "this is the figure": it ships as the app's ink
 *   (`var(--text)`), so the figure reads on its ground in either theme, and a
 *   colour the artist set deliberately ships as drawn. The ground behind a
 *   portrait is the sentinel's own tint, painted by the page from the roster,
 *   not from the art. Inkscape's page colour is not read at all.
 *
 * It refuses, loudly, rather than shipping something quiet and wrong: art
 * that would make the browser fetch a file or run code (`<image>`, `<script>`,
 * `<style>`, a `url(http…)` paint, an external `href`), art that moves
 * (`<animate…>`, `<set>`, an animation or transition in a style), art drawn on
 * no canvas, and a `#id` reference with no element behind it.
 *
 * ```
 * npm run build:portraits          write the module
 * node scripts/build-portraits.mjs --check    write nothing, fail if stale
 * ```
 *
 * The build runs it before `next build`, and the suite runs `--check`, so
 * committed art and shipped strings cannot drift apart.
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

/** Where the drawings live, and what they become. */
const ART_DIR = path.join(root, "design/portraits");
const OUT_FILE = path.join(root, "src/components/sentinels/portraits.traced.ts");

/** The canvas the page frames every portrait in. Do not move the frame. */
const CANVAS = 200;

/* --------------------------------------------------------------------------
 * Reading the document
 *
 * There is no XML parser in the standard library and this is not the place to
 * write one: what follows is a tag scanner, which is all Inkscape's output
 * needs. A tag ends at the first `>` outside a quoted value, so the `>` that
 * a stray `d` or `style` may carry cannot end it early. Anything the scanner
 * does not recognise is passed through untouched rather than guessed at.
 * ------------------------------------------------------------------------ */

/**
 * A document as a flat list of tokens: elements, text, comments and the
 * declarations at the top (the XML prolog, a doctype).
 */
function tokenize(svg) {
  const tokens = [];
  let i = 0;
  while (i < svg.length) {
    const open = svg.indexOf("<", i);
    if (open < 0) break;
    if (open > i) tokens.push({ kind: "text", raw: svg.slice(i, open) });

    if (svg.startsWith("<!--", open)) {
      const end = svg.indexOf("-->", open + 4);
      if (end < 0) throw new Error("unterminated comment");
      tokens.push({ kind: "comment", raw: svg.slice(open, end + 3) });
      i = end + 3;
      continue;
    }
    if (svg.startsWith("<?", open) || svg.startsWith("<!", open)) {
      const end = svg.indexOf(">", open);
      if (end < 0) throw new Error("unterminated declaration");
      tokens.push({ kind: "declaration", raw: svg.slice(open, end + 1) });
      i = end + 1;
      continue;
    }

    let j = open + 1;
    let quote = null;
    while (j < svg.length) {
      const ch = svg[j];
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === ">") break;
      j++;
    }
    if (j >= svg.length) throw new Error("unterminated element");
    tokens.push({ kind: "tag", raw: svg.slice(open, j + 1) });
    i = j + 1;
  }
  return tokens;
}

/** An element tag, as its name, its attributes and whether it closes. */
function parseTag(raw) {
  const selfClosing = /\/\s*>$/.test(raw);
  let inner = raw.slice(1, -1).trim();
  if (inner.startsWith("/")) {
    return { name: inner.slice(1).trim(), closing: true, selfClosing: false, attrs: [] };
  }
  if (selfClosing) inner = inner.slice(0, -1).trim();
  const name = inner.split(/[\s/]/)[0] ?? "";
  const attrs = [];
  const ATTR = /([^\s=/]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m;
  while ((m = ATTR.exec(inner.slice(name.length)))) {
    attrs.push([m[1], m[2] ?? m[3] ?? m[4] ?? ""]);
  }
  return { name, closing: false, selfClosing, attrs };
}


/* --------------------------------------------------------------------------
 * Numbers
 * ------------------------------------------------------------------------ */

const NUMBER_SOURCE = /-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;
const NUMBER_AT = new RegExp(NUMBER_SOURCE.source, "y");

/**
 * A number as SVG writes it best: rounded, no trailing zeros, and no leading
 * one (`.5`). Inkscape exports six decimals of float noise — `-1.93558`,
 * `1.110223e-16` — and none of it survives being drawn 200 units wide.
 */
function num(value, dp = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  const rounded = Number(n.toFixed(dp));
  let s = String(rounded);
  if (s.includes("e")) s = rounded.toFixed(dp);
  if (s === "-0") return "0";
  if (s.startsWith("0.")) return s.slice(1);
  if (s.startsWith("-0.")) return `-${s.slice(2)}`;
  return s;
}

/** How many numbers each command takes, and which letters are commands at all. */
const ARITY = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 };

/** Path data as commands, each with the numbers that follow it. */
function readPath(d) {
  const parts = [];
  let i = 0;
  while (i < d.length) {
    const ch = d[i];
    if (/[A-Za-z]/.test(ch)) {
      parts.push({ cmd: ch, args: [] });
      i++;
      continue;
    }
    if (/[\s,]/.test(ch)) {
      i++;
      continue;
    }
    const part = parts.at(-1);
    if (!part) throw new Error(`path data starts with a number: ${JSON.stringify(d.slice(0, 24))}`);
    NUMBER_AT.lastIndex = i;
    const m = NUMBER_AT.exec(d);
    if (!m) throw new Error(`cannot read the number at ${JSON.stringify(d.slice(i, i + 12))}`);
    part.args.push(Number(m[0]));
    i += m[0].length;
  }
  return parts;
}

/**
 * The drawing as segments of numbers, each with the letter that introduces
 * them, rounded and normalised: a line that runs straight up or across is an
 * `h` or a `v`, and an arc's two flags are single digits.
 */
function segmentsOf(d) {
  const segments = [];
  for (const { cmd, args } of readPath(d)) {
    const arity = ARITY[cmd.toLowerCase()];
    if (arity === undefined) throw new Error(`unknown path command ${cmd}`);
    if (arity === 0) {
      segments.push({ letter: cmd, values: [] });
      continue;
    }
    if (!args.length || args.length % arity) {
      throw new Error(`a ${cmd} carries ${args.length} numbers`);
    }
    for (let at = 0; at < args.length; at += arity) {
      segments.push(segmentOf(cmd, args.slice(at, at + arity)));
    }
  }
  return segments;
}

/**
 * One segment: the letter it is written with and its rounded numbers.
 *
 * A line that runs straight up or across after rounding is written as an `h`
 * or a `v` — the same drawing, fewer bytes, and the axis it did not move
 * along is the one that rounded away. It decides on the rounded numbers, not
 * the drawn ones, so that reading the result back gives the same segment.
 * Everything else keeps the letter it was drawn with.
 */
function segmentOf(cmd, numbers) {
  const arc = cmd === "a" || cmd === "A";
  const values = numbers.map((n, idx) =>
    arc && (idx === 3 || idx === 4) ? (Math.round(n) ? "1" : "0") : num(n),
  );
  if (cmd === "l") {
    const [dx, dy] = values;
    if (dx === "0" && dy !== "0") return { letter: "v", values: [dy] };
    if (dy === "0" && dx !== "0") return { letter: "h", values: [dx] };
  }
  return { letter: cmd, values };
}

/**
 * Segments back into path data, packed down to what a parser actually needs.
 *
 * A number may follow the previous one with no separator when it starts with
 * `-`, and when it starts with `.` only if the number it follows has a
 * decimal point of its own — `5.5.5` is 5.5 then .5, but `0.5` is one number,
 * so a `0` before a `.5` has to keep its space. An arc's two flags are single
 * digits that may touch each other (`a5 5 0 01.4 7`), and a command letter is
 * dropped when it repeats the one before it, which the grammar allows.
 */
function packSegments(segments) {
  let out = "";
  let previousLetter = null;
  let previousValue = null;
  for (const { letter, values } of segments) {
    const arc = letter === "a" || letter === "A";
    // Repeating a moveto is not repeating a command: the numbers after a
    // second `m` are lines, so the letter always stays.
    if (letter !== previousLetter || letter === "m" || letter === "M") {
      out += letter;
      previousValue = null;
    }
    previousLetter = letter;
    values.forEach((v, idx) => {
      const separated = previousValue === null ? false : needsSpace(v, previousValue, arc && idx === 4);
      out += separated ? ` ${v}` : v;
      previousValue = v;
    });
  }
  return out;
}

/** Whether a value cannot touch the one before it without being misread. */
function needsSpace(v, previous, flagAfterFlag) {
  if (flagAfterFlag) return false;
  if (/[eE]$/.test(previous)) return true;
  if (v.startsWith("-")) return false;
  if (!v.startsWith(".")) return true;
  return !previous.includes(".");
}

/**
 * Path data, rounded and repacked: one decimal place, no float noise, no
 * separators a parser does not need.
 *
 * What is written is read back before it is returned, because the packing is
 * the one step here that can lie about the drawing — a lost space turns
 * `l1 0` into a line ten units long. That check is why this can round the
 * numbers of a 512-unit canvas down to a tenth of a unit and still be the
 * drawing the artist made.
 */
function pathData(d) {
  const segments = segmentsOf(d);
  const packed = packSegments(segments);
  const again = segmentsOf(packed);
  for (let i = 0; i < Math.max(segments.length, again.length); i++) {
    if (JSON.stringify(again[i]) !== JSON.stringify(segments[i])) {
      throw new Error(
        `packing the path changed it: segment ${i} ${JSON.stringify(segments[i])} ` +
          `was read back as ${JSON.stringify(again[i])}`,
      );
    }
  }
  return packed;
}

/** A `points` list, rounded: `<polygon points="12 34 56 78">`. */
function pointList(value) {
  return value
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((n) => num(n))
    .join(" ");
}

/** A `transform`, rounded, its commas become the single space between numbers. */
function transform(value) {
  return value
    .replace(NUMBER_SOURCE, (n) => num(n))
    .replace(/,/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/* --------------------------------------------------------------------------
 * Elements
 * ------------------------------------------------------------------------ */

/** Attributes whose value is a length or a coordinate, rounded like the rest. */
const NUMERIC = new Set([
  "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry", "width", "height",
  "dx", "dy", "offset", "startOffset", "opacity", "fill-opacity", "stroke-opacity",
  "stroke-width", "stroke-dashoffset", "stroke-miterlimit", "font-size",
  "stop-opacity", "letter-spacing", "word-spacing",
]);

/** Attributes that paint, and so may carry the marker colour. */
const PAINT = new Set(["fill", "stroke", "stop-color", "flood-color", "lighting-color", "color"]);

/** White: the marker meaning "this is the figure". The app paints it. */
const WHITE = /^(?:#fff|#ffffff|white|rgb\(\s*255[\s,]+255[\s,]+255\s*\))$/i;

/** The ink the app paints the figure in: dark on a light ground, light on a dark one. */
const INK = "var(--text)";

/**
 * Style properties that are also presentation attributes, so they can be
 * written as one instead of in a `style` string. Inkscape puts everything in
 * `style`; the page matches `fill="…"`, and a shorter body is the point.
 */
const PRESENTATION = new Set([
  "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-linecap",
  "stroke-linejoin", "stroke-miterlimit", "stroke-dasharray", "stroke-dashoffset",
  "stroke-opacity", "paint-order", "vector-effect", "opacity", "color", "stop-color",
  "stop-opacity", "clip-path", "clip-rule", "mask", "filter", "display", "visibility",
  "marker-start", "marker-mid", "marker-end", "font-family", "font-size", "font-style",
  "font-weight", "font-variant", "text-anchor", "letter-spacing", "isolation",
]);

/**
 * Inkscape's own generated ids: `svg1`, `layer1`, `path1`, `namedview1`. A
 * drawing no longer names them, and an id nothing reads is one that can
 * silently collide once the page inlines twelve portraits. Any id something
 * in the file refers to is kept, whatever it is called.
 */
const BOILERPLATE = /^(?:svg|layer|path|g|rect|circle|ellipse|polygon|polyline|line|text|tspan|defs|namedview|page|stop|use|clipPath|mask|filter|image|metadata|linearGradient|radialGradient)\d+$/;

/** Elements the page must never inline: they fetch, they run, or they move. */
const FORBIDDEN = new Set([
  "image", "script", "style", "foreignObject", "iframe", "audio", "video", "link",
  "animate", "animateMotion", "animateTransform", "set",
]);

/** Elements dropped whole, with everything inside them. */
const DROPPED = new Set(["metadata", "sodipodi:namedview", "namedview"]);

/** Elements whose text is the drawing, so whitespace inside them is not indentation. */
const TEXTUAL = new Set(["text", "tspan", "title", "desc"]);

/**
 * Every id the file declares, and every one something in it refers to. The
 * first is what a `url(#…)` is checked against; the second is what decides
 * whether an id is worth keeping, since an id nothing reads is a name that
 * can silently collide once the page inlines twelve portraits.
 */
function idsOf(tokens) {
  const declared = new Set();
  const referenced = new Set();
  for (const token of tokens) {
    if (token.kind !== "tag") continue;
    for (const [name, value] of parseTag(token.raw).attrs) {
      if (name === "id") declared.add(value);
      if ((name === "href" || name === "xlink:href") && value.startsWith("#")) {
        referenced.add(value.slice(1));
      }
      for (const match of value.matchAll(/url\(\s*(['"]?)#([^'")]+)\1\s*\)/g)) {
        referenced.add(match[2]);
      }
    }
  }
  return { declared, referenced };
}

/**
 * A reference to another element in the same file, namespaced with the pic
 * key. The page inlines one portrait twice — a card and the report avatar —
 * so `id="tassel"` would be two ids in one document; `rex-tassel` is two as
 * well, but both are this same figure, which is why the prefix is enough. A
 * reference that leaves the file is refused rather than drawn blank.
 */
function reference(value, key, ids) {
  if (!value.startsWith("#")) {
    throw new Error(`refers to another file (${value}); a portrait draws only what is in it`);
  }
  const id = value.slice(1);
  if (!ids.declared.has(id)) throw new Error(`refers to #${id}, which is not in the file`);
  return `#${key}-${id}`;
}

/** One attribute's value, rounded, painted, and checked for what it reaches. */
function attributeValue(name, value, key, ids) {
  if (name === "d") return pathData(value);
  if (name === "points") return pointList(value);
  if (name === "transform") return transform(value);
  if (name === "href" || name === "xlink:href") return reference(value, key, ids);
  if (value.includes("url(")) {
    return value.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (_all, _q, target) =>
      `url(${reference(target, key, ids)})`,
    );
  }
  if (PAINT.has(name) && WHITE.test(value.trim())) return INK;
  if (NUMERIC.has(name)) return num(value);
  return value;
}

/** A `style` string, split into the presentation attributes it stands for. */
function styleAttributes(value, key, ids) {
  const attrs = [];
  const kept = [];
  for (const declaration of value.split(";")) {
    const colon = declaration.indexOf(":");
    if (colon < 0) continue;
    const property = declaration.slice(0, colon).trim();
    const declared = declaration.slice(colon + 1).trim();
    if (!property || !declared) continue;
    if (/^(?:animation|transition)/.test(property)) {
      throw new Error(`styles ${property}: a portrait does not move`);
    }
    if (PRESENTATION.has(property)) {
      attrs.push([property, attributeValue(property, declared, key, ids)]);
    } else {
      kept.push(`${property}:${declared}`);
    }
  }
  if (kept.length) attrs.push(["style", kept.join(";")]);
  return attrs;
}

/**
 * One element, as the page will see it: cruft gone, numbers rounded, ids
 * namespaced. An empty `<defs>` is left for `bodyOf` to take out, since a
 * group of nothing is not worth the bytes either.
 */
function element(tag, key, ids) {
  if (FORBIDDEN.has(tag.name)) {
    throw new Error(
      `has a <${tag.name}>: a portrait fetches nothing, runs nothing, styles nothing and does not move`,
    );
  }

  const attrs = [];
  for (const [name, value] of tag.attrs) {
    if (/^(?:inkscape|sodipodi):/.test(name)) continue;
    if (name === "xmlns" || name.startsWith("xmlns:") || name === "version" || name === "xml:space") {
      continue;
    }
    if (name === "id") {
      if (BOILERPLATE.test(value) && !ids.referenced.has(value)) continue;
      attrs.push(["id", `${key}-${value}`]);
      continue;
    }
    if (name === "style") {
      attrs.push(...styleAttributes(value, key, ids));
      continue;
    }
    attrs.push([name, attributeValue(name, value, key, ids)]);
  }

  const written = attrs.map(([name, value]) => ` ${name}="${value}"`).join("");
  return tag.selfClosing ? `<${tag.name}${written}/>` : `<${tag.name}${written}>`;
}

/* --------------------------------------------------------------------------
 * A drawing, as a portrait
 * ------------------------------------------------------------------------ */

/** The canvas the path data is drawn in: the root's viewBox, or its size. */
function canvasOf(root, key) {
  const viewBox = (root.attrs.find(([name]) => name === "viewBox") ?? [])[1];
  const box = viewBox?.split(/[\s,]+/).filter(Boolean).map(Number) ?? [];
  if (box.length === 4 && box.every((n) => Number.isFinite(n)) && box[2] > 0 && box[3] > 0) {
    return { minX: box[0], minY: box[1], width: box[2], height: box[3] };
  }
  const size = (name) => Number((root.attrs.find(([n]) => n === name) ?? [])[1]);
  const width = size("width");
  const height = size("height");
  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
    return { minX: 0, minY: 0, width, height };
  }
  throw new Error(
    `${key}.svg is drawn on no canvas: give the root a viewBox, or a width and a height`,
  );
}

/** Everything inside the root `<svg>`, stripped to what the page needs. */
function bodyOf(tokens, rootTag, key) {
  const ids = idsOf(tokens);
  const out = [];
  const stack = [];
  for (const token of tokens) {
    if (token.kind === "comment" || token.kind === "declaration") continue;

    if (token.kind === "text") {
      const inText = stack.some((open) => TEXTUAL.has(open.name));
      const text = inText ? token.raw : token.raw.trim();
      if (text) out.push(text);
      continue;
    }

    if (token === rootTag) continue;
    const tag = parseTag(token.raw);

    if (tag.closing) {
      const open = stack.pop();
      if (open && !open.dropped) out.push(`</${open.name}>`);
      continue;
    }

    const dropped = stack.some((open) => open.dropped) || DROPPED.has(tag.name);
    // A self-closing element is never on the stack: nothing closes it, so
    // leaving it there would drop the whole drawing after it.
    if (!tag.selfClosing) stack.push({ name: tag.name, dropped });
    if (!dropped) out.push(element(tag, key, ids));
  }

  // A `<defs>` around nothing, or a `<g>` around nothing, is Inkscape's: a
  // portrait that carries one carries a name nobody can see. Nested empties
  // take more than one pass, hence the loop.
  let body = out.join("").replace(/<defs[^>]*\/>/g, "").replace(/<defs[^>]*><\/defs>/g, "");
  let before;
  do {
    before = body;
    body = body.replace(/<g[^>]*>\s*<\/g>/g, "");
  } while (body !== before);
  return body;
}

/**
 * One portrait, ready to inline: the drawing scaled from its own canvas to
 * the 200 the page frames it in, with the figure in the app's ink. The frame
 * never moves — the art is what has to fit it — and the ground is the page's
 * to paint, so nothing here draws one.
 */
function portraitString(svg, key) {
  const tokens = tokenize(svg);
  const rootTag = tokens.find(
    (token) => token.kind === "tag" && parseTag(token.raw).name === "svg",
  );
  if (!rootTag) throw new Error(`${key}.svg has no <svg> root`);
  const root = parseTag(rootTag.raw);

  const canvas = canvasOf(root, key);
  const body = bodyOf(tokens, rootTag, key);
  if (!body.trim()) throw new Error(`${key}.svg draws nothing`);

  const scale = CANVAS / Math.max(canvas.width, canvas.height);
  const into = [`scale(${num(scale, 6)})`];
  if (canvas.minX || canvas.minY) {
    into.push(`translate(${num(-canvas.minX)} ${num(-canvas.minY)})`);
  }
  return scale === 1 && into.length === 1 ? body : `<g transform="${into.join(" ")}">${body}</g>`;
}

/* --------------------------------------------------------------------------
 * The module the page imports
 * ------------------------------------------------------------------------ */

/** A string as a TypeScript literal: one line, as the hand-drawn ones are. */
function literal(value) {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\r?\n/g, "\\n")}'`;
}

/** The whole generated module, keys in alphabetical order for a stable diff. */
function moduleText(entries) {
  const keys = Object.keys(entries).sort();
  return [
    "/**",
    " * The portraits traced from source art, generated by",
    " * `npm run build:portraits` from `design/portraits/*.svg`.",
    " *",
    " * Do not edit this file: the build overwrites it, and the suite compares it",
    " * against the art to catch exactly that. Change the drawing and rebuild.",
    " * See design/portraits/README.md.",
    " */",
    "export const TRACED: Record<string, string> = {",
    ...keys.map((key) => `  ${key}: ${literal(entries[key])},`),
    "};",
    "",
  ].join("\n");
}

/** Every drawing in the art directory, as a portrait string, keyed by pic. */
async function buildPortraits() {
  const files = (await readdir(ART_DIR)).filter((name) => name.endsWith(".svg")).sort();
  const entries = {};
  for (const file of files) {
    const key = path.basename(file, ".svg");
    entries[key] = portraitString(await readFile(path.join(ART_DIR, file), "utf8"), key);
  }
  return entries;
}

const gzipped = (text) => gzipSync(Buffer.from(text)).length;

async function main(argv = process.argv.slice(2)) {
  const entries = await buildPortraits();
  const text = moduleText(entries);
  const keys = Object.keys(entries).sort();
  const sizes = keys
    .map((key) => `  ${key.padEnd(8)} ${entries[key].length} chars, ${gzipped(entries[key])} gzipped`)
    .join("\n");

  if (argv.includes("--check")) {
    const committed = await readFile(OUT_FILE, "utf8").catch(() => null);
    if (committed !== text) {
      process.stderr.write(
        `${path.relative(root, OUT_FILE)} is not what the art in ${path.relative(root, ART_DIR)} ` +
          `draws.\nRun \`npm run build:portraits\` and commit the result.\n`,
      );
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`Portraits are current: ${keys.length} traced, ${text.length} bytes.\n`);
    return;
  }

  await writeFile(OUT_FILE, text);
  process.stdout.write(
    `Wrote ${path.relative(root, OUT_FILE)}: ${keys.length} portraits, ` +
      `${text.length} bytes (${gzipped(text)} gzipped)\n${sizes}\n`,
  );
}

await main();

