/**
 * The playtest proxy: a small Node server written into the sandbox, in front
 * of the product. See docs/plans/playtest.md, "The playtest proxy".
 *
 * - It forwards every request, and WebSocket upgrades for a dev server's
 *   reload, to the product on 127.0.0.1, with the Host header the product
 *   expects (a dev server that checks it would refuse the sandbox's).
 * - Or, for a product that is files, it serves them.
 * - It adds one script to every HTML page: the capture helper below.
 * - It drops X-Frame-Options and Content-Security-Policy, which would keep the
 *   page out of Formic's frame or block the helper.
 * - /__formic/ready answers 200 once the product does.
 *
 * Plain Node with no packages: the sandbox has Node and nothing else is
 * guaranteed.
 */

/** The port the proxy listens on, and the one the public URL is for. */
export const PROXY_PORT = 8484;
/** Where it is written in the sandbox. */
export const PROXY_PATH = "/tmp/formic-playtest/proxy.js";

/**
 * The library the helper renders a page region with, when the region is not
 * one canvas. Fetched into the sandbox from the npm registry and served by the
 * proxy on the product's own origin, so the page needs no CDN.
 */
export const CAPTURE_LIBRARY = "html-to-image@1.11.11";
export const FETCH_CAPTURE_LIBRARY = [
  "cd /tmp/formic-playtest",
  `npm pack ${CAPTURE_LIBRARY} --silent >/dev/null 2>&1`,
  "tar -xzf html-to-image-*.tgz package/dist/html-to-image.js 2>/dev/null && mv package/dist/html-to-image.js . && rm -rf package html-to-image-*.tgz",
  "true",
].join("\n");

/**
 * The helper, run inside the product's own page. It says hello to Formic,
 * keeps WebGL canvases readable between frames (a Godot game's would read as
 * blank otherwise), and answers capture requests with a PNG of a region.
 *
 * It only talks to the Formic origin it is given.
 */
export const HELPER_SCRIPT = String.raw`(function () {
  var ORIGIN = __FORMIC_ORIGIN__;
  if (window.__formicPlaytest) return;
  window.__formicPlaytest = true;

  var getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, attrs) {
    if (type === "webgl" || type === "webgl2" || type === "experimental-webgl") {
      attrs = Object.assign({}, attrs || {}, { preserveDrawingBuffer: true });
    }
    return getContext.call(this, type, attrs);
  };

  function post(msg) {
    try { window.parent.postMessage(msg, ORIGIN); } catch (e) {}
  }

  function loadHtmlToImage() {
    if (window.htmlToImage) return Promise.resolve(window.htmlToImage);
    return new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = "/__formic/html-to-image.js";
      s.onload = function () { resolve(window.htmlToImage); };
      s.onerror = function () { reject(new Error("Could not load the capture library.")); };
      document.head.appendChild(s);
    });
  }

  /** The canvas covering most of the region, if one does: a game. */
  function mainCanvas(rect) {
    var best = null, bestArea = 0;
    var canvases = document.querySelectorAll("canvas");
    for (var i = 0; i < canvases.length; i++) {
      var r = canvases[i].getBoundingClientRect();
      var w = Math.min(r.right, rect.x + rect.w) - Math.max(r.left, rect.x);
      var h = Math.min(r.bottom, rect.y + rect.h) - Math.max(r.top, rect.y);
      var area = Math.max(0, w) * Math.max(0, h);
      if (area > bestArea) { best = canvases[i]; bestArea = area; }
    }
    return best && bestArea >= rect.w * rect.h * 0.9 ? best : null;
  }

  function crop(source, sx, sy, sw, sh, scale) {
    var out = document.createElement("canvas");
    out.width = Math.max(1, Math.round(sw * scale));
    out.height = Math.max(1, Math.round(sh * scale));
    out.getContext("2d").drawImage(source, sx, sy, sw, sh, 0, 0, out.width, out.height);
    return out.toDataURL("image/png");
  }

  function capture(rect) {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var canvas = mainCanvas(rect);
    if (canvas) {
      var r = canvas.getBoundingClientRect();
      var kx = canvas.width / r.width, ky = canvas.height / r.height;
      return Promise.resolve(crop(canvas, (rect.x - r.left) * kx, (rect.y - r.top) * ky, rect.w * kx, rect.h * ky, 1));
    }
    return loadHtmlToImage().then(function (lib) {
      var root = document.documentElement;
      return lib.toCanvas(root, {
        width: window.innerWidth,
        height: window.innerHeight,
        pixelRatio: dpr,
        style: { transform: "translate(" + -window.scrollX + "px," + -window.scrollY + "px)" },
        cacheBust: true,
      });
    }).then(function (full) {
      return crop(full, rect.x * dpr, rect.y * dpr, rect.w * dpr, rect.h * dpr, 1);
    });
  }

  window.addEventListener("message", function (e) {
    if (e.origin !== ORIGIN || !e.data || e.data.type !== "formic:capture") return;
    var id = e.data.id;
    capture(e.data.rect).then(
      function (dataUrl) { post({ type: "formic:shot", id: id, dataUrl: dataUrl }); },
      function (err) { post({ type: "formic:shot", id: id, error: String(err && err.message || err) }); }
    );
  });

  post({ type: "formic:hello" });
  window.addEventListener("load", function () { post({ type: "formic:hello" }); });
})();`;

