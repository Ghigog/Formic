/**
 * Facts worked out from the whole repository, in code, before any model
 * reads it: what imports what, which source has no test, and the
 * accessibility mistakes a pattern can find. A sentinel reads 40 files; these
 * see every file, so they are what tells it where to look.
 *
 * Heuristics, and labelled as such in what they write: a regex is not a
 * parser. They are pointers for a reader, not findings on their own.
 */

/** Characters per section, so analysis never crowds out the code itself. */
const SECTION_CAP = 12_000;

const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|java|kt|swift|php|cs|vue|svelte)$/;
const TEST = /(\.(test|spec)\.[a-z]+$)|(^|\/)(tests?|__tests__|e2e|spec)\/|(^|\/)test_[^/]+\.py$|_test\.(go|py)$/;
const NOT_CODE = /\.d\.ts$|(^|\/)(scripts?|migrations?|prisma|public|design|docs?|fixtures?|mocks?|__mocks__)\/|\.config\.[a-z]+$|(^|\/)(next|vite|vitest|jest|playwright|tailwind|postcss|eslint)\.[a-z.]+$/;
const JS = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

export type Texts = ReadonlyMap<string, string>;

function lines(text: string): number {
  if (!text) return 0;
  const n = text.split("\n").length;
  return text.endsWith("\n") ? n - 1 : n;
}

/* ------------------------------------------------------------------ */
/* Imports                                                            */
/* ------------------------------------------------------------------ */

const IMPORT = /(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)/g;

