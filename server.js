#!/usr/bin/env node
"use strict";
/* Loom sync server — no dependencies.
   Serves the app (index.html, sw.js) and a tiny GET/PUT /data store.
   Data + token live OUTSIDE the repo in ~/.loom so nothing secret is committed.
   Auth: Bearer token (auto-generated). Reachable only via Tailscale (tailnet-only). */

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { execFile, spawn } = require("child_process");

const PORT = process.env.LOOM_PORT ? +process.env.LOOM_PORT : 8743;
const BASE = process.env.LOOM_BASE || "/loom";   // browser-facing Tailscale mount path
const APP_DIR = __dirname;
const DATA_DIR = path.join(os.homedir(), ".loom");
const DATA_FILE = path.join(DATA_DIR, "data.json");
const TOKEN_FILE = path.join(DATA_DIR, "token");
const AUDIO_DIR = path.join(DATA_DIR, "audio");
const IMAGE_DIR = path.join(DATA_DIR, "images");
// Transcription via MLX Whisper (medium), sharing the model already cached for
// the other project — no duplicate model. mlx_whisper decodes audio via ffmpeg.
const PY = process.env.LOOM_PY || path.join(DATA_DIR, "venv", "bin", "python");
const TRANSCRIBE_PY = path.join(DATA_DIR, "transcribe.py");
const SUMMARIZE_PY = path.join(DATA_DIR, "summarize.py");
const ANTH_KEY_FILE = path.join(DATA_DIR, "anthropic_key");
const PLAN_MODEL = process.env.LOOM_PLAN_MODEL || "claude-sonnet-4-6";
function anthKey() { try { return fs.readFileSync(ANTH_KEY_FILE, "utf8").trim(); } catch (e) { return ""; } }
function callAnthropic(prompt, maxTokens, cb) {
  const key = anthKey();
  if (!key) return cb(new Error("no API key on the Mini"));
  const payload = JSON.stringify({ model: PLAN_MODEL, max_tokens: maxTokens || 2000, messages: [{ role: "user", content: prompt }] });
  const r = https.request({ hostname: "api.anthropic.com", path: "/v1/messages", method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json", "content-length": Buffer.byteLength(payload) } },
    resp => { let d = ""; resp.on("data", c => d += c); resp.on("end", () => {
      try { const j = JSON.parse(d); if (j.error) return cb(new Error(j.error.message || "API error")); cb(null, (j.content || []).map(b => b.text || "").join("").trim()); }
      catch (e) { cb(e); } }); });
  r.on("error", cb); r.write(payload); r.end();
}
// ---- Telegram + coaching ----
function tgToken() { try { return fs.readFileSync(path.join(DATA_DIR, "telegram_token"), "utf8").trim(); } catch (e) { return ""; } }
function tgChat() { try { return fs.readFileSync(path.join(DATA_DIR, "telegram_chat"), "utf8").trim(); } catch (e) { return ""; } }
function tgApi(method, params, cb) {
  const tok = tgToken(); if (!tok) return cb && cb(new Error("no telegram token"));
  const payload = JSON.stringify(params || {});
  const r = https.request({ hostname: "api.telegram.org", path: `/bot${tok}/${method}`, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } },
    resp => { let d = ""; resp.on("data", c => d += c); resp.on("end", () => { try { cb && cb(null, JSON.parse(d)); } catch (e) { cb && cb(e); } }); });
  r.on("error", e => cb && cb(e)); r.write(payload); r.end();
}
function tgSend(text, cb) {
  const chat = tgChat(); if (!chat) return cb && cb(new Error("no chat id"));
  const chunks = []; let s = String(text);
  while (s.length > 4000) { let cut = s.lastIndexOf("\n", 4000); if (cut < 2000) cut = 4000; chunks.push(s.slice(0, cut)); s = s.slice(cut); }
  chunks.push(s);
  let i = 0; (function next() { if (i >= chunks.length) return cb && cb(null); tgApi("sendMessage", { chat_id: chat, text: chunks[i++] }, e => { if (e) return cb && cb(e); next(); }); })();
}
const PRI_EMOJI = { critical: "🔴", high: "🟠", med: "🟡", low: "🟢" };
const PRI_RANK = { critical: 0, high: 1, med: 2, low: 3 };
function effPriSrv(t) { let p = t.priority || null; if (t.escalateWithin && t.due && Date.now() >= (t.due - t.escalateWithin * 86400000)) { if ((PRI_RANK[p] ?? 9) > PRI_RANK.high) p = "high"; } return p; }
function rollDueServer(ts, period) { const d = new Date(ts); if (period === "weekly") d.setDate(d.getDate() + 7); else if (period === "monthly") d.setMonth(d.getMonth() + 1); else if (period === "yearly") d.setFullYear(d.getFullYear() + 1); return d.getTime(); }
function domLabel(data, key) { const m = (data.domains || []).find(x => x[0] === key); return m ? m[1] : (key || "—"); }
function openTasksOrdered(data) { const pr = { high: 0, med: 1, low: 2 }; return (data.tasks || []).filter(t => !t.done).sort((a, b) => { const ao = a.due || 8e15, bo = b.due || 8e15; if (ao !== bo) return ao - bo; return (pr[a.priority] ?? 1) - (pr[b.priority] ?? 1); }); }
function buildPlanPrompt(data, kind) {
  const g = data.global || {};
  const goals = (g.goals || []).map((x, i) => `  ${i + 1}. ${x}`).join("\n") || "  (none)";
  const models = (g.models || []).map(x => `  - ${x}`).join("\n") || "  (none)";
  const projects = (data.projects || []).map(p => `  - ${p.name} [${domLabel(data, p.domain)}] — goal: ${p.goal || "?"}; role: ${p.role || "?"}`).join("\n") || "  (none)";
  const active = (data.threads || []).filter(t => t.status === "active").sort((a, b) => b.lastActivityAt - a.lastActivityAt).slice(0, 25).map(t => { const p = (data.projects || []).find(x => x.id === t.projectId); return `  - "${t.title}" [${p ? p.name : "life"} / ${domLabel(data, t.domain)}, depth ${t.depthLevel}]`; }).join("\n") || "  (none)";
  const acts = (data.threads || []).filter(t => t.outcome && (t.outcome.type === "decision" || t.outcome.type === "action")).map(t => `  - [${t.outcome.type}] ${t.title}: ${t.outcome.content}`).join("\n") || "  (none)";
  const tasks = openTasksOrdered(data).map(t => `  - ${t.title}${t.due ? ` [due ${new Date(t.due).toISOString().slice(0, 10)}]` : ""}${t.recurring ? ` [repeats ${t.recurring}]` : ""}${t.priority ? ` [${t.priority}]` : ""}`).join("\n") || "  (none)";
  const refl = (data.reflections || []).slice().sort((a, b) => b.createdAt - a.createdAt)[0]; const reflTxt = refl ? refl.body : "(none yet)";
  const lp = (data.plans || []).slice().sort((a, b) => b.createdAt - a.createdAt)[0]; const lpTxt = lp ? (lp.body.length > 1200 ? lp.body.slice(0, 1200) + "…" : lp.body) : "(none)";
  return `You are my executive coach & thinking partner. Build me a prioritized plan from my whole picture. Be specific, reference my actual goals/projects/tasks, be honest like a coach not a cheerleader, and keep it tight enough to read on a phone.

## MY GLOBAL FRAME
Life goals:
${goals}
Thinking models:
${models}

## PROJECTS
${projects}
## ACTIVE THREADS
${active}
## COMMITTED DECISIONS/ACTIONS
${acts}
## AD-HOC TASKS
${tasks}
## MY LATEST REFLECTION (weigh heavily)
${reflTxt}
## MY PREVIOUS PLAN (check progress vs this)
${lpTxt}

## CONTEXT: busy life, 2 young kids; limited time/energy is my #1 constraint. Roots: reclaim time/energy; communicate + delegate instead of doing everything; become the orchestrator not the doer. Bias me toward delegating or dropping.

${kind === "weekly" ? `## GIVE ME — a WEEKLY plan that is EXACTLY THREE THINGS, so at one glance I know my main focus vs secondary vs chore. Keep it tight and phone-readable. NO long tables, NO 7-day grid, NO multi-tier goals dump — that overwhelms me and hides what matters.

Start with a 2-3 line HONEST CHECK of last week (what moved, what I avoided). Brief.

Then EXACTLY these three, clearly labelled, in this order:

## ① 🔵 MAIN FOCUS
The single heaviest, most important thing this week — it gets my PRIME energy. One line to name it, then break it into the few concrete little next-steps it decomposes into. Most of my week goes here.

## ② 🟢 SECONDARY FOCUS
Also decomposes into little tasks, but LOW energy — ~15-30 min/day, just show up and chip away (it may graduate to the main focus later). One line + its little steps.

## ③ 🟠 ONE CHORE
The SINGLE most pressing chore — urgent-ish but NOT important; annoying, often a one-off. Rules you MUST honor:
- DELEGATE it if at all possible (say to whom). Only do it myself if it truly can't be handed off.
- It must be PLANNED before any execution: how should it be done? who do I talk to first to surface blockers? Resolve those FIRST, then execute when the time is right. If it isn't planned/unblocked yet, the step is to plan/unblock it — not to grind on it.
- ONE chore max. Do NOT let chores eat the week. Suggest a 2nd chore ONLY if there's clear spare capacity after the main + secondary focus.

End with ONE sharp coherence line: am I putting my energy on the MAIN focus, or letting chores and comfortable busywork take over?

Reply in the language my entries are written in.` : `## GIVE ME — a short TODAY plan (phone-readable):
1. TOP 3 todos for today ranked, each tagged DO / DELEGATE (to whom) / PUSH-BACK or DROP / AUTOMATE.
2. TODAY's ONE must-do + 1-line why.
3. ON-TRACK & COHERENCE — one sharp coaching line.`}
Reply in the language my entries are written in.`;
}
function buildBlockersPrompt(data) {
  const g = data.global || {};
  const goals = (g.goals || []).map((x, i) => `  ${i + 1}. ${x}`).join("\n") || "  (none)";
  const active = (data.threads || []).filter(t => t.status === "active").sort((a, b) => b.lastActivityAt - a.lastActivityAt).slice(0, 24).map(t => `  - [${t.id}] "${t.title}" [${domLabel(data, t.domain)}]`).join("\n") || "  (none)";
  const frags = (data.fragments || []).slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, 18).map(f => `  - [${f.id}] ${String(f.body || "").replace(/\s+/g, " ").slice(0, 200)}`).join("\n") || "  (none)";
  const tasks = openTasksOrdered(data).slice(0, 15).map(t => `  - ${t.title}`).join("\n") || "  (none)";
  const prevRuns = (data.blockerRuns || []).slice(0, 5);
  const prev = prevRuns.length ? prevRuns.map(r => `  [${new Date(r.at).toISOString().slice(0, 10)}] ${(r.items || []).map(b => b.title).join(" · ")}`).join("\n") : "  (none yet)";
  return `You are my executive coach. Look across my whole system and name my BIGGEST blockers — the highest-impact, high-ROI areas worth my time to LEARN about and REFLECT on. Don't give a flat list of ten; find the few ROOTS that generate most of the downstream problems. Be honest, like a coach, not a cheerleader.

## MY LIFE GOALS
${goals}
## ACTIVE THREADS (id "title" [domain])
${active}
## RECENT RAW THINKING (fragments — id + snippet)
${frags}
## OPEN TASKS
${tasks}
## MY PAST BLOCKER ANALYSES (most recent first) — BUILD ON THESE, don't just repeat them:
${prev}

## RULES
- 4-5 blockers max, ranked by leverage/ROI (highest first).
- Prefer ROOT causes over symptoms; if several threads share one root, name the root.
- Weigh my PAST analyses: a blocker that keeps RECURRING and is still unresolved deserves higher urgency (say so); surface anything genuinely NEW since last time; and if something looks resolved or improving, don't just re-list it. Evolve the analysis — don't regurgitate the same list identically.
- For each, set "threadIds" and "fragmentIds" to the bracketed IDs above that evidence it (use ONLY IDs from the lists; omit if none truly fit).
- "why" = an honest 2-3 sentence case for why this is high-impact and worth learning about NOW.

## OUTPUT — STRICT JSON ONLY, no prose or fences:
{"blockers":[{"title":"short topic name","why":"...","roi":1-5,"threadIds":["..."],"fragmentIds":["..."]}]}`;
}
function buildLearnPrompt(data, social, topic) {
  const g = data.global || {};
  const goals = (g.goals || []).map((x, i) => `  ${i + 1}. ${x}`).join("\n") || "  (none)";
  const active = (data.threads || []).filter(t => t.status === "active").sort((a, b) => b.lastActivityAt - a.lastActivityAt).slice(0, 20).map(t => `  - [${t.id}] "${t.title}" [${domLabel(data, t.domain)}]`).join("\n") || "  (none)";
  const frags = (data.fragments || []).slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, 12).map(f => `  - ${String(f.body || "").replace(/\s+/g, " ").slice(0, 220)}`).join("\n") || "  (none)";
  const tasks = openTasksOrdered(data).slice(0, 15).map(t => `  - ${t.title}`).join("\n") || "  (none)";
  const refl = (data.reflections || []).slice().sort((a, b) => b.createdAt - a.createdAt)[0]; const reflTxt = refl ? String(refl.body).slice(0, 800) : "(none)";
  const seenT = []; (data.learnBatches || []).forEach(b => (b.items || []).forEach(i => seenT.push(i.title))); (data.learn || []).forEach(i => seenT.push(i.title));
  const seen = seenT.filter(Boolean).slice(0, 120).map(t => `  - ${t}`).join("\n") || "  (none yet)";
  return `You are my learning scout. From the REAL problems I'm wrestling with right now, suggest high-leverage learning material I should consume — then how I could turn what I learn into my own content (I run a small learning-out-loud channel; see my identity doc).
${topic ? `\n## FOCUS — all 4 suggestions must be about THIS specific area: "${topic}". Make them directly help me learn/act on it. Still tie each to my threads below.\n` : ""}
## MY LIFE GOALS
${goals}
## WHAT I'M ACTIVELY WRESTLING WITH (threads)
${active}
## MY RECENT RAW THINKING (fragments — weigh heavily, this is what's live for me)
${frags}
## OPEN TASKS
${tasks}
## MY LATEST REFLECTION
${reflTxt}
## MY CONTENT IDENTITY (for the 'angle' field)
${social || "(small learning-out-loud channel; first principles; clearer thinking; a few good minds over an audience)"}

