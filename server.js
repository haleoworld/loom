#!/usr/bin/env node
"use strict";
/* Loom sync server — no dependencies.
   Serves the app (index.html, sw.js) and a tiny GET/PUT /data store.
   Data + token live OUTSIDE the repo in ~/.loom so nothing secret is committed.
   Auth: Bearer token (auto-generated). Reachable only via Tailscale (tailnet-only). */

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { execFile } = require("child_process");

const PORT = process.env.LOOM_PORT ? +process.env.LOOM_PORT : 8743;
const BASE = process.env.LOOM_BASE || "/loom";   // browser-facing Tailscale mount path
const APP_DIR = __dirname;
const DATA_DIR = path.join(os.homedir(), ".loom");
const DATA_FILE = path.join(DATA_DIR, "data.json");
const TOKEN_FILE = path.join(DATA_DIR, "token");
const AUDIO_DIR = path.join(DATA_DIR, "audio");
// Transcription via MLX Whisper (medium), sharing the model already cached for
// the other project — no duplicate model. mlx_whisper decodes audio via ffmpeg.
const PY = process.env.LOOM_PY || path.join(DATA_DIR, "venv", "bin", "python");
const TRANSCRIBE_PY = path.join(DATA_DIR, "transcribe.py");
const BIN_PATH = "/opt/homebrew/bin:" + (process.env.PATH || "");  // so mlx_whisper finds ffmpeg

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(AUDIO_DIR, { recursive: true });

// token: load or create
let TOKEN;
try { TOKEN = fs.readFileSync(TOKEN_FILE, "utf8").trim(); }
catch (e) { TOKEN = crypto.randomBytes(24).toString("hex"); fs.writeFileSync(TOKEN_FILE, TOKEN, { mode: 0o600 }); }

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png" };

function authed(req) {
  const h = req.headers["authorization"] || "";
  const got = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (got.length !== TOKEN.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(TOKEN)); } catch (e) { return false; }
}
function cors(res, req) {
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,PUT,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization,Content-Type");
  res.setHeader("Vary", "Origin");
}
function send(res, code, body, type) {
  res.writeHead(code, { "Content-Type": type || "text/plain; charset=utf-8" });
  res.end(body);
}
function readData() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); } catch (e) { return null; }
}

