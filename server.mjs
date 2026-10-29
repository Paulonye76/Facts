import http from "node:http";
import fs from "node:fs";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

const PORT = process.env.PORT || 3000;
const PASSWORD = process.env.APP_PASSWORD;
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const PIXABAY = process.env.PIXABAY_API_KEY;
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT_ID;
const GROQ = process.env.GROQ_API_KEY;

if (!PASSWORD) {
  console.error("Set APP_PASSWORD");
  process.exit(1);
}

fs.mkdirSync("out", { recursive: true });
const jobs = new Map();
const fails = new Map();
let busy = false;

const sha = (s) => crypto.createHash("sha256").update(s).digest();
const sign = (v) => crypto.createHmac("sha256", SECRET).update(v).digest("hex");

function loggedIn(req) {
  const m = (req.headers.cookie || "").match(/(?:^|; )s=(\d+)\.([a-f0-9]+)/);
  return !!m && sign(m[1]) === m[2] && Date.now() - Number(m[1]) < 12 * 3600 * 1000;
}

function readBody(req) {
  return new Promise((ok, no) => {
    let b = "";
    req.on("data", (c) => {
      b += c;
      if (b.length > 200000) {
        no(new Error("too big"));
        req.destroy();
      }
    });
    req.on("end", () => ok(b));
  });
}

function send(res, code, data, type, extra) {
  res.writeHead(code, { "content-type": type || "text/html; charset=utf-8", ...(extra || {}) });
  res.end(data);
}

function run(cmd, args, tries) {
  return new Promise((ok, no) => {
    const go = (n) => {
      const p = spawn(cmd, args);
      let out = "";
      let err = "";
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", (d) => (err = (err + d).slice(-600)));
      p.on("error", (e) => no(e));
      p.on("close", (c) => {
        if (c === 0) ok(out);
        else if (n < (tries || 1)) setTimeout(() => go(n + 1), 3000 * n);
        else no(new Error(cmd + " failed: " + err));
      });
    };
    go(1);
  });
}

async function clip(term, dir, i) {
  if (!PIXABAY) return null;
  try {
    const r = await fetch(
      "https://pixabay.com/api/videos/?key=" + PIXABAY + "&per_page=5&safesearch=true&q=" + encodeURIComponent(term)
    );
    const h = ((await r.json()).hits || [])[0];
    if (!h) return null;
    const u = (h.videos.medium || h.videos.small || h.videos.large || {}).url;
    if (!u) return null;
    const f = dir + "/c" + i + ".mp4";
    fs.writeFileSync(f, Buffer.from(await (await fetch(u)).arrayBuffer()));
    return f;
  } catch (e) {
    return null;
  }
}

async function autoMeta(d) {
  if (!GROQ) return;
  try {
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + GROQ },
      body: JSON.stringify({
        model: process.env.GROQ_MODEL || "openai/gpt-oss-120b",
        messages: [
          {
            role: "user",
            content:
              "TikTok voiceover script:\n" + d.script +
              "\n\nReturn only JSON with keys: title (max 60 chars), caption (max 150 chars, no hashtags), hashtags (one string of 5 hashtags), keywords (3 short stock footage search phrases, comma separated).",
          },
        ],
        response_format: { type: "json_object" },
        max_completion_tokens: 2000,
        reasoning_effort: "low",
      }),
      signal: AbortSignal.timeout(60000),
    });
    const j = JSON.parse((await r.json()).choices[0].message.content);
    for (const k of ["title", "caption", "hashtags", "keywords"]) {
      if (!d[k] && j[k]) d[k] = String(j[k]);
    }
  } catch (e) {}
}