/**
 * The proxy itself. Reads PROXY_PORT, APP_PORT or STATIC_DIR, and
 * FORMIC_ORIGIN from its environment.
 */
export const PROXY_SCRIPT = String.raw`"use strict";
const http = require("http");
const net = require("net");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PROXY_PORT || 8484);
const APP_PORT = Number(process.env.APP_PORT || 0);
const STATIC_DIR = process.env.STATIC_DIR ? path.resolve(process.env.STATIC_DIR) : null;
const HELPER = fs.readFileSync(path.join(__dirname, "helper.js"), "utf8")
  .replace("__FORMIC_ORIGIN__", JSON.stringify(process.env.FORMIC_ORIGIN || ""));
const TAG = '<script src="/__formic/helper.js"></script>';

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".wasm": "application/wasm",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".svg": "image/svg+xml", ".webp": "image/webp", ".ico": "image/x-icon",
  ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".wav": "audio/wav", ".mp4": "video/mp4",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".pck": "application/octet-stream",
};

function inject(html) {
  const at = html.search(/<head[^>]*>/i);
  if (at < 0) return TAG + html;
  const end = html.indexOf(">", at) + 1;
  return html.slice(0, end) + TAG + html.slice(end);
}

function cleanHeaders(headers) {
  const out = Object.assign({}, headers);
  delete out["x-frame-options"];
  delete out["content-security-policy"];
  delete out["content-security-policy-report-only"];
  return out;
}

function serveStatic(req, res) {
  let rel = decodeURIComponent((req.url || "/").split("?")[0]);
  if (rel.endsWith("/")) rel += "index.html";
  const file = path.join(STATIC_DIR, path.normalize(rel));
  if (!file.startsWith(STATIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    const type = TYPES[path.extname(file).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
    res.end(type.startsWith("text/html") ? inject(data.toString("utf8")) : data);
  });
}

function forward(req, res) {
  const headers = Object.assign({}, req.headers, { host: "localhost:" + APP_PORT, "accept-encoding": "identity" });
  const up = http.request({ host: "127.0.0.1", port: APP_PORT, method: req.method, path: req.url, headers }, (r) => {
    const headers = cleanHeaders(r.headers);
    const html = String(r.headers["content-type"] || "").includes("text/html");
    if (!html) { res.writeHead(r.statusCode || 502, headers); return r.pipe(res); }
    const chunks = [];
    r.on("data", (c) => chunks.push(c));
    r.on("end", () => {
      const body = inject(Buffer.concat(chunks).toString("utf8"));
      delete headers["content-length"];
      delete headers["content-encoding"];
      res.writeHead(r.statusCode || 200, headers);
      res.end(body);
    });
  });
  up.on("error", () => { res.writeHead(502); res.end("The product is not answering yet."); });
  req.pipe(up);
}

function ready(cb) {
  if (STATIC_DIR) return cb(fs.existsSync(path.join(STATIC_DIR, "index.html")));
  const s = net.connect(APP_PORT, "127.0.0.1");
  s.on("connect", () => { s.destroy(); cb(true); });
  s.on("error", () => cb(false));
}

const server = http.createServer((req, res) => {
  if (req.url === "/__formic/helper.js") {
    res.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" });
    return res.end(HELPER);
  }
  if (req.url === "/__formic/html-to-image.js") {
    return fs.readFile(path.join(__dirname, "html-to-image.js"), (err, data) => {
      if (err) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { "content-type": "text/javascript", "cache-control": "max-age=3600" });
      res.end(data);
    });
  }
  if (req.url === "/__formic/ready") {
    return ready((ok) => { res.writeHead(ok ? 200 : 503); res.end(ok ? "ready" : "waiting"); });
  }
  if (STATIC_DIR) return serveStatic(req, res);
  forward(req, res);
});

server.on("upgrade", (req, socket, head) => {
  if (STATIC_DIR) return socket.destroy();
  const up = net.connect(APP_PORT, "127.0.0.1", () => {
    const lines = [req.method + " " + req.url + " HTTP/1.1"];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i];
      const value = name.toLowerCase() === "host" ? "localhost:" + APP_PORT : req.rawHeaders[i + 1];
      lines.push(name + ": " + value);
    }
    up.write(lines.join("\r\n") + "\r\n\r\n");
    if (head && head.length) up.write(head);
    socket.pipe(up).pipe(socket);
  });
  up.on("error", () => socket.destroy());
  socket.on("error", () => up.destroy());
});

server.listen(PORT, "0.0.0.0", () => console.log("formic playtest proxy on " + PORT));
`;