const server = http.createServer((req, res) => {
  cors(res, req);
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  // strip optional /loom mount prefix (Tailscale --set-path) + query
  let urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  urlPath = urlPath.replace(/^\/loom(?=\/|$)/, "");
  if (urlPath === "") urlPath = "/";

  // ---- data API ----
  if (urlPath === "/data") {
    if (!authed(req)) return send(res, 401, "unauthorized");
    if (req.method === "GET") {
      const d = readData();
      return send(res, 200, JSON.stringify(d || {}), TYPES[".json"]);
    }
    if (req.method === "PUT") {
      let body = "";
      req.on("data", c => { body += c; if (body.length > 16 * 1024 * 1024) req.destroy(); });
      req.on("end", () => {
        let incoming;
        try { incoming = JSON.parse(body); } catch (e) { return send(res, 400, "bad json"); }
        const cur = readData();
        const curV = (cur && cur.meta && cur.meta.updatedAt) || 0;
        const inV = (incoming && incoming.meta && incoming.meta.updatedAt) || 0;
        // last-write-wins guard: reject stale writes so the client re-pulls and merges
        if (cur && inV < curV) {
          return send(res, 409, JSON.stringify(cur), TYPES[".json"]);
        }
        const tmp = DATA_FILE + ".tmp";
        fs.writeFile(tmp, JSON.stringify(incoming), err => {
          if (err) return send(res, 500, "write failed");
          fs.renameSync(tmp, DATA_FILE);
          send(res, 200, JSON.stringify({ ok: true, updatedAt: inV }), TYPES[".json"]);
        });
      });
      return;
    }
    return send(res, 405, "method not allowed");
  }

  // ---- voice: transcribe audio with local whisper (auto language) ----
  if (urlPath === "/transcribe" && req.method === "POST") {
    if (!authed(req)) return send(res, 401, "unauthorized");
    const ct = (req.headers["content-type"] || "").toLowerCase();
    const ext = ct.includes("mp4") || ct.includes("m4a") || ct.includes("aac") ? "m4a"
              : ct.includes("webm") ? "webm" : ct.includes("ogg") ? "ogg" : ct.includes("wav") ? "wav" : "bin";
    const id = crypto.randomBytes(8).toString("hex");
    const raw = path.join(AUDIO_DIR, id + "." + ext);
    const ws = fs.createWriteStream(raw);
    let size = 0, tooBig = false;
    req.on("data", c => { size += c.length; if (size > 50 * 1024 * 1024) { tooBig = true; req.destroy(); } });
    req.on("error", () => { try { ws.destroy(); fs.unlinkSync(raw); } catch (_) {} });
    req.pipe(ws);
    ws.on("finish", () => {
      if (tooBig) { try { fs.unlinkSync(raw); } catch (_) {} return send(res, 413, "too large"); }
      execFile(PY, [TRANSCRIBE_PY, raw], { maxBuffer: 16 * 1024 * 1024, env: Object.assign({}, process.env, { PATH: BIN_PATH }) }, (err, stdout, stderr) => {
        if (err) { console.error("[loom] transcribe failed:", (stderr || err).toString().slice(0, 400)); return send(res, 500, JSON.stringify({ error: "transcribe" }), TYPES[".json"]); }
        send(res, 200, JSON.stringify({ text: (stdout || "").trim(), audioId: id + "." + ext, bytes: size }), TYPES[".json"]);
      });
    });
    return;
  }
  // ---- voice: audio storage stats / purge ----
  if (urlPath === "/audio/stats" && req.method === "GET") {
    if (!authed(req)) return send(res, 401, "unauthorized");
    let count = 0, bytes = 0;
    try { for (const f of fs.readdirSync(AUDIO_DIR)) { const st = fs.statSync(path.join(AUDIO_DIR, f)); if (st.isFile()) { count++; bytes += st.size; } } } catch (_) {}
    return send(res, 200, JSON.stringify({ count, bytes }), TYPES[".json"]);
  }
  if (urlPath === "/audio" && req.method === "DELETE") {
    if (!authed(req)) return send(res, 401, "unauthorized");
    let n = 0;
    try { for (const f of fs.readdirSync(AUDIO_DIR)) { fs.unlinkSync(path.join(AUDIO_DIR, f)); n++; } } catch (_) {}
    return send(res, 200, JSON.stringify({ deleted: n }), TYPES[".json"]);
  }

  // ---- static app ----
  if (req.method !== "GET") return send(res, 405, "method not allowed");
  let file = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  if (file.includes("..")) return send(res, 403, "no");
  const full = path.join(APP_DIR, file);
  if (!full.startsWith(APP_DIR)) return send(res, 403, "no");

  fs.readFile(full, (err, buf) => {
    if (err) return send(res, 404, "not found");
    const ext = path.extname(full).toLowerCase();
    if (ext === ".html") {
      // inject sync config so the app on the tailnet just works, no token typing
      const cfg = `<script>window.LOOM_SYNC=${JSON.stringify({ token: TOKEN, url: BASE + "/data", sw: BASE + "/sw.js", scope: BASE + "/", transcribe: BASE + "/transcribe", audio: BASE + "/audio" })};</script>`;
      const html = buf.toString("utf8").replace("<!--LOOM_CONFIG-->", cfg);
      res.setHeader("Cache-Control", "no-cache");
      return send(res, 200, html, TYPES[".html"]);
    }
    if (ext === ".js") res.setHeader("Service-Worker-Allowed", "/");
    send(res, 200, buf, TYPES[ext] || "application/octet-stream");
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[loom] sync server on http://127.0.0.1:${PORT}  data=${DATA_FILE}`);
});