async function build(job, d) {
  const dir = "out/" + job.id;
  const L = (m) => job.log.push(m);
  fs.mkdirSync(dir, { recursive: true });

  if (!d.title || !d.keywords || !d.caption) {
    L("Writing title, caption and keywords...");
    await autoMeta(d);
  }

  L("Making voiceover...");
  fs.writeFileSync(dir + "/s.txt", d.script);
  await run("edge-tts", ["--voice", "en-US-GuyNeural", "--file", dir + "/s.txt", "--write-media", dir + "/v.mp3", "--write-subtitles", dir + "/v.vtt"], 4);
  const dur = parseFloat(
    (await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", dir + "/v.mp3"])).trim()
  );

  L("Getting footage...");
  const terms = (d.keywords || d.title || "calm").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 3);
  const clips = [];
  for (const t of terms) {
    const c = await clip(t, dir, clips.length);
    if (c) clips.push(c);
  }

  L("Building video...");
  const enc = ["-an", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28", "-pix_fmt", "yuv420p"];
  const list = [];
  if (!clips.length) {
    await run("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=c=0x14213d:s=720x1280:r=30", "-t", dur.toFixed(2), ...enc, dir + "/g0.mp4"]);
    list.push("file 'g0.mp4'");
  }
  const seg = dur / Math.max(clips.length, 1);
  for (let i = 0; i < clips.length; i++) {
    await run("ffmpeg", ["-y", "-stream_loop", "-1", "-i", clips[i], "-t", seg.toFixed(2), "-vf", "scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,fps=30,setsar=1", ...enc, dir + "/g" + i + ".mp4"]);
    list.push("file 'g" + i + ".mp4'");
  }
  fs.writeFileSync(dir + "/l.txt", list.join("\n") + "\n");
  await run("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", dir + "/l.txt", "-c", "copy", dir + "/b.mp4"]);

  L("Adding voice and captions...");
  const style = "FontName=DejaVu Sans,FontSize=14,Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2,Alignment=10";
  const out = "out/" + job.id + ".mp4";
  await run("ffmpeg", ["-y", "-i", dir + "/b.mp4", "-i", dir + "/v.mp3", "-vf", "subtitles=" + dir + "/v.vtt:force_style='" + style + "'", "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", out]);
  fs.rmSync(dir, { recursive: true, force: true });
  job.file = out;

  if (TG_TOKEN && TG_CHAT) {
    try {
      const f = new FormData();
      f.append("chat_id", TG_CHAT);
      f.append("caption", [d.title, d.caption, d.hashtags].filter(Boolean).join("\n\n").slice(0, 1000));
      f.append("video", new Blob([fs.readFileSync(out)]), "video.mp4");
      const r = await fetch("https://api.telegram.org/bot" + TG_TOKEN + "/sendVideo", { method: "POST", body: f });
      L(r.ok ? "Sent to Telegram." : "Telegram failed: " + r.status);
    } catch (e) {
      L("Telegram failed.");
    }
  }
}

function cleanup() {
  for (const f of fs.readdirSync("out")) {
    const p = "out/" + f;
    if (Date.now() - fs.statSync(p).mtimeMs > 24 * 3600 * 1000) fs.rmSync(p, { recursive: true, force: true });
  }
}

const page = (inner) =>
  '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Facts Studio</title>' +
  "<style>body{font-family:Arial,sans-serif;max-width:640px;margin:0 auto;padding:16px;line-height:1.5}input,textarea,button{width:100%;box-sizing:border-box;padding:10px;margin:4px 0 12px;font-size:16px}textarea{min-height:180px}pre{white-space:pre-wrap;background:#eee;padding:8px}</style>" +
  "</head><body>" + inner + "</body></html>";

const loginPage = (msg) =>
  page('<h1>Facts Studio</h1><p>' + msg + '</p><form method="post" action="/login"><label>Password</label><input type="password" name="password" autofocus><button type="submit">Log in</button></form>');

