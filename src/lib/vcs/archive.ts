import { inflateRawSync } from "node:zlib";

/**
 * Reading the two archive formats GitHub hands back: the tarball of a ref
 * (one request for a whole repository, where the contents API costs one per
 * file) and the zip an Actions artifact downloads as.
 *
 * Both are read in full into memory, so both are bounded by what the caller
 * says it will keep: an entry nobody wants is skipped, not stored.
 */

/** Which entries to keep, by their path inside the archive. */
export type Keep = (path: string, size: number) => boolean;

export interface Unpacked {
  files: Map<string, Buffer>;
  /** True when the byte budget ran out before the archive did. */
  truncated: boolean;
}

/**
 * Entries of a tar stream, read as chunks arrive. GitHub's tarballs put every
 * path under one `owner-repo-sha/` folder, which `stripFirst` drops.
 */
export async function untar(
  chunks: AsyncIterable<Uint8Array>,
  keep: Keep,
  budget: number,
  stripFirst = true,
): Promise<Unpacked> {
  const files = new Map<string, Buffer>();
  let truncated = false;
  let buf = Buffer.alloc(0);
  // The entry being read: how many bytes of it remain, and whether to keep them.
  type Entry = { path: string; left: number; pad: number; parts: Buffer[] | null };
  let entry: Entry | null = null;
  let longName: string | null = null;
  let kept = 0;

  const finish = (e: Entry) => {
    if (e.parts) files.set(e.path, Buffer.concat(e.parts));
  };

  for await (const chunk of chunks) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : Buffer.from(chunk);
    for (;;) {
      if (entry) {
        const take = Math.min(entry.left, buf.length);
        if (entry.parts) entry.parts.push(buf.subarray(0, take));
        entry.left -= take;
        buf = buf.subarray(take);
        if (entry.left > 0) break;
        if (buf.length < entry.pad) break;
        buf = buf.subarray(entry.pad);
        const done: Entry = entry;
        entry = null;
        if (done.path === "\0pax" || done.path === "\0long") {
          const text = Buffer.concat(done.parts ?? []).toString("utf8");
          longName = done.path === "\0long" ? text.replace(/\0+$/, "") : (/(?:^|\n)\d+ path=([^\n]*)\n/.exec(text)?.[1] ?? null);
        } else {
          finish(done);
        }
        continue;
      }
      if (buf.length < 512) break;
      const header = buf.subarray(0, 512);
      buf = buf.subarray(512);
      if (header.every((b) => b === 0)) continue;

      const field = (start: number, len: number) => header.subarray(start, start + len).toString("utf8").replace(/\0.*$/s, "");
      const size = parseInt(field(124, 12).trim() || "0", 8);
      const type = String.fromCharCode(header[156] || 48);
      const prefix = field(345, 155);
      let path: string = longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
      longName = null;
      const pad = (512 - (size % 512)) % 512;

      if (type === "x" || type === "L") {
        entry = { path: type === "x" ? "\0pax" : "\0long", left: size, pad, parts: [] };
        continue;
      }
      if (stripFirst) path = path.slice(path.indexOf("/") + 1);
      const wanted = (type === "0" || type === "\0") && path !== "" && !truncated && keep(path, size);
      const fits = wanted && kept + size <= budget;
      if (wanted && !fits) truncated = true;
      if (fits) kept += size;
      entry = { path, left: size, pad, parts: fits ? [] : null };
    }
  }
  if (entry?.parts && entry.left === 0) finish(entry);
  return { files, truncated };
}

/**
 * The entries of a zip, by its central directory. Stored and deflated
 * entries only, which is all `actions/upload-artifact` writes.
 */
export function unzip(zip: Buffer, keep: Keep, budget: number): Unpacked {
  const files = new Map<string, Buffer>();
  let truncated = false;
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65_557); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Not a zip archive.");

  const count = zip.readUInt16LE(eocd + 10);
  let at = zip.readUInt32LE(eocd + 16);
  let kept = 0;
  for (let n = 0; n < count; n++) {
    if (zip.readUInt32LE(at) !== 0x02014b50) break;
    const method = zip.readUInt16LE(at + 10);
    const packed = zip.readUInt32LE(at + 20);
    const size = zip.readUInt32LE(at + 24);
    const nameLen = zip.readUInt16LE(at + 28);
    const extraLen = zip.readUInt16LE(at + 30);
    const commentLen = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const path = zip.subarray(at + 46, at + 46 + nameLen).toString("utf8");
    at += 46 + nameLen + extraLen + commentLen;

    if (path.endsWith("/") || !keep(path, size) || (method !== 0 && method !== 8)) continue;
    if (kept + size > budget) {
      truncated = true;
      continue;
    }
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = zip.subarray(start, start + packed);
    files.set(path, method === 0 ? Buffer.from(data) : inflateRawSync(data));
    kept += size;
  }
  return { files, truncated };
}
