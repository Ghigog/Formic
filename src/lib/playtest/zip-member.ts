/**
 * Pulls a few files out of a zip on the web without downloading the rest.
 *
 * Godot's export templates come as one archive of about 1.3 GB, which does
 * not fit on a sandbox's disk, and Playtest needs one file of it (the Web
 * template, a few tens of MB). Zip keeps its index at the end, so a reader
 * that can seek fetches the index and that one file with HTTP range requests.
 *
 * Python, because the sandbox has it and its zipfile reads any seekable file.
 * Usage: python3 - <url> <dest dir> <member>... (the script on stdin).
 */
export const ZIP_MEMBER_SCRIPT = String.raw`
import io, os, shutil, sys, urllib.request

url, dest, members = sys.argv[1], sys.argv[2], sys.argv[3:]

# Follow the release's redirect once; the signed address it lands on takes ranges.
with urllib.request.urlopen(urllib.request.Request(url, method="HEAD")) as r:
    url = r.geturl()
    size = int(r.headers["Content-Length"])
    if r.headers.get("Accept-Ranges", "").lower() != "bytes":
        sys.exit("The download does not allow ranges, so it cannot be read in part.")

class Remote(io.RawIOBase):
    def __init__(self):
        self.pos = 0
    def readable(self):
        return True
    def seekable(self):
        return True
    def tell(self):
        return self.pos
    def seek(self, offset, whence=0):
        self.pos = offset if whence == 0 else self.pos + offset if whence == 1 else size + offset
        return self.pos
    def readinto(self, buf):
        if self.pos >= size:
            return 0
        end = min(self.pos + len(buf), size) - 1
        req = urllib.request.Request(url, headers={"Range": "bytes=%d-%d" % (self.pos, end)})
        with urllib.request.urlopen(req) as r:
            data = r.read()
        buf[: len(data)] = data
        self.pos += len(data)
        return len(data)

import zipfile
os.makedirs(dest, exist_ok=True)
with zipfile.ZipFile(io.BufferedReader(Remote(), buffer_size=4 << 20)) as z:
    names = set(z.namelist())
    for member in members:
        if member not in names:
            sys.exit("%s is not in the archive." % member)
        with z.open(member) as src, open(os.path.join(dest, os.path.basename(member)), "wb") as out:
            shutil.copyfileobj(src, out, 4 << 20)
        print("Fetched %s" % os.path.basename(member))
`;