const appPage = page(
  '<h1>Facts Studio</h1>' +
  '<label>Upload a .txt script (or paste below)</label><input type="file" id="file" accept=".txt">' +
  '<label>Title (shown on screen)</label><input id="title">' +
  '<label>Script (what the voice reads)</label><textarea id="script"></textarea>' +
  '<label>Caption</label><input id="caption">' +
  '<label>Hashtags</label><input id="hashtags">' +
  '<label>Footage keywords (comma separated, up to 3)</label><input id="keywords">' +
  '<button id="go">Make video</button><pre id="log"></pre><div id="result"></div>' +
  '<form method="post" action="/logout"><button type="submit">Log out</button></form>' +
  "<script>" +
  "var $=function(i){return document.getElementById(i)};" +
  "$('file').onchange=function(e){var f=e.target.files[0];if(!f)return;var r=new FileReader();r.onload=function(){$('script').value=r.result};r.readAsText(f)};" +
  "$('go').onclick=function(){$('go').disabled=true;$('result').innerHTML='';$('log').textContent='Starting...';" +
  "fetch('/make',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:$('title').value,script:$('script').value,caption:$('caption').value,hashtags:$('hashtags').value,keywords:$('keywords').value})})" +
  ".then(function(r){return r.json()}).then(function(j){if(!j.id){$('log').textContent=j.error||'Error';$('go').disabled=false;return}poll(j.id)})" +
  ".catch(function(){$('log').textContent='Connection error';$('go').disabled=false})};" +
  "function poll(id){fetch('/job/'+id).then(function(r){return r.json()}).then(function(j){$('log').textContent=j.log.join('\\n');" +
  "if(j.status==='done'){$('result').innerHTML='<video src=\"/video/'+id+'\" controls style=\"width:100%\"></video><p><a href=\"/video/'+id+'\" download>Download video</a></p>';$('go').disabled=false}" +
  "else if(j.status==='error'){$('log').textContent+='\\nFailed: '+j.error;$('go').disabled=false}" +
  "else setTimeout(function(){poll(id)},3000)}).catch(function(){setTimeout(function(){poll(id)},5000)})}" +
  "</script>"
);

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress);
    try {
      if (req.method === "POST" && url.pathname === "/login") {
        const f = (fails.get(ip) || []).filter((t) => Date.now() - t < 600000);
        if (f.length >= 5) return send(res, 429, loginPage("Too many tries. Wait 10 minutes."));
        const pw = new URLSearchParams(await readBody(req)).get("password") || "";
        if (crypto.timingSafeEqual(sha(pw), sha(PASSWORD))) {
          const t = String(Date.now());
          return send(res, 302, "", "text/plain", {
            "set-cookie": "s=" + t + "." + sign(t) + "; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=43200",
            location: "/",
          });
        }
        f.push(Date.now());
        fails.set(ip, f);
        return send(res, 401, loginPage("Wrong password."));
      }

      if (!loggedIn(req)) {
        if (url.pathname === "/") return send(res, 200, loginPage(""));
        return send(res, 401, JSON.stringify({ error: "Please log in" }), "application/json");
      }

      if (req.method === "POST" && url.pathname === "/logout") {
        return send(res, 302, "", "text/plain", { "set-cookie": "s=; Max-Age=0; Path=/", location: "/" });
      }
      if (req.method === "GET" && url.pathname === "/") return send(res, 200, appPage);

      if (req.method === "POST" && url.pathname === "/make") {
        const d = JSON.parse((await readBody(req)) || "{}");
        const script = String(d.script || "").trim();
        if (script.length < 20 || script.length > 3000)
          return send(res, 400, JSON.stringify({ error: "Script must be 20 to 3000 characters." }), "application/json");
        if (busy) return send(res, 429, JSON.stringify({ error: "A video is already being made. Wait for it to finish." }), "application/json");
        busy = true;
        cleanup();
        const id = crypto.randomBytes(8).toString("hex");
        const job = { id, status: "running", log: ["Started."], file: null };
        jobs.set(id, job);
        build(job, {
          title: String(d.title || "").slice(0, 100),
          script,
          caption: String(d.caption || "").slice(0, 300),
          hashtags: String(d.hashtags || "").slice(0, 200),
          keywords: String(d.keywords || "").slice(0, 100),
        })
          .then(() => (job.status = "done"))
          .catch((e) => {
            job.status = "error";
            job.error = e.message;
          })
          .finally(() => (busy = false));
        return send(res, 200, JSON.stringify({ id }), "application/json");
      }

      const m = url.pathname.match(/^\/(job|video)\/([a-f0-9]+)$/);
      if (m && jobs.has(m[2])) {
        const job = jobs.get(m[2]);
        if (m[1] === "job")
          return send(res, 200, JSON.stringify({ status: job.status, log: job.log, error: job.error }), "application/json");
        if (job.file && fs.existsSync(job.file)) {
          res.writeHead(200, { "content-type": "video/mp4", "content-disposition": 'inline; filename="facts.mp4"' });
          return fs.createReadStream(job.file).pipe(res);
        }
      }
      send(res, 404, "Not found", "text/plain");
    } catch (e) {
      send(res, 500, JSON.stringify({ error: "Server error" }), "application/json");
    }
  })
  .listen(PORT, () => console.log("Facts Studio on port " + PORT));