## ALREADY SUGGESTED — DO NOT REPEAT ANY OF THESE (give fresh, different resources):
${seen}

## RULES
- LANGUAGE: give me a MIX of English AND Chinese-language resources — both Traditional (繁體) and Simplified (简体). Include creators from Chinese-speaking places (中國大陸 / 香港 / 台灣 / 馬來西亞 / etc.). I'm a bilingual Cantonese speaker — Chinese content is as valuable to me as English. Aim for roughly half Chinese, half English across the set.
- MEDIA DIVERSITY: do NOT default to books. Give a real spread — at least 2 YouTube videos/channels and at least 1 blog/article, alongside podcasts/books/talks. Choose the medium that best fits each idea.
- Suggest ONLY real, well-known resources you are confident actually exist (specific books, established podcasts/shows, known YouTube channels/videos, notable blogs/articles/talks). DO NOT fabricate URLs — the app builds reliable search links; just give a "find" search hint.
- Rank by IMPACT TO ME given what's live above — not generic popularity. Each must connect to something specific I'm dealing with.
- For each suggestion set "threadIds" to the bracketed IDs from the ACTIVE THREADS list above that it maps to (so I can jump straight to that thinking). Use ONLY IDs from that list; omit if none truly fit.
- Set "lang" to one of: "EN", "繁中", "简中".
- EXACTLY 4 suggestions — keep it tight and high-signal. Across the 4: at least 1 Chinese and 1 English, and mixed media (don't make all 4 books — include at least 1 YouTube or blog).
- NONE of the 4 may duplicate anything in the ALREADY SUGGESTED list above — pick genuinely new, different resources.

## OUTPUT — STRICT JSON ONLY, no prose, no markdown fences:
{"suggestions":[{"title":"","creator":"","type":"book|podcast|youtube|article|blog|talk","lang":"EN|繁中|简中","relevance":"which of MY threads/problems this speaks to, by name","takeaway":"the specific thing I'll get","impact":1-5,"find":"how to find it (search hint, not a URL)","angle":"how I could turn this + my own experience into a short TorGroFish video/post","threadIds":["id-from-list"]}]}`;
}
function runCoach(kind, cb) {
  let data; try { data = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); } catch (e) { return cb && cb(e); }
  const prompt = buildPlanPrompt(data, kind) + (kind === "weekly" ? "\n\n(WEEKLY plan — be reflective; check this week against last week's plan, then give EXACTLY the three things: main focus, secondary focus, one chore. Keep it tight.)" : "\n\n(quick check-in — keep it short and focused on TODAY.)");
  callAnthropic(prompt, 2000, (err, text) => {
    if (err) return cb && cb(err);
    try { data.plans = data.plans || []; data.plans.push({ id: "p_" + crypto.randomBytes(4).toString("hex"), createdAt: Date.now(), body: text, source: kind }); data.meta = data.meta || {}; data.meta.updatedAt = Date.now(); fs.writeFileSync(DATA_FILE, JSON.stringify(data)); } catch (e) {}
    const tlist = openTasksOrdered(data).map((t, i) => `${i + 1}. ${t.title}`).join("\n");
    const header = (kind === "weekly" ? "📅 Weekly review" : "☀️ Daily plan") + " — " + new Date().toLocaleDateString();
    tgSend(`${header}\n\n${text}${tlist ? `\n\n— Tasks (reply "done N" to check off) —\n${tlist}` : ""}`, cb);
  });
}
const BIN_PATH = "/opt/homebrew/bin:" + (process.env.PATH || "");  // so mlx_whisper finds ffmpeg

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(AUDIO_DIR, { recursive: true });
fs.mkdirSync(IMAGE_DIR, { recursive: true });

// token: load or create
let TOKEN;
try { TOKEN = fs.readFileSync(TOKEN_FILE, "utf8").trim(); }
catch (e) { TOKEN = crypto.randomBytes(24).toString("hex"); fs.writeFileSync(TOKEN_FILE, TOKEN, { mode: 0o600 }); }

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png" };

function eqToken(s) { try { return s.length === TOKEN.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(TOKEN)); } catch (e) { return false; } }
function authed(req) { const h = req.headers["authorization"] || ""; return eqToken(h.startsWith("Bearer ") ? h.slice(7) : ""); }
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
function appVersion() { try { const m = fs.readFileSync(path.join(APP_DIR, "sw.js"), "utf8").match(/loom-shell-v(\d+)/); return m ? m[1] : "0"; } catch (e) { return "0"; } }

const server = http.createServer((req, res) => {
  cors(res, req);
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  // strip optional /loom mount prefix (Tailscale --set-path) + query
  let urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  urlPath = urlPath.replace(/^\/loom(?=\/|$)/, "");
  if (urlPath === "") urlPath = "/";
  const qTok = decodeURIComponent(((/[?&]t=([^&]+)/.exec(req.url || "")) || [])[1] || "");
  const authedAny = () => authed(req) || eqToken(qTok);   // header OR ?t= (for <audio> playback)

  // ---- version probe (no auth; client POSTs so the service worker never intercepts it) ----
  if (urlPath === "/version") { return send(res, 200, JSON.stringify({ v: appVersion() }), TYPES[".json"]); }

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
  // ---- AI plan & coaching via Claude API ----
  if (urlPath === "/plan" && req.method === "POST") {
    if (!authed(req)) return send(res, 401, "unauthorized");
    let body = "";
    req.on("data", c => { body += c; if (body.length > 400 * 1024) req.destroy(); });
    req.on("end", () => {
      let prompt = "";
      try { prompt = JSON.parse(body || "{}").prompt || ""; } catch (e) {}
      if (!prompt) return send(res, 400, JSON.stringify({ error: "no prompt" }), TYPES[".json"]);
      callAnthropic(prompt, 2500, (err, text) => {
        if (err) { console.error("[loom] plan failed:", err.message); return send(res, 502, JSON.stringify({ error: err.message }), TYPES[".json"]); }
        send(res, 200, JSON.stringify({ plan: text }), TYPES[".json"]);
      });
    });
    return;
  }

  // ---- Lucid: blockers analysis — highest-impact areas to learn/reflect on ----
  if (urlPath === "/blockers" && req.method === "POST") {
    if (!authed(req)) return send(res, 401, "unauthorized");
    const data = readData();
    if (!data) return send(res, 500, JSON.stringify({ error: "no data on the Mini" }), TYPES[".json"]);
    callAnthropic(buildBlockersPrompt(data), 2000, (err, text) => {
      if (err) { console.error("[loom] blockers failed:", err.message); return send(res, 502, JSON.stringify({ error: err.message }), TYPES[".json"]); }
      let out; try { out = JSON.parse(String(text).replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim()); } catch (e) { out = { error: "parse", raw: text }; }
      send(res, 200, JSON.stringify(out), TYPES[".json"]);
    });
    return;
  }

  // ---- Lucid: personalized learning suggestions (optionally focused on a topic) ----
  if (urlPath === "/learn" && req.method === "POST") {
    if (!authed(req)) return send(res, 401, "unauthorized");
    let body = ""; req.on("data", c => { body += c; if (body.length > 64 * 1024) req.destroy(); });
    req.on("end", () => {
      let opts = {}; try { opts = JSON.parse(body || "{}"); } catch (e) {}
      const data = readData();
      if (!data) return send(res, 500, JSON.stringify({ error: "no data on the Mini" }), TYPES[".json"]);
      let social = ""; try { social = fs.readFileSync(path.join(APP_DIR, "SOCIAL_IDENTITY.md"), "utf8").slice(0, 2000); } catch (e) {}
      callAnthropic(buildLearnPrompt(data, social, opts.topic), 2200, (err, text) => {
        if (err) { console.error("[loom] learn failed:", err.message); return send(res, 502, JSON.stringify({ error: err.message }), TYPES[".json"]); }
        let out; try { out = JSON.parse(String(text).replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim()); } catch (e) { out = { error: "parse", raw: text }; }
        send(res, 200, JSON.stringify(out), TYPES[".json"]);
      });
    });
    return;
  }

  // ---- on-demand coach run (also used by the scheduler) ----
  if (urlPath === "/coach/run" && req.method === "POST") {
    if (!authed(req)) return send(res, 401, "unauthorized");
    const kind = /[?&]kind=weekly/.test(req.url || "") ? "weekly" : "daily";
    runCoach(kind, err => { if (err) { console.error("[loom] coach failed:", err.message); return send(res, 502, JSON.stringify({ error: err.message }), TYPES[".json"]); } send(res, 200, JSON.stringify({ ok: true, kind }), TYPES[".json"]); });
    return;
  }

  // ---- summarize note text with a small local LLM ----
  if (urlPath === "/summarize" && req.method === "POST") {
    if (!authed(req)) return send(res, 401, "unauthorized");
    let body = "";
    req.on("data", c => { body += c; if (body.length > 1024 * 1024) req.destroy(); });
    req.on("end", () => {
      let text = "";
      try { text = JSON.parse(body || "{}").text || ""; } catch (e) { text = body; }
      text = String(text).trim();
      if (!text) return send(res, 400, JSON.stringify({ error: "empty" }), TYPES[".json"]);
      const child = spawn(PY, [SUMMARIZE_PY], { env: Object.assign({}, process.env, { PATH: BIN_PATH }) });
      let out = "", er = "";
      child.stdout.on("data", d => { out += d; });
      child.stderr.on("data", d => { er += d; });
      child.on("error", () => send(res, 500, JSON.stringify({ error: "spawn" }), TYPES[".json"]));
      child.on("close", code => {
        if (code !== 0) { console.error("[loom] summarize failed:", er.slice(0, 400)); return send(res, 500, JSON.stringify({ error: "summarize" }), TYPES[".json"]); }
        send(res, 200, JSON.stringify({ summary: out.trim() }), TYPES[".json"]);
      });
      child.stdin.write(text); child.stdin.end();
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
  if (urlPath === "/audio/list" && req.method === "GET") {
    if (!authed(req)) return send(res, 401, "unauthorized");
    const out = [];
    try { for (const f of fs.readdirSync(AUDIO_DIR)) { const st = fs.statSync(path.join(AUDIO_DIR, f)); if (st.isFile()) out.push({ name: f, bytes: st.size, mtime: st.mtimeMs }); } } catch (_) {}
    out.sort((a, b) => b.mtime - a.mtime);
    return send(res, 200, JSON.stringify(out), TYPES[".json"]);
  }
  if (urlPath.startsWith("/audio/") && req.method === "GET") {   // stream one clip for playback
    if (!authedAny()) return send(res, 401, "unauthorized");
    const name = path.basename(urlPath.slice(7));
    const f = path.join(AUDIO_DIR, name);
    if (!f.startsWith(AUDIO_DIR + path.sep)) return send(res, 403, "no");
    return fs.readFile(f, (e, buf) => {
      if (e) return send(res, 404, "not found");
      const ct = { ".m4a": "audio/mp4", ".mp4": "audio/mp4", ".webm": "audio/webm", ".ogg": "audio/ogg", ".wav": "audio/wav" }[path.extname(f).toLowerCase()] || "application/octet-stream";
      send(res, 200, buf, ct);
    });
  }
  if (urlPath.startsWith("/image/") && req.method === "GET") {   // serve one image for in-app viewing (<img> uses ?t= token)
    if (!authedAny()) return send(res, 401, "unauthorized");
    const name = path.basename(urlPath.slice(7));
    const f = path.join(IMAGE_DIR, name);
    if (!f.startsWith(IMAGE_DIR + path.sep)) return send(res, 403, "no");
    return fs.readFile(f, (e, buf) => {
      if (e) return send(res, 404, "not found");
      const ct = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".heic": "image/heic" }[path.extname(f).toLowerCase()] || "application/octet-stream";
      res.setHeader("Cache-Control", "private, max-age=86400");
      send(res, 200, buf, ct);
    });
  }
  if (urlPath.startsWith("/audio/") && urlPath !== "/audio/stats" && req.method === "DELETE") {
    if (!authed(req)) return send(res, 401, "unauthorized");
    const name = path.basename(urlPath.slice(7));   // one file, no traversal
    const f = path.join(AUDIO_DIR, name);
    let ok = false;
    if (f.startsWith(AUDIO_DIR + path.sep)) { try { fs.unlinkSync(f); ok = true; } catch (_) {} }
    return send(res, 200, JSON.stringify({ deleted: ok ? 1 : 0 }), TYPES[".json"]);
  }
  if (urlPath === "/audio" && req.method === "DELETE") {
    if (!authed(req)) return send(res, 401, "unauthorized");
    let n = 0;
    try { for (const f of fs.readdirSync(AUDIO_DIR)) { fs.unlinkSync(path.join(AUDIO_DIR, f)); n++; } } catch (_) {}
    return send(res, 200, JSON.stringify({ deleted: n }), TYPES[".json"]);
  }

  // ---- temporary: condo decision calculator (served from DATA_DIR so the figures stay OUT of the public repo) ----
  if (urlPath === "/condo" && req.method === "GET") {
    fs.readFile(path.join(DATA_DIR, "condo-decision-cases.html"), (err, buf) => {
      if (err) return send(res, 404, "condo page not found");
      res.setHeader("Cache-Control", "no-cache");
      send(res, 200, buf, TYPES[".html"]);
    });
    return;
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
      const cfg = `<script>window.LOOM_SYNC=${JSON.stringify({ token: TOKEN, url: BASE + "/data", sw: BASE + "/sw.js", scope: BASE + "/", transcribe: BASE + "/transcribe", audio: BASE + "/audio", summarize: BASE + "/summarize", plan: anthKey() ? BASE + "/plan" : null, learn: anthKey() ? BASE + "/learn" : null, blockers: anthKey() ? BASE + "/blockers" : null, image: BASE + "/image", version: BASE + "/version", ver: appVersion() })};</script>`;
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

// ---- in-process scheduler (server is always-on via launchd) ----
const COACH_STATE = path.join(DATA_DIR, "coach_state.json");
function coachState() { try { return JSON.parse(fs.readFileSync(COACH_STATE, "utf8")); } catch (e) { return {}; } }
function saveCoachState(s) { try { fs.writeFileSync(COACH_STATE, JSON.stringify(s)); } catch (e) {} }
setInterval(() => {
  if (!tgToken() || !tgChat()) return;
  const now = new Date(), h = now.getHours(), m = now.getMinutes(), today = now.toISOString().slice(0, 10), st = coachState();
  // Automatic: WEEKLY only — the 3-bucket plan for the upcoming Sat-Fri week, pushed Friday 10:00 so he has the day to review & adjust before the week starts Saturday. Needs the Anthropic key.
  if (anthKey() && now.getDay() === 5 && h === 10 && m < 5 && st.lastWeekly !== today) { st.lastWeekly = today; saveCoachState(st); runCoach("weekly", () => {}); }
  // Automatic: per-task TELEGRAM REMINDERS. task.reminders = [{ id, days:[0-6 Sun=0], time:"HH:MM" local, until: ts|null }]
  try {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    const cur = h * 60 + m; st.remSent = st.remSent || {}; let changed = false; const fired = [];
    const midnight = d => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime(); };
    for (const task of (data.tasks || [])) {
      if (task.done || !Array.isArray(task.reminders)) continue;
      for (const r of task.reminders) {
        if (!r || !Array.isArray(r.days) || !r.days.includes(now.getDay())) continue;
        if (r.until && now.getTime() > r.until) continue;
        if (r.everyN > 1 && r.anchor) {                             // N-weekly (e.g. biweekly garbage): fire only on in-phase weeks measured from the anchor date; weekly reminders (no everyN) are unaffected
          const weeks = Math.round((midnight(now) - midnight(r.anchor)) / (7 * 86400000));
          if (((weeks % r.everyN) + r.everyN) % r.everyN !== 0) continue;
        }
        const p = String(r.time || "09:00").split(":"); const rmin = (+p[0]) * 60 + (+p[1] || 0);
        if (cur < rmin || cur > rmin + 180) continue;               // fire only within a 3h window after the scheduled time — never "catch up" hours late (e.g. a 09:00 reminder created at 8pm should wait for next morning, not blast at night)
        const key = task.id + ":" + (r.time || "") + ":" + (r.days || []).join("");  // stable across id churn
        if (st.remSent[key] === today) continue;                    // already sent today
        st.remSent[key] = today; changed = true;
        const pri = effPriSrv(task);
        const due = task.due ? " · " + new Date(task.due).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "";
        fired.push({ pri, text: (PRI_EMOJI[pri] || "🔔") + " " + task.title + due });
      }
    }
    if (fired.length) {                                             // one grouped, priority-sorted message — not a wall of bubbles
      fired.sort((a, b) => (PRI_RANK[a.pri] ?? 9) - (PRI_RANK[b.pri] ?? 9));
      const header = fired.length > 1 ? "🔔 " + fired.length + " reminders\n" : "";
      tgSend(header + fired.map(f => f.text).join("\n"));
    }
    for (const k in st.remSent) { if (st.remSent[k] !== today) { delete st.remSent[k]; changed = true; } } // prune stale dedup keys
    if (changed) saveCoachState(st);
  } catch (e) {}
}, 60000);

// ---- Telegram command polling (one consumer of getUpdates) ----
let tgOffset = 0;
setInterval(() => {
  if (!tgToken()) return;
  tgApi("getUpdates", { offset: tgOffset, timeout: 0 }, (err, res) => {
    if (err || !res || !res.ok) return;
    for (const u of res.result) {
      tgOffset = u.update_id + 1;
      const raw = u.message && u.message.text; if (!raw) continue;
      const t = raw.trim().toLowerCase();
      if (t === "tasks") { let data; try { data = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); } catch (e) { continue; } const list = openTasksOrdered(data).map((x, i) => `${i + 1}. ${x.title}`).join("\n") || "(no open tasks)"; tgSend("Your tasks:\n" + list); }
      else if (t === "plan") { tgSend("◆ generating your plan…"); runCoach("daily", () => {}); }
      else if (t === "weekly") { tgSend("📅 generating weekly review…"); runCoach("weekly", () => {}); }
      else if (t === "help" || t === "/start") { tgSend('Loom coach commands:\n"plan" — generate today\'s plan\n"weekly" — weekly review\n"tasks" — list open tasks\n"done N" — check off task N'); }
      else if (/^done\s+\d+$/.test(t)) {
        const n = parseInt(t.split(/\s+/)[1], 10);
        let data; try { data = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); } catch (e) { continue; }
        const task = openTasksOrdered(data)[n - 1];
        if (!task) { tgSend(`No task ${n}.`); }
        else { if (task.recurring && task.due) { task.due = rollDueServer(task.due, task.recurring); tgSend(`↻ "${task.title}" rolled to next ${task.recurring}.`); } else { task.done = true; task.doneAt = Date.now(); tgSend(`✅ Done: "${task.title}"`); } data.meta = data.meta || {}; data.meta.updatedAt = Date.now(); try { fs.writeFileSync(DATA_FILE, JSON.stringify(data)); } catch (e) {} }
      }
    }
  });
}, 8000);