/** The `@/*`-style aliases in tsconfig.json or jsconfig.json, as prefix to folder. */
export function aliasesFrom(tsconfig: string | undefined): Array<[string, string]> {
  if (!tsconfig) return [];
  try {
    const json = JSON.parse(jsonc(tsconfig));
    const base: string = (json.compilerOptions?.baseUrl ?? ".").replace(/^\.\/?/, "");
    const paths: Record<string, string[]> = json.compilerOptions?.paths ?? {};
    return Object.entries(paths)
      .filter(([, to]) => to[0])
      .map(([from, to]) => [from.replace(/\*$/, ""), join(base, to[0]!.replace(/\*$/, "").replace(/^\.\//, ""))]);
  } catch {
    return [];
  }
}

/** JSON with comments and trailing commas, as a tsconfig may be, made JSON. */
export function jsonc(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      // A string, copied whole: `"@/*"` is a path, not a comment.
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2);
      if (i < 0) break;
      i++;
    } else out += c;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

function join(...parts: string[]): string {
  const out: string[] = [];
  for (const seg of parts.join("/").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return out.join("/");
}

const TRY = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", "/index.ts", "/index.tsx", "/index.js", "/index.jsx"];

/** Every repository file a JS or TS file imports, by path. Packages are left out. */
export function importGraph(texts: Texts, aliases: Array<[string, string]>): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();
  const resolve = (from: string, spec: string): string | null => {
    let base: string | null = null;
    if (spec.startsWith(".")) base = join(from.slice(0, from.lastIndexOf("/") + 1), spec);
    else {
      const alias = aliases.find(([prefix]) => spec.startsWith(prefix));
      if (alias) base = join(alias[1], spec.slice(alias[0].length));
    }
    if (base === null) return null;
    // An ESM import of `./x.js` names the file `./x.ts`.
    const stem = base.replace(/\.(js|jsx|mjs)$/, "");
    for (const ext of TRY) {
      if (texts.has(base + ext)) return base + ext;
      if (texts.has(stem + ext)) return stem + ext;
    }
    return null;
  };
  for (const [path, text] of texts) {
    if (!JS.test(path)) continue;
    const deps = new Set<string>();
    for (const m of text.matchAll(IMPORT)) {
      const spec = m[1] ?? m[2] ?? m[3] ?? m[4];
      const hit = spec ? resolve(path, spec) : null;
      if (hit && hit !== path) deps.add(hit);
    }
    graph.set(path, deps);
  }
  return graph;
}

/** The module a file belongs to: its folder, at most three levels deep. */
function moduleOf(path: string): string {
  const parts = path.split("/");
  parts.pop();
  return parts.slice(0, 3).join("/") || ".";
}

/** Strongly connected groups of more than one module: import cycles. */
function cycles(edges: Map<string, Set<string>>): string[][] {
  let index = 0;
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const on = new Set<string>();
  const out: string[][] = [];
  const visit = (v: string) => {
    idx.set(v, index);
    low.set(v, index++);
    stack.push(v);
    on.add(v);
    for (const w of edges.get(v) ?? []) {
      if (!idx.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (on.has(w)) low.set(v, Math.min(low.get(v)!, idx.get(w)!));
    }
    if (low.get(v) === idx.get(v)) {
      const group: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        on.delete(w);
        group.push(w);
      } while (w !== v);
      if (group.length > 1) out.push(group.sort());
    }
  };
  for (const v of edges.keys()) if (!idx.has(v)) visit(v);
  return out;
}

/** The module map an Architect would draw first: who depends on whom, and the cycles. */
export function importEvidence(texts: Texts, graph: Map<string, Set<string>>): string {
  const code = [...graph.keys()].filter((p) => !TEST.test(p));
  if (code.length === 0) return "No JavaScript or TypeScript source to map imports for.";

  const modEdges = new Map<string, Map<string, number>>();
  const fanIn = new Map<string, number>();
  for (const from of code) {
    for (const to of graph.get(from) ?? []) {
      if (TEST.test(to)) continue;
      fanIn.set(to, (fanIn.get(to) ?? 0) + 1);
      const a = moduleOf(from);
      const b = moduleOf(to);
      if (a === b) continue;
      const row = modEdges.get(a) ?? new Map<string, number>();
      row.set(b, (row.get(b) ?? 0) + 1);
      modEdges.set(a, row);
    }
  }

  const mods = new Map<string, { files: number; lines: number }>();
  for (const p of code) {
    const m = mods.get(moduleOf(p)) ?? { files: 0, lines: 0 };
    m.files += 1;
    m.lines += lines(texts.get(p) ?? "");
    mods.set(moduleOf(p), m);
  }

  const out = [`Import map of ${code.length} source files (tests left out), by folder. Worked out from import statements, so dynamic paths are missed.`, "", "Folders: files, lines, folders it imports, folders importing it."];
  const importers = (m: string) => [...modEdges.values()].filter((row) => row.has(m)).length;
  for (const [m, info] of [...mods].sort((a, b) => b[1].lines - a[1].lines).slice(0, 40)) {
    out.push(`- ${m}: ${info.files} files, ${info.lines} lines, imports ${modEdges.get(m)?.size ?? 0}, imported by ${importers(m)}`);
  }

  const edges = [...modEdges].flatMap(([a, row]) => [...row].map(([b, n]) => ({ a, b, n }))).sort((x, y) => y.n - x.n);
  out.push("", "Heaviest dependencies between folders (imports):");
  for (const e of edges.slice(0, 50)) out.push(`- ${e.a} -> ${e.b}: ${e.n}`);

  const sets = new Map([...modEdges].map(([a, row]) => [a, new Set(row.keys())]));
  const loops = cycles(sets);
  out.push("", loops.length ? "Folder import cycles:" : "No import cycles between folders.");
  for (const group of loops.slice(0, 15)) out.push(`- ${group.join(" <-> ")}`);

  out.push("", "Most imported files:");
  for (const [p, n] of [...fanIn].sort((a, b) => b[1] - a[1]).slice(0, 15)) out.push(`- ${p}: imported by ${n}`);

  out.push("", "Largest source files:");
  for (const p of [...code].sort((a, b) => lines(texts.get(b) ?? "") - lines(texts.get(a) ?? "")).slice(0, 15)) {
    out.push(`- ${p}: ${lines(texts.get(p) ?? "")} lines`);
  }
  return cap(out.join("\n"));
}

/* ------------------------------------------------------------------ */
/* Untested code                                                      */
/* ------------------------------------------------------------------ */

function stem(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return name.replace(/^test_/, "").replace(/(\.(test|spec))?\.[a-z]+$/, "").replace(/_test$/, "").replace(/\.render$/, "");
}

/**
 * Source files no test names or imports, largest first. A test file named
 * after a source file, or one that imports it, counts as covering it; that is
 * a floor on what is untested, not a coverage figure.
 */
export function untestedEvidence(paths: string[], texts: Texts, graph: Map<string, Set<string>>): string {
  const tests = paths.filter((p) => TEST.test(p));
  const source = paths.filter((p) => SOURCE.test(p) && !TEST.test(p) && !NOT_CODE.test(p));
  if (source.length === 0) return "No source files to match against tests.";

  // A test covers the file of its name beside it, or anywhere when it lives
  // in a test folder of its own.
  const dir = (p: string) => p.slice(0, p.lastIndexOf("/") + 1);
  const named = new Set(tests.map((t) => (/(^|\/)(tests?|__tests__|spec)\//.test(t) ? stem(t) : dir(t) + stem(t))));
  const imported = new Set<string>();
  for (const t of tests) for (const dep of graph.get(t) ?? []) imported.add(dep);
  const untested = source.filter((p) => !named.has(stem(p)) && !named.has(dir(p) + stem(p)) && !imported.has(p));

  const size = (p: string) => lines(texts.get(p) ?? "");
  const out = [
    `${tests.length} test files; ${source.length} source files, of which ${untested.length} are neither named by a test file nor imported by one.`,
  ];
  if (untested.length) {
    out.push("The largest of those, with their line counts:");
    for (const p of [...untested].sort((a, b) => size(b) - size(a)).slice(0, 60)) {
      out.push(`- ${p}${texts.has(p) ? `: ${size(p)} lines` : ""}`);
    }
  }
  return cap(out.join("\n"));
}

/* ------------------------------------------------------------------ */
/* Accessibility                                                      */
/* ------------------------------------------------------------------ */

interface Tag {
  name: string;
  attrs: string;
  /** Text up to the matching close tag, for the few rules that need it. */
  inner: string;
  line: number;
  selfClosing: boolean;
}

/** JSX and HTML opening tags, read past `{…}` so an arrow in a prop does not end the tag. */
export function tags(text: string): Tag[] {
  const out: Tag[] = [];
  const open = /<([a-zA-Z][\w.]*)(?=[\s/>])/g;
  for (let m = open.exec(text); m; m = open.exec(text)) {
    let depth = 0;
    let quote: string | null = null;
    let i = m.index + m[0].length;
    for (; i < text.length; i++) {
      const c = text[i]!;
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'" || c === "`") quote = c;
      else if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0) break;
      if (depth < 0) break;
    }
    if (i >= text.length || depth < 0) continue;
    const attrs = text.slice(m.index + m[0].length, i);
    const selfClosing = attrs.trimEnd().endsWith("/");
    const name = m[1]!;
    const close = selfClosing ? -1 : text.indexOf(`</${name}>`, i);
    out.push({
      name,
      attrs,
      inner: close > i ? text.slice(i + 1, Math.min(close, i + 2000)) : "",
      line: text.slice(0, m.index).split("\n").length,
      selfClosing,
    });
  }
  return out;
}

const has = (attrs: string, name: string) => new RegExp(`(^|\\s)${name}(\\s*=|\\s|$|/)`).test(attrs);
const labelled = (attrs: string) => has(attrs, "aria-label") || has(attrs, "aria-labelledby") || has(attrs, "title");

const RULES: Array<{ id: string; say: string; test: (t: Tag) => boolean }> = [
  { id: "img-alt", say: "image with no alt", test: (t) => t.name === "img" && !has(t.attrs, "alt") },
  {
    id: "click-no-key",
    say: "click handler on a non-interactive element with no role or key handler",
    test: (t) =>
      /^(div|span|li|td|tr|section|article|p)$/.test(t.name) &&
      has(t.attrs, "onClick") &&
      !(has(t.attrs, "role") && (has(t.attrs, "onKeyDown") || has(t.attrs, "onKeyUp"))),
  },
  { id: "tabindex-positive", say: "positive tabIndex, which breaks the reading order", test: (t) => /tabIndex=\{?["']?[1-9]/.test(t.attrs) },
  {
    id: "button-name",
    say: "button with no text and no accessible name",
    test: (t) =>
      t.name === "button" &&
      !labelled(t.attrs) &&
      (t.selfClosing || (!t.inner.includes("{") && t.inner.replace(/<[^>]*>/g, "").trim() === "")),
  },
  {
    id: "input-label",
    say: "form field with no id, aria-label or aria-labelledby to name it",
    test: (t) =>
      /^(input|select|textarea)$/.test(t.name) &&
      !/type=["'](hidden|submit|button|reset)["']/.test(t.attrs) &&
      !labelled(t.attrs) &&
      !has(t.attrs, "id"),
  },
  { id: "anchor-href", say: "link with a click handler and no href", test: (t) => t.name === "a" && has(t.attrs, "onClick") && !has(t.attrs, "href") },
  { id: "autofocus", say: "autoFocus, which moves screen-reader users without asking", test: (t) => has(t.attrs, "autoFocus") || has(t.attrs, "autofocus") },
];

/** What a pattern can find in the markup and styles, by rule, with where. */
export function a11yEvidence(texts: Texts): string {
  // Design mock-ups and docs are not what ships.
  const shipped = (p: string) => !TEST.test(p) && !/(^|\/)(design|docs?|examples?|stories|\.storybook)\//.test(p);
  const markup = [...texts].filter(([p]) => /\.(tsx|jsx|html|vue|svelte)$/.test(p) && shipped(p));
  const styles = [...texts].filter(([p]) => /\.(css|scss|sass|less)$/.test(p) && shipped(p));
  if (markup.length === 0) return "No markup files (TSX, JSX, HTML, Vue, Svelte) to check.";

  const hits = new Map<string, string[]>();
  let checked = 0;
  for (const [path, text] of markup) {
    for (const t of tags(text)) {
      checked++;
      for (const r of RULES) if (r.test(t)) hits.set(r.id, [...(hits.get(r.id) ?? []), `${path}:${t.line}`]);
    }
  }

  const all = [...markup, ...styles].map(([, t]) => t).join("\n");
  const outlineNone = (all.match(/outline:\s*none|outline-none\b/g) ?? []).length;
  const focusVisible = (all.match(/focus-visible/g) ?? []).length;
  const motion = (all.match(/@keyframes|animate-\[|animation:|transition[:-]/g) ?? []).length;
  const reduced = /prefers-reduced-motion|motion-reduce|motion-safe/.test(all);
  const htmlTags = markup.flatMap(([p, text]) => tags(text).filter((t) => t.name === "html").map((t) => ({ p, t })));

  const out = [`Pattern checks over ${markup.length} markup files (${checked} tags). Heuristic: confirm each in the file before reporting it.`];
  for (const r of RULES) {
    const where = hits.get(r.id) ?? [];
    out.push(`- ${r.say}: ${where.length}${where.length ? ` (${where.slice(0, 12).join(", ")}${where.length > 12 ? ", …" : ""})` : ""}`);
  }
  out.push(`- outline removed: ${outlineNone} places; focus-visible styles: ${focusVisible}`);
  out.push(`- animations and transitions: ${motion}; reduced-motion handling: ${reduced ? "present" : "none found"}`);
  for (const { p, t } of htmlTags) if (!has(t.attrs, "lang")) out.push(`- <html> with no lang at ${p}:${t.line}`);

  const ratios = contrastEvidence(styles, markup);
  if (ratios) out.push("", ratios);
  return cap(out.join("\n"));
}

/* ------------------------------------------------------------------ */
/* Contrast                                                           */
/* ------------------------------------------------------------------ */

function rgb(value: string): [number, number, number] | null {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (hex) {
    const h = hex[1]!.length === 3 ? [...hex[1]!].map((c) => c + c).join("") : hex[1]!;
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
  }
  const fn = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(value.trim());
  return fn ? [Number(fn[1]), Number(fn[2]), Number(fn[3])] : null;
}

function luminance([r, g, b]: [number, number, number]): number {
  const ch = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

export function contrast(a: string, b: string): number | null {
  const x = rgb(a);
  const y = rgb(b);
  if (!x || !y) return null;
  const [hi, lo] = [luminance(x), luminance(y)].sort((m, n) => n - m) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Every block of custom properties, by its selector. */
function customProperties(styles: Array<[string, string]>): Array<{ selector: string; vars: Map<string, string> }> {
  const blocks: Array<{ selector: string; vars: Map<string, string> }> = [];
  for (const [, css] of styles) {
    for (const m of css.matchAll(/([^{}]*?)\{([^{}]*)\}/g)) {
      const vars = new Map<string, string>();
      for (const v of m[2]!.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) vars.set(v[1]!, v[2]!.replace(/\/\*.*?\*\//g, "").trim());
      // The selector, without the comments and statements that ran up to it.
      const selector = m[1]!.replace(/\/\*[\s\S]*?\*\//g, "").split(";").pop()!.trim();
      if (vars.size) blocks.push({ selector, vars });
    }
  }
  return blocks;
}

/**
 * The colours a page really puts together: a text and a background utility
 * on one element (`text-muted bg-card`), or a CSS rule that sets both.
 * Checked in every theme the stylesheet defines, against WCAG's 4.5:1 for
 * body text. A background inherited from a parent is not followed: guessing
 * it reads as many false alarms as findings.
 */
export function contrastEvidence(styles: Array<[string, string]>, markup: Array<[string, string]> = []): string | null {
  const blocks = customProperties(styles);
  const root = new Map<string, string>();
  for (const b of blocks) if (/^(:root|html)$|^@theme/.test(b.selector)) for (const [k, v] of b.vars) root.set(k, v);
  if (root.size === 0) return null;
  const themes: Array<[string, Map<string, string>]> = [["light", root]];
  for (const b of blocks) {
    if (/dark/.test(b.selector)) themes.push([`dark (${b.selector.replace(/\s+/g, " ").slice(0, 60)})`, new Map([...root, ...b.vars])]);
  }

  // A utility name to the property it reads: Tailwind's `--color-x` makes `text-x` and `bg-x`.
  const utility = (name: string): string | null => {
    if (root.has(`color-${name}`)) return `color-${name}`;
    const arbitrary = /^\[var\(--([\w-]+)\)\]$/.exec(name);
    return arbitrary ? arbitrary[1]! : null;
  };

  const pairs = new Map<string, { fg: string; bg: string; where: string }>();
  const add = (fg: string, bg: string, where: string) => {
    if (!pairs.has(`${fg}|${bg}`)) pairs.set(`${fg}|${bg}`, { fg, bg, where });
  };
  for (const [path, css] of styles) {
    for (const m of css.matchAll(/([^{}]*?)\{([^{}]*)\}/g)) {
      const body = m[2]!;
      const fg = /(?:^|[;\s])color:\s*var\(--([\w-]+)\)/.exec(body)?.[1];
      const bg = /background(?:-color)?:\s*var\(--([\w-]+)\)/.exec(body)?.[1];
      const selector = m[1]!.replace(/\/\*[\s\S]*?\*\//g, "").split(";").pop()!.trim();
      if (fg && bg) add(fg, bg, `${path} (${selector.slice(0, 40)})`);
    }
  }
  for (const [path, text] of markup) {
    for (const m of text.matchAll(/["'`]([^"'`]*\btext-[^"'`]*)["'`]/g)) {
      const classes = m[1]!.split(/\s+/).filter((c) => !c.includes(":"));
      const fg = classes.map((c) => /^text-(.+)$/.exec(c)?.[1]).map((n) => (n ? utility(n) : null)).find(Boolean);
      const bg = classes.map((c) => /^bg-(.+)$/.exec(c)?.[1]).map((n) => (n ? utility(n) : null)).find(Boolean);
      if (fg && bg) add(fg, bg, path);
    }
  }
  if (pairs.size === 0) return null;

  const out: string[] = [];
  for (const [theme, vars] of themes) {
    const value = (name: string, depth = 0): string | null => {
      const v = vars.get(name);
      if (!v || depth > 5) return null;
      const ref = /^var\(--([\w-]+)\)$/.exec(v);
      return ref ? value(ref[1]!, depth + 1) : v;
    };
    const failing: string[] = [];
    for (const { fg, bg, where } of pairs.values()) {
      const fv = value(fg);
      const bv = value(bg);
      const ratio = fv && bv ? contrast(fv, bv) : null;
      if (ratio !== null && ratio < 4.5) failing.push(`--${fg} ${fv} on --${bg} ${bv}: ${ratio.toFixed(2)}:1 (e.g. ${where})`);
    }
    out.push(
      failing.length
        ? `Under 4.5:1 in the ${theme} theme (fine only for large text or non-text marks):\n${failing.slice(0, 20).map((l) => `- ${l}`).join("\n")}`
        : `Every pair clears 4.5:1 in the ${theme} theme.`,
    );
  }
  return `Contrast of ${pairs.size} colour pairs used together (one element's text and background utilities, or one CSS rule's; inherited backgrounds are not followed):\n${out.join("\n")}`;
}

/* ------------------------------------------------------------------ */
/* Outlines                                                           */
/* ------------------------------------------------------------------ */

const DECL =
  /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|interface|type|enum|const|let|var|def|func|fn|pub\s+fn|struct|impl|module)\s+[\w$]+|^\s{2}(?:(?:public|private|protected|static|readonly|async|get|set)\s+)*(?!(?:if|for|while|switch|catch|return|else|do|try|with)\b)[\w$]+\s*(?:<[^>]*>)?\([^)]*\)?\s*(?::\s*[^{=]+)?\{\s*$/;

/**
 * The declarations in the part of a file a sentinel was not shown, with their
 * line numbers, so it can ask for the ones it needs.
 */
export function outline(text: string, fromLine: number, max = 80): string[] {
  const out: string[] = [];
  const all = text.split("\n");
  for (let i = fromLine; i < all.length && out.length < max; i++) {
    const l = all[i]!;
    if (DECL.test(l)) out.push(`${i + 1}: ${l.trim().slice(0, 120)}`);
  }
  return out;
}

function cap(text: string): string {
  return text.length > SECTION_CAP ? `${text.slice(0, SECTION_CAP)}\n… (trimmed)` : text;
}
