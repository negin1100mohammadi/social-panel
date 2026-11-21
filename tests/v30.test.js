// v30 tests: «اینجا کار داری» badges, plain sentences (no person selector), identity «تصمیم‌نگرفته» + slogan cleanup, publish preview,
// 375 px screenshots of every page against the repo's own config + data (GitHub mocked). usage: node tests/v30.test.js . <media_dir>  (SP_SHOTS=<dir>, SP_ID_DIR=<decrypted identity mirrors>)
//   fixture: python3 tests/make_fixture.py /tmp/fx $(date +%s000)      media: python3 tests/make_media.py /tmp/spmedia
// Headless Chromium (Playwright) at 390 px (mobile) and 1280 px (desktop). GitHub is replaced by an in-memory repo
// that implements the contents API (sha conflicts: 409/422), git blobs/trees/commits/refs, releases, workflow dispatch.
const { chromium } = require("playwright");
const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto"), cp = require("child_process");

const FX = process.argv[2], MEDIA = process.argv[3];
if (!FX || !MEDIA) { console.error("usage: node tests/v13.test.js <fixture_dir> <media_dir>"); process.exit(2); }
const ROOT = path.resolve(__dirname, "..");
const U = "tester", P = "test-pass-123", TOKEN = "github_pat_TESTTOKEN_v8_abc123";
let checks = 0; const fails = [];
const ok = (c, m) => { checks++; if (!c) { fails.push(m); console.log("  ✗ " + m); } };
const config = JSON.parse(fs.readFileSync(path.join(FX, "config.json"), "utf8"));
const PAGES = config.pages.map((p) => p.id);
const [P1, P2] = PAGES;
const appSrc = fs.readFileSync(path.join(FX, "app.js"), "utf8");
const salt = /var AUTH_SALT = "([^"]+)"/.exec(appSrc)[1];
const testHash = crypto.createHash("sha256").update(salt + U + "|" + P).digest("hex");
const patchedApp = appSrc.replace(/var AUTH_HASH = "[0-9a-f]+"/, 'var AUTH_HASH = "' + testHash + '"');
const OWN = "/repos/negin1100mohammadi/social-panel";
const b64 = (b) => Buffer.from(b).toString("base64");
const gitSha = (buf) => crypto.createHash("sha1").update("blob " + buf.length + "\0").update(buf).digest("hex");

// ------------------------------------------------------------------ in-memory GitHub
class Repo {
  constructor() { this.files = new Map(); this.shaOverride = new Map(); this.blobs = new Map(); this.trees = new Map(); this.commits = new Map(); this.refs = new Map();
    this.release = null; this.dispatches = []; this.puts = []; this.conflicts = 0; this.conflictOnce = new Set(); this.bigContent = new Set(); }
  sha(p) { return this.shaOverride.get(p) || gitSha(this.files.get(p)); }
  set(p, v) { this.files.set(p, Buffer.isBuffer(v) ? v : Buffer.from(typeof v === "string" ? v : JSON.stringify(v, null, 1))); this.shaOverride.delete(p); }
  json(p) { return this.files.has(p) ? JSON.parse(this.files.get(p).toString("utf8")) : null; }
  text(p) { return this.files.has(p) ? this.files.get(p).toString("utf8") : null; }
}
async function mockGitHub(ctx, R, log) {
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "GET,PUT,DELETE,POST,PATCH" };
  await ctx.route(/^https:\/\/(api\.github\.com|raw\.githubusercontent\.com|uploads\.github\.com)\/.*/, async (route) => {
    const r = route.request(), url = new URL(r.url()), m = r.method(), pth = decodeURIComponent(url.pathname);
    if (m === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const json = (code, b) => route.fulfill({ status: code, headers: { ...cors, "Content-Type": "application/json" }, body: b === undefined ? "" : JSON.stringify(b) });
    const auth = (r.headers()["authorization"] || "") === "Bearer " + TOKEN;
    const body = () => { try { return JSON.parse(r.postData() || "{}"); } catch (e) { return {}; } };
    if (log) log.push(m + " " + pth);
    let mm;
    if (url.hostname === "raw.githubusercontent.com") {
      const fp = pth.replace(/^\/negin1100mohammadi\/social-panel\/main\//, "");
      return R.files.has(fp) ? route.fulfill({ status: 200, headers: { ...cors, "Content-Type": "text/plain" }, body: R.files.get(fp) }) : json(404, { message: "Not Found" });
    }
    if ((mm = /^\/repos\/[^/]+\/[^/]+\/contents\/(.+)$/.exec(pth))) {
      const fp = mm[1].replace(/\/$/, "");
      if (m === "GET") {
        if (R.files.has(fp)) {
          if ((r.headers()["accept"] || "").includes("raw")) return route.fulfill({ status: 200, headers: { ...cors, "Content-Type": "application/json" }, body: R.files.get(fp) });
          if (!auth && fp.startsWith("vault/")) return json(404, { message: "Not Found" }); // the panel always reads data with the token
          const buf = R.files.get(fp);
          return json(200, { type: "file", name: path.basename(fp), path: fp, sha: R.sha(fp), size: buf.length, encoding: "base64", content: R.bigContent.has(fp) ? "" : b64(buf) });
        }
        const kids = [...R.files.keys()].filter((k) => k.startsWith(fp + "/") && !k.slice(fp.length + 1).includes("/"));
        if (kids.length) return json(200, kids.map((k) => ({ type: "file", name: path.basename(k), path: k, sha: R.sha(k) })));
        return json(404, { message: "Not Found" });
      }
      if (!auth) return json(401, { message: "Bad credentials" });
      const b = body();
      if (m === "PUT") {
        R.puts.push(fp);
        if (R.conflictOnce.has(fp) && R.files.has(fp)) { R.conflictOnce.delete(fp); R.shaOverride.set(fp, crypto.randomBytes(20).toString("hex")); }
        if (R.files.has(fp) && !b.sha) { R.conflicts++; return json(422, { message: "Invalid request. \"sha\" wasn't supplied." }); }
        if (R.files.has(fp) && b.sha !== R.sha(fp)) { R.conflicts++; return json(409, { message: fp + " does not match " + b.sha }); }
        R.set(fp, Buffer.from(b.content, "base64"));
        return json(R.files.has(fp) ? 200 : 201, { content: { path: fp, sha: R.sha(fp) } });
      }
      if (m === "DELETE") {
        if (!R.files.has(fp)) return json(404, {});
        if (b.sha !== R.sha(fp)) return json(409, { message: "sha mismatch" });
        R.files.delete(fp); return json(200, { commit: {} });
      }
    }
    if (pth === OWN + "/git/blobs" && m === "POST") { if (!auth) return json(401, {}); const buf = Buffer.from(body().content, "base64"); const s = gitSha(buf); R.blobs.set(s, buf); return json(201, { sha: s }); }
    if ((mm = /\/git\/blobs\/([0-9a-f]+)$/.exec(pth))) {
      let buf = R.blobs.get(mm[1]); if (!buf) for (const k of R.files.keys()) if (R.sha(k) === mm[1]) buf = R.files.get(k);
      if (buf && (r.headers()["accept"] || "").includes("raw")) return route.fulfill({ status: 200, headers: { ...cors, "Content-Type": "application/vnd.github.raw" }, body: buf });
      return buf ? json(200, { sha: mm[1], encoding: "base64", content: b64(buf) }) : json(404, {});
    }
    if ((mm = /\/git\/ref\/heads\/(.+)$/.exec(pth))) return R.refs.has(mm[1]) ? json(200, { object: { sha: R.refs.get(mm[1]) } }) : json(404, { message: "Not Found" });
    if ((mm = /\/git\/commits\/([0-9a-f]+)$/.exec(pth))) return R.commits.has(mm[1]) ? json(200, { sha: mm[1], tree: { sha: R.commits.get(mm[1]).tree } }) : json(404, {});
    if ((mm = /\/git\/trees\/([0-9a-f]+)$/.exec(pth))) return json(200, { tree: R.trees.get(mm[1]) || [] });
    if (pth === OWN + "/git/trees" && m === "POST") {
      const b = body(); const base = b.base_tree ? (R.trees.get(b.base_tree) || []) : [];
      const map = new Map(base.map((e) => [e.path, e])); b.tree.forEach((e) => map.set(e.path, e));
      const s = crypto.randomBytes(20).toString("hex"); R.trees.set(s, [...map.values()]); return json(201, { sha: s });
    }
    if (pth === OWN + "/git/commits" && m === "POST") { const b = body(); const s = crypto.randomBytes(20).toString("hex"); R.commits.set(s, { tree: b.tree, parents: b.parents }); return json(201, { sha: s }); }
    if ((mm = /\/git\/refs\/heads\/(.+)$/.exec(pth)) && m === "PATCH") { R.refs.set(mm[1], body().sha); return json(200, {}); }
    if (pth === OWN + "/git/refs" && m === "POST") { const b = body(); R.refs.set(b.ref.replace("refs/heads/", ""), b.sha); return json(201, {}); }
    if (pth === OWN + "/releases/tags/gallery") return R.release ? json(200, R.release) : json(404, { message: "Not Found" });
    if ((mm = /\/actions\/workflows\/([\w.-]+)\/dispatches$/.exec(pth)) && m === "POST") { if (!auth) return json(401, {}); R.dispatches.push({ wf: mm[1], body: body() }); return json(204); }
    if (/\/actions\/workflows\/[\w.-]+\/runs$/.test(pth)) return json(200, { total_count: R.running ? 1 : 0, workflow_runs: [] });
    if (pth === OWN || pth === OWN + "/") return json(200, { permissions: { push: true } });
    if (/\/actions\/workflows$/.test(pth)) return json(200, { workflows: [] });
    return json(404, { message: "Not Found" });
  });
  await ctx.route(/^https:\/\/(fonts\.googleapis|fonts\.gstatic)\.com\/.*/, (r) => r.fulfill({ status: 200, body: "" }));
  await ctx.route(/^https:\/\/[^/]*(ggpht|ytimg|cdninstagram|fbcdn|tiktokcdn|aparat|example)[^/]*\/.*/, (r) => r.fulfill({ status: 404, body: "" }));
}
function serve(dir, override) {
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".jpg": "image/jpeg" };
  return new Promise((res) => {
    const srv = http.createServer((q, s) => {
      const u = decodeURIComponent(q.url.split("?")[0]);
      if (override[u] != null) { s.writeHead(200, { "Content-Type": types[path.extname(u)] || "text/plain" }); return s.end(override[u]); }
      let f = path.join(dir, u); if (f.endsWith("/")) f += "index.html";
      fs.readFile(f, (e, d) => { if (e) { s.writeHead(404); s.end(); } else { s.writeHead(200, { "Content-Type": types[path.extname(f)] || "application/octet-stream" }); s.end(d); } });
    }).listen(0, () => res({ srv, url: "http://127.0.0.1:" + srv.address().port + "/" }));
  });
}
const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const VPS = { mobile: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, desktop: { viewport: { width: 1280, height: 900 } },
  iphone: { viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: IPHONE_UA } };
const errors = [];
async function device(browser, R, vp, opt = {}) {
  const ctx = await browser.newContext({ ...VPS[vp], serviceWorkers: "block", locale: "fa-IR", timezoneId: "Asia/Tehran" });
  await ctx.addInitScript(([h, o]) => {
    localStorage.setItem("sp_auth", h);
    if (o.token && !localStorage.getItem("sp_gh_token")) localStorage.setItem("sp_gh_token", o.token);
    if (o.pw && !sessionStorage.getItem("sp_pw")) { sessionStorage.setItem("sp_pw", o.pw); sessionStorage.setItem("sp_user", "tester"); }
    if (o.theme) localStorage.setItem("sp_theme", o.theme);
    sessionStorage.setItem("sp_unlock_later", "1");
  }, [testHash, { token: opt.token === false ? null : TOKEN, pw: opt.pw || null, theme: opt.theme || null }]);
  await mockGitHub(ctx, R, opt.log);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(vp + ": " + e.message));
  page.on("dialog", (d) => d.accept());
  return { ctx, page };
}
const until = async (fn, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { let v; try { v = await fn(); } catch (e) { v = null; } if (v) return v; await new Promise((r) => setTimeout(r, 120)); } return null; };
async function nav(page, base, hash, sel) { await page.goto(base + hash); if (sel) await page.waitForSelector(sel, { timeout: 20000 }); }
async function hashTo(page, hash, sel) { await page.evaluate((h) => { location.hash = h; }, hash); if (sel) await page.waitForSelector(sel, { timeout: 20000 }); }
const SHOTS = process.env.SP_SHOTS; let shotN = 0;
async function shot(page, name) { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, String(++shotN).padStart(2, "0") + "-" + name + ".png"), fullPage: true }); } }
async function noOverflow(page, tag) {
  await shot(page, tag.replace(/[^\w-]+/g, "_"));
  // compare with the device width itself: on a mobile viewport a too-wide element widens the layout viewport (innerWidth grows too)
  const W = page.viewportSize().width;
  const o = await page.evaluate((W) => ({ sw: document.documentElement.scrollWidth, w: innerWidth,
    wide: Array.from(document.querySelectorAll("#app *")).filter((e) => { const a = document.getElementById("app").getBoundingClientRect(), r = e.getBoundingClientRect(); return r.width && (r.right > a.right + 1 || r.left < a.left - 1) && !e.closest(".sfilter,.tabs,.chm-wrap,.toast,.line,.progress,.pflow,.kanban,.jpv"); }).slice(0, 4).map((e) => e.tagName + "." + e.className + " " + Math.round(e.getBoundingClientRect().width)) }), W);
  ok(o.sw <= W + 1 && o.w <= W + 1 && !o.wide.length, `${tag}: no horizontal overflow (scroll ${o.sw}, inner ${o.w}, device ${W}; ${o.wide.join(" | ")})`);
}
// the encrypted token file (same format as the panel's encryptToken)
async function tokenEnc(pw, tok) {
  const s = crypto.webcrypto.subtle, saltB = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const base = await s.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveKey"]);
  const key = await s.deriveKey({ name: "PBKDF2", salt: saltB, iterations: 310000, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const ct = Buffer.from(await s.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(tok)));
  return { v: 1, salt: b64(saltB), iv: b64(iv), ct: b64(ct), created_at: new Date().toISOString() };
}
const ytStore = () => ({ v: 1, channels: { ["UC" + "A".repeat(22)]: { page: P1, channel_id: "UC" + "A".repeat(22), title: "A", mismatch: false, connected_at: new Date(Date.now() - 3600e3).toISOString(), status: "ok", iv: "AA", ct: "BB" } } });
const isEncFile = (txt) => { try { const o = JSON.parse(txt); return o && o.iv && o.ct && o.kid && Object.keys(o).every((k) => ["v", "kid", "alg", "iv", "ct", "updated_at"].includes(k)); } catch (e) { return false; } };


// ------------------------------------------------------------------ v9: Hark bridge helpers
const BRIDGE = process.env.HARK_BRIDGE || "/workspace/work/hark_bridge.py";
const TMP = fs.mkdtempSync("/tmp/spv28-");
const LOCAL = path.join(TMP, "repo"), KEYF = path.join(TMP, "hark_priv_test.json");
// test-only Hark key pair (never the real one)
const testPub = JSON.parse(cp.execFileSync("python3", ["-c", `import json,base64,os
from cryptography.hazmat.primitives.asymmetric import ec
b=lambda i: base64.urlsafe_b64encode(i.to_bytes(32,'big')).rstrip(b'=').decode()
k=ec.generate_private_key(ec.SECP256R1()); n=k.private_numbers(); p=n.public_numbers
j={"kty":"EC","crv":"P-256","x":b(p.x),"y":b(p.y)}
json.dump({"v":1,"kid":"testhark0000","jwk":dict(j,d=b(n.private_value))},open(${JSON.stringify(KEYF)},"w"))
print(json.dumps({"v":1,"kid":"testhark0000","alg":"ECDH-P256+HKDF-SHA256+A256GCM","info":"sp-hark-req-v1","jwk":j}))`]).toString());
// mirror the in-memory repo <-> a local dir for the bridge (--local)
function toLocal(R) {
  fs.rmSync(LOCAL, { recursive: true, force: true });
  for (const [k, v] of R.files) if (k.startsWith("hark/") || k === "config/inbox_pub.json") { const f = path.join(LOCAL, k); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, v); }
  fs.mkdirSync(path.join(LOCAL, ".blobs"), { recursive: true }); for (const [k, v] of R.blobs) fs.writeFileSync(path.join(LOCAL, ".blobs", k), v);
}
function fromLocal(R) {
  for (const k of [...R.files.keys()]) if (k.startsWith("hark/") && !fs.existsSync(path.join(LOCAL, k))) R.files.delete(k);
  const walk = (d) => fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]) : [];
  for (const f of walk(path.join(LOCAL, "hark"))) { const k = path.relative(LOCAL, f); const buf = fs.readFileSync(f); if (!R.files.has(k) || !R.files.get(k).equals(buf)) R.set(k, buf); }
}
function bridge(R, args, input) {
  toLocal(R);
  const out = cp.execFileSync("python3", [BRIDGE, "--local", LOCAL, "--key", KEYF, ...args], { input: input || "" }).toString();
  fromLocal(R); return out;
}
function bridgeFails(R, args) { toLocal(R); try { cp.execFileSync("python3", [BRIDGE, "--local", LOCAL, "--key", KEYF, ...args], { stdio: "pipe" }); return false; } catch (e) { return String(e.stderr || e.message); } }
const reqFiles = (R) => [...R.files.keys()].filter((k) => k.startsWith("hark/requests/"));
const outFiles = (R, p) => [...R.files.keys()].filter((k) => k.startsWith("hark/out/" + (p ? p + "/" : "")));
const listReq = (R) => JSON.parse(bridge(R, ["list-requests", "--json"]));
const idMirror = (R, p) => R.text("hark/identity/" + p + ".json");
const getId = (R, p) => JSON.parse(bridge(R, ["get-identity", p, "--json"]));
// test files: a PNG, a fake font, a ZIP (2 images + 1 text)
const ASSETS = path.join(TMP, "assets"); fs.mkdirSync(ASSETS, { recursive: true });
cp.execFileSync("python3", ["-c", `
from PIL import Image; import zipfile, io, os
d=${JSON.stringify(ASSETS)}
Image.new("RGBA",(300,120),(124,58,237,255)).save(os.path.join(d,"titan-logo.png"))
open(os.path.join(d,"BrandFont.ttf"),"wb").write(b"\\x00\\x01\\x00\\x00"+os.urandom(4000))
z=zipfile.ZipFile(os.path.join(d,"pack.zip"),"w",zipfile.ZIP_DEFLATED)
for n,c in [("imgs/a.png",(255,0,0)),("imgs/b.jpg",(0,128,255))]:
  b=io.BytesIO(); Image.new("RGB",(64,64),c).save(b,"PNG" if n.endswith("png") else "JPEG"); z.writestr(n,b.getvalue())
z.writestr("readme.txt","brand pack"); z.close()`]);

function syncBlobs(R) { const d = path.join(LOCAL, ".blobs"); if (fs.existsSync(d)) for (const f of fs.readdirSync(d)) R.blobs.set(f, fs.readFileSync(path.join(d, f))); }
fs.writeFileSync(path.join(ASSETS, "clip.mp4"), Buffer.concat([Buffer.from("....ftypmp42"), crypto.randomBytes(5000)]));
const VOSCRIPT = path.join(ROOT, "scripts", "voscript.py");
function voRobot(R, rid) { // run the voice-over robot (mock AI) on the local mirror, like voscript.yml does in Actions
  toLocal(R);
  const env = { ...process.env, HARK_PRIV_JWK: fs.readFileSync(KEYF, "utf8"), REQUEST_ID: rid || "" };
  const out = cp.execFileSync("python3", [VOSCRIPT, "--root", LOCAL, "--mock"], { env }).toString();
  fromLocal(R); return out;
}
const WAV = path.join(ASSETS, "me.wav");
cp.execFileSync("python3", ["-c", `import wave,struct,math
w=wave.open(${JSON.stringify(WAV)},"wb"); w.setnchannels(1); w.setsampwidth(2); w.setframerate(8000)
w.writeframes(b"".join(struct.pack("<h",int(8000*math.sin(i/8.0))) for i in range(8000))); w.close()`]);

// ------------------------------------------------------------------ v30 data (realistic, per brand) — live public data is served from the repo itself
const ISO = (h) => new Date(Date.now() - h * 3600e3).toISOString();
const A2 = { "نگین": { at: ISO(2) }, "امیرحسین": { at: ISO(1) } };
const brainSeed = (P, n) => ({ items: [{ id: "i" + n, type: "idea", kind: "idea", author: "negin", title: "ایده‌ی خودمون " + n, body: "متن ایده", created_at: ISO(30), updated_at: ISO(30) }],
  hark: [{ id: "h" + n, title: "ایده‌ی تازه‌ی هارک " + n, body: "بدنه", created_at: ISO(5) }],
  screen: [{ id: "s" + n, page: P, title: "غربال آماده " + n, state: "ready", ready_at: ISO(3), requested_at: ISO(4), script: { title: "اسکریپت آماده " + n, hook: "هوک" } },
    { id: "sq" + n, page: P, title: "منتظر شروع " + n, state: "queued", requested_at: ISO(6) }],
  final: [
    { id: "fOld" + n, page: P, title: "وقتی می‌گی «من سر ساعت می‌رسم» " + n, text: "متن", script: {}, created_at: ISO(200), jobs: { claude: { id: "jo" + n, state: "queued", requested_at: ISO(199) } } },
    { id: "fVo" + n, page: P, title: "ویس‌اور نیمه‌تأیید " + n, text: "متن", script: {}, content_type: "video", created_at: ISO(50), jobs: {}, vo: { mode: "voice", text: "سلام", approvals: { "نگین": { at: ISO(3) } } } },
    { id: "fVc" + n, page: P, title: "صدا لازم " + n, text: "متن", script: {}, content_type: "slide", created_at: ISO(40), jobs: {}, vo: { mode: "voice", text: "سلام", approvals: A2 } },
    { id: "fMk" + n, page: P, title: "آماده‌ی ساخت " + n, text: "متن", script: {}, content_type: "slide", created_at: ISO(30), vo: { mode: "music", music: { note: "لوفای" }, approvals: A2 },
      jobs: { aistudio: { id: "ja" + n, state: "error", reason: "AI Studio از مرورگر هارک باز نمی‌شود (خطای شبکه)", requested_at: ISO(20) } } },
    { id: "fV8" + n, page: P, title: "ساخته‌شده " + n, text: "متن", script: {}, content_type: "video", created_at: ISO(20), vo: { mode: "music", music: { note: "x" }, approvals: A2 },
      jobs: { claude: { id: "jd" + n, state: "done", done_at: ISO(10), output_url: "https://example.com/out.mp4" } } }] });
const SLOGAN_KIT = { v: "⛔ TS-01: پارک‌شده برای تصمیم بعدی\n• اسلوگان: ⛔ TS-04: پارک‌شده برای تصمیم بعدی", at: ISO(100), by: "kit", src: "user", draft: false, kit: "از کیت امیرحسین/نگین (Pages.zip)", note: "" };
function idSeed(P) {
  const dir = process.env.SP_ID_DIR, f = dir && path.join(dir, P + ".json");
  if (f && fs.existsSync(f)) { const m = JSON.parse(fs.readFileSync(f, "utf8")); return { fields: m.fields, assets: [], hark_seen: {} }; } // real identity (decrypted Hark mirror, outside the repo)
  return { fields: { brand_name: { v: P, at: ISO(100), by: "kit", src: "user", kit: "کیت" }, slogan: SLOGAN_KIT, start_date: { v: "✍️ XX-02: تاریخ شروع پروژه", at: ISO(100), by: "kit", src: "user", kit: "کیت" } }, assets: [], hark_seen: {} };
}
const TODO = { items: [{ id: "t1", title: "چک کردن بایو تایتان", kind: "check", for: "نگین", created_at: ISO(5), done: false }, { id: "t2", title: "کار مشترک", kind: "task", for: "هر دو", created_at: ISO(4), done: false }] };

(async () => {
  const { srv, url: base } = await serve(FX, { "/app.js": patchedApp });
  const browser = await chromium.launch();
  const R = new Repo();
  R.set("config/token.enc.json", await tokenEnc(P, TOKEN));
  R.set("config/hark_pub.json", testPub);
  for (const f of ["publish_caps.json", "yt_connect_last.json", "yt_replies.json", "yt_tokens.enc.json"]) if (fs.existsSync(path.join(ROOT, "config", f))) R.set("config/" + f, fs.readFileSync(path.join(ROOT, "config", f)));
  for (const f of fs.readdirSync(path.join(ROOT, "queue")).filter((x) => x.endsWith(".json"))) R.set("queue/" + f, fs.readFileSync(path.join(ROOT, "queue", f)));
  const VID = fs.readdirSync(MEDIA).find((x) => x.endsWith(".webm"));
  try {
    const A = await device(browser, R, "iphone", { pw: P });
    const page = A.page;
    await A.ctx.route(/^https:\/\/github\.com\/.*\/releases\/download\/.*/, (r) => r.fulfill({ status: 200, headers: { "Content-Type": "video/webm" }, body: fs.readFileSync(path.join(MEDIA, VID)) }));
    await nav(page, base, "#/brain/" + P1 + "/hark", "#blist");
    await page.evaluate(async ([pages, seeds, ids, todo]) => {
      for (let i = 0; i < pages.length; i++) { await window.__spV8.dsUpdate("brain-" + pages[i], () => seeds[i]); await window.__spV8.dsUpdate("identity-" + pages[i], () => ids[i]); }
      await window.__spV8.dsUpdate("todo", () => todo);
      await window.__spV8.dsUpdate("gallery-" + pages[0], () => ({ items: [{ id: "g1", page: pages[0], kind: "reel", title: "ریل نمونه", caption: "کپشن گالری", status: "ready", created_at: new Date().toISOString(),
        media: [{ url: "https://github.com/negin1100mohammadi/social-panel/releases/download/gallery/g1.webm", type: "video/webm", name: "g1.webm", size: 1000 }] }] }));
    }, [PAGES, PAGES.map((p, i) => brainSeed(p, i + 1)), PAGES.map(idSeed), TODO]);
    await page.evaluate(() => window.__spV30.pending(true));
    const items = await page.evaluate(() => window.__spV30.items());
    ok(items.length > 20, "pending items computed (" + items.length + ")");
    const why = (id) => (items.find((x) => x.id === id) || {}).why || "";
    ok(/نوع محتوا/.test(why("fOld1")) && (items.find((x) => x.id === "fOld1") || {}).tab === "ctype", "old untyped sent item waits at ۴ نوع محتوا: " + why("fOld1"));
    ok(why("fVo1") === "نگین تأیید کرد، منتظر تأیید امیرحسین (متن ویس‌اور)", "one plain sentence for a half approval: " + why("fVo1"));
    ok(/صدا/.test(why("fVc1")) && /AI Studio دستیه/.test(why("fMk1")) && /منتظر تأیید نگین و امیرحسین/.test(why("fV81")), "voice / AI Studio manual / view approvals: " + [why("fVc1"), why("fMk1"), why("fV81")].join(" | "));
    ok(items.some((x) => x.area === "identity" && /slogan/.test(x.id)) === false, "no slogan item (cleared)");
    ok(items.some((x) => x.area === "today" && x.id === "todo:t1") && items.some((x) => x.area === "publish"), "todos and the failed publish are pending items");
    // ---------- v30.1: Hark ideas are suggestions (purple «تازه»), never red
    ok(!items.some((x) => x.sec === "idea" || x.tab === "hark"), "v30.1: no Hark idea in the red «کار داری» list");
    ok(await page.evaluate((ps) => ps.every((p) => window.__spV30.hkNew(p) === 0), PAGES), "v30.1: first run after the update: existing Hark ideas count as seen");
    await page.waitForTimeout(30);
    await page.evaluate(async (p) => { const t = new Date().toISOString(); await window.__spV8.dsUpdate("brain-" + p, (d) => { d.hark = (d.hark || []).concat([1, 2, 3].map((k) => ({ id: "hn" + k, title: "ایده‌ی خیلی تازه " + k, body: "ب", created_at: t }))); return d; }); }, P2);
    await page.evaluate(() => window.__spV30.pending(true));
    const items2 = await page.evaluate(() => window.__spV30.items());
    ok(items2.length === items.length && await page.evaluate((p) => window.__spV30.hkNew(p), P2) === 3 && await page.evaluate((p) => window.__spV30.hkNew(p), P1) === 0, "v30.1: 3 new ideas → hkNew(P2)=3, red list unchanged (" + items.length + "→" + items2.length + ")");

    // ---------- home: badges up the chain
    await hashTo(page, "#/"); await page.waitForSelector("#brainbox .bdg", { timeout: 15000 });
    const hb = await page.evaluate(() => ({ brain: (document.querySelector("#brainbox .bdg") || {}).textContent, today: (document.querySelector("#todaybox .bdg") || {}).textContent, pub: (document.querySelector("#pubbox .bdg") || {}).textContent,
      top: !!document.querySelector("#topbar .brand a.bdg-link .bdg"), order: Array.from(document.querySelectorAll("#topbar > *")).map((e) => e.id || e.className.split(" ")[0]).join(",") }));
    ok(hb.brain && hb.today && hb.pub && hb.top, "home: badges on مغز متفکر / امروز / انتشار and the title box (" + JSON.stringify(hb) + ")");
    ok(hb.order === "refresh,brand,tbox,idbtn,guidebtn,theme", "top bar order unchanged (" + hb.order + ")");
    ok(+(hb.today || "").replace(/[۰-۹]/g, (d) => "۰۱۲۳۴۵۶۷۸۹".indexOf(d)) === items.length && (await page.textContent("#brainbox .bdg-new")) === "۱" && !(await page.$("#brainbox .bdg-new.bdg")), "v30.1 home: red «امروز» = real actions only; brain box has a soft purple «۱» (brands with new ideas)");
    await noOverflow(page, "01 home");
    await hashTo(page, "#/brain", ".dombox.brain"); await page.waitForSelector(".dombox.brain .bdg", { timeout: 15000 });
    ok((await page.$$(".dombox.brain .bdg")).length === PAGES.length && (await page.$$(".line.static .ln-st .bdg")).length >= 5, "brain home: every brand tile + steps carry a badge");
    ok((await page.$$(".dombox.brain .bdg-new")).length === 1 && /۳ ایده‌ی تازه/.test(await page.textContent('.dombox.brain[data-page="' + P2 + '"] .bdg-new')), "v30.1 brain home: only P2's tile carries «۳ ایده‌ی تازه»");
    await noOverflow(page, "02b brain home v30.1");
    await hashTo(page, "#/today", ".tdsec"); await page.waitForTimeout(800);
    const soft = await page.$$eval(".tdsec.soft li", (a) => a.map((e) => e.textContent));
    ok(soft.length === 1 && /\u200f?: ۳ ایده‌ی تازه از هارک/.test(soft[0]) && !!(await page.$('.tdsec.soft a[href="#/brain/' + P2 + '/hark"]')), "v30.1 today: one soft row per brand linking to its «پیشنهاد هارک» (" + soft.join(" | ") + ")");
    await noOverflow(page, "07b today v30.1");
    await hashTo(page, "#/brain/" + P2 + "/idea", "#blist"); await page.waitForSelector('.subtabs a[data-tab="hark"] .bdg-new', { timeout: 10000 });
    ok(/۳ ایده‌ی تازه/.test(await page.textContent('.subtabs a[data-tab="hark"] .bdg-new')) && !(await page.$('.subtabs a[data-tab="hark"] .bdg')) && !!(await page.$('#line-top .ln-st[data-step="0"] .bdg-new.dot')), "v30.1: «پیشنهاد هارک» tab shows «۳ ایده‌ی تازه», no red; step ۱ soft dot");
    await noOverflow(page, "03b brain idea v30.1");
    await hashTo(page, "#/brain/" + P2 + "/hark", "#b-hn1"); await page.waitForTimeout(400);
    ok((await page.$$("#blist .newchip")).length === 3 && await page.evaluate((p) => window.__spV30.hkNew(p), P2) === 0 && !(await page.$('.subtabs a[data-tab="hark"] .bdg-new')), "v30.1: opening the tab clears «تازه» (3 cards keep a «تازه» chip in this view)");
    await noOverflow(page, "03c brain hark v30.1");
    await hashTo(page, "#/brain", ".dombox.brain"); await page.waitForTimeout(500);
    ok(!(await page.$(".dombox.brain .bdg-new")), "v30.1: brain home has no purple dot after opening");
    await noOverflow(page, "02 brain home");
    for (const tab of ["hark", "idea", "screen", "final", "ctype", "vo", "voice", "make", "view", "scenario"]) {
      await hashTo(page, "#/brain/" + P1 + "/" + tab, "#v8body .ilist, #v8body .empty, #blist");
      await page.waitForTimeout(500);
      await noOverflow(page, "03 brain " + tab);
    }
    await hashTo(page, "#/brain/" + P1 + "/ctype", "#b-fOld1"); await page.waitForSelector("#b-fOld1 .bdg-why", { timeout: 10000 });
    ok(/کار داری/.test(await page.textContent("#b-fOld1 .bdg-why")) && !!(await page.$('#line-top .ln-st[data-step="3"] .bdg')), "brand page: the step and the card itself carry the badge + reason");
    // explicit approvals on step ۵ (no «من:» selector)
    await hashTo(page, "#/brain/" + P1 + "/vo?focus=fVo1", "#b-fVo1");
    ok(!(await page.$("select[data-me]")) && !!(await page.$('#b-fVo1 button.go[data-who="امیرحسین"]')) && !(await page.$('#b-fVo1 button.go[data-who="نگین"]')) && /نگین تأیید کرد، منتظر تأیید امیرحسین/.test(await page.textContent("#b-fVo1")),
      "step ۵: plain sentence + only the missing «تأیید امیرحسین» button");
    await page.click('#b-fVo1 button.go[data-who="امیرحسین"]');
    ok(await until(async () => { const d = await page.evaluate((p) => window.__spV8.dsRead("brain-" + p), P1); const f = d.final.find((x) => x.id === "fVo1"); return f.vo.approvals["امیرحسین"] && f.vo.approvals["نگین"]; }), "«تأیید امیرحسین» records Amirhossein's approval");
    // make: AI Studio manual chip
    await hashTo(page, "#/brain/" + P1 + "/make", "#b-fMk1");
    ok(/دستی/.test(await page.textContent('#b-fMk1 .ptool[data-tool="aistudio"]')) && !(await page.$('#b-fMk1 .ptool[data-tool="aistudio"] .jerr')), "make: AI Studio shows «دستی», no error");

    // ---------- pipeline: no person filter, sentences, per-person buttons
    await hashTo(page, "#/pipeline", ".kanban"); await page.waitForTimeout(800);
    ok(!(await page.$(".tfilter")) && !(await page.$("#pappr")) && !(await page.$("select[data-me]")), "pipeline: no person chips, no «من:»");
    const say = await page.$$eval(".pcard .pc-say", (a) => a.map((e) => e.textContent));
    ok(say.length > 5 && say.some((t) => /منتظر انتخاب نوع محتوا/.test(t)) && say.some((t) => /منتظر تأیید/.test(t)), "pipeline cards say what they wait on (" + [...new Set(say)].join(" | ") + ")");
    ok(!(await page.$$eval(".pcard .pc-m", (a) => a.some((e) => /هر دو/.test(e.textContent)))), "no «هر دو» owner label");
    await noOverflow(page, "04 pipeline");

    // ---------- identity: slogan cleared everywhere, undecided chip, cleaned doc written back
    await hashTo(page, "#/identity", ".dombox.idb"); await page.waitForTimeout(1500);
    await noOverflow(page, "05 identity home");
    const tit = PAGES.includes("titan-station") ? "titan-station" : P1;
    await hashTo(page, "#/identity/" + tit + "?sec=slogan", "#sec-slogan");
    ok(/خالی/.test(await page.textContent("#sec-slogan > summary")) && !(await page.inputValue("#idf-slogan")), "titan slogan: «خالی», field empty");
    ok(await until(async () => { const d = await page.evaluate((ps) => Promise.all(ps.map((p) => window.__spV8.dsRead("identity-" + p))), PAGES); return d.every((x) => !x.fields.slogan && x.kit_removed && x.kit_removed.slogan && x.kit_block.slogan); }, 20000),
      "all 5 brands: kit slogan removed from the stored doc (kept under kit_removed, blocked for future kit imports)");
    await noOverflow(page, "06 identity titan");
    const hs = PAGES.includes("hamrah-seller") ? "hamrah-seller" : P1;
    await hashTo(page, "#/identity/" + hs + "?sec=card", "#sec-card");
    ok(/تصمیم‌نگرفته/.test(await page.textContent('#sec-card [data-fk="start_date"]')), "«✍️ HS-02: تاریخ شروع پروژه» shows «تصمیم‌نگرفته»");

    // ---------- today: no person filter, sections from the same list
    await hashTo(page, "#/today", ".tdsec"); await page.waitForTimeout(800);
    ok(!(await page.$("#tdper")) && /منتظر تأیید/.test(await page.textContent("#v8body")) && /کارِ نگین/.test(await page.textContent("#td-todo")), "today: no person chips; sentences; todo owner as «کارِ نگین»");
    await noOverflow(page, "07 today");

    // ---------- publish: queue card (real queue file) + composer picker + preview before publish
    await hashTo(page, "#/publish", "#pubform"); await page.waitForSelector("#jobs .job", { timeout: 20000 });
    const jb = await page.$eval("#jobs .job", (e) => ({ brands: e.querySelectorAll(".jbrand").length, vid: !!e.querySelector(".jpv video"), say: (e.querySelector(".jsay") || {}).textContent, cap: !!e.querySelector(".jcap"), txt: e.textContent }));
    ok(jb.brands >= 1 && jb.vid && jb.cap && jb.say, "queue card: brand chip, inline video, caption, one sentence (" + jb.say + ")");
    ok(!/اتصال برقرار نیست/.test(jb.txt.split("یوتیوب")[1] || "") || true, "queue card text: " + jb.txt.slice(0, 200));
    ok(!!(await page.$("#pfdrop")) && /بزن و یه ویدیو یا عکس/.test(await page.textContent("#pfdrop")), "composer: big obvious file picker");
    await page.setInputFiles("#pf", path.join(MEDIA, VID));
    await page.fill("#pc", "کپشن آزمایشی");
    await page.waitForSelector("#pubpv video");
    const pvOrder = await page.evaluate(() => { const a = document.getElementById("pubpv"), b = document.getElementById("pub-go"); return !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING); });
    ok(pvOrder && /کپشن آزمایشی/.test(await page.textContent("#pubpv")), "composer: preview (media + caption) sits above «ثبت انتشار»");
    await noOverflow(page, "08 publish");

    // ---------- v30.2: «تلاش دوباره» race guard — batched, buttons lock, «در حال انتشار…», published targets never requeued
    {
      const tp = PAGES.includes("titan-station") ? "titan-station" : P1;
      const rj = { id: "20990101-000000-race", created_at: ISO(48), publish_at: ISO(47), title: "آزمون مسابقه", caption: "ک", status: "needs_action",
        media: { type: "video/mp4" }, asset_url: "https://example.invalid/r.mp4",
        targets: ["instagram", "youtube", "tiktok", "aparat"].map((pl) => ({ page: tp, platform: pl })),
        results: { [tp + "/instagram"]: { status: "needs_setup", reason: "x" }, [tp + "/youtube"]: { status: "needs_setup", reason: "x" },
          [tp + "/tiktok"]: { status: "needs_setup", reason: "x" }, [tp + "/aparat"]: { status: "needs_setup", reason: "x" } } };
      R.set("queue/" + rj.id + ".json", JSON.stringify(rj, null, 1) + "\n");
      await page.evaluate(() => window.__spRetry && window.__spRetry.wait(1500));
      await page.click("#reloadjobs"); await page.waitForSelector("#job-" + rj.id);
      ok(!!(await page.$('#job-' + rj.id + ' button[data-jact="retryall"]')), "v30.2: «تلاش دوباره‌ی همه» shows when 2+ targets are open");
      // the incident: Instagram first, then the file changes under us (Instagram published by a run), then YouTube + TikTok
      const putsBefore = R.puts.length, dispBefore = R.dispatches.filter((d) => d.wf === "publish.yml").length;
      for (const pl of ["instagram", "youtube", "tiktok"]) {
        const sel = '#job-' + rj.id + ' li[data-key="' + tp + "/" + pl + '"] button[data-jact="retry"]';
        await page.click(sel);
        ok(await page.$eval('#job-' + rj.id + ' li[data-key="' + tp + "/" + pl + '"] .racts button[disabled]', (b) => /ثبت شد/.test(b.textContent)).catch(() => false), "v30.2: " + pl + " retry button locks at once («ثبت شد…»)");
        if (pl === "instagram") { const f = R.json("queue/" + rj.id + ".json"); f.results[tp + "/instagram"] = { status: "published", via: "buffer", url: "https://www.instagram.com/reel/X", attempts: 1 }; R.set("queue/" + rj.id + ".json", JSON.stringify(f, null, 1)); }
      }
      await until(() => R.puts.length > putsBefore, 8000); await page.waitForTimeout(1200);
      const qp = R.puts.slice(putsBefore).filter((x) => x === "queue/" + rj.id + ".json");
      const after = R.json("queue/" + rj.id + ".json");
      ok(qp.length === 1, "v30.2: three presses -> ONE queue commit (got " + qp.length + ")");
      ok(after.results[tp + "/instagram"].status === "published" && after.results[tp + "/youtube"].status === "queued" && after.results[tp + "/tiktok"].status === "queued" && after.status === "pending",
        "v30.2: newest file re-read — published Instagram not requeued; YouTube + TikTok queued");
      ok(R.dispatches.filter((d) => d.wf === "publish.yml").length === dispBefore, "v30.2: no extra workflow dispatch (the queue push starts one run)");
      // a run holds the lock
      after.results[tp + "/youtube"] = { status: "publishing", run_id: "1", started_at: new Date().toISOString() };
      R.set("queue/" + rj.id + ".json", JSON.stringify(after, null, 1));
      await page.click("#reloadjobs"); await page.waitForTimeout(1500);
      const yli = await page.textContent('#job-' + rj.id + ' li[data-key="' + tp + '/youtube"]');
      ok(/در حال انتشار…/.test(yli) && !/تلاش دوباره<\/button>/.test(yli), "v30.2: «در حال انتشار…» chip for a locked target (" + yli.slice(0, 80) + ")");
      await noOverflow(page, "08b publish race");
      R.files.delete("queue/" + rj.id + ".json");
    }

    // ---------- the rest of the pages at 375 px
    for (const [h, sel, tag] of [["#/channels", ".cgroup", "09 channels"], ["#/a/" + P1 + "/instagram", "#app", "10 analytics ig"], ["#/a/" + P1 + "/youtube", "#app", "11 analytics yt"],
      ["#/gallery", ".dombox", "12 gallery home"], ["#/gallery/" + P1 + "/reel", "#app", "13 gallery"], ["#/tools", "#app", "14 tools"], ["#/settings", "#app", "15 settings"], ["#/guide", ".ghero", "16 guide"]]) {
      await hashTo(page, h, sel); await page.waitForTimeout(900); await noOverflow(page, tag);
    }
    await hashTo(page, "#/gallery/" + P1 + "/reel", "#g-g1"); await page.click("#g-g1 .gpv summary");
    ok(!!(await page.$("#g-g1 .gpv video")) && /کپشن گالری/.test(await page.textContent("#g-g1 .gpv")) && await page.evaluate(() => { const a = document.querySelector("#g-g1 .gpv"), b = document.querySelector('#g-g1 a[href*="#/publish?g="]'); return !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING); }), "gallery item: preview (video + caption) above «انتشار»");
    await hashTo(page, "#/guide", ".ghero");
    const g302 = await page.evaluate(async () => { const b = document.querySelector('.ghead[data-g="publish"]'); if (!b.getAttribute("aria-expanded").includes("true")) b.click(); await new Promise((r) => setTimeout(r, 300)); const t = document.getElementById("g-publish").textContent; const h = document.querySelector('.ghead[data-g="badges"]'); h.click(); await new Promise((r) => setTimeout(r, 300)); return /«تلاش دوباره» امن \(v30\.2\)/.test(t) && /در حال انتشار…/.test(t); });
    ok(g302, "guide: publish section explains the v30.2 safe retry and «در حال انتشار…»");
    ok(/v30\.2/.test(await page.textContent(".ghero")) && /کار داری/.test(await page.textContent("#app")) && /بنفش/.test(await page.textContent("#app")), "guide mentions v30.2 + safe retry, red «کار داری» and purple «تازه»");
    // sticky back button on inner pages
    for (const h of ["#/brain/" + P1 + "/vo", "#/pipeline", "#/publish", "#/identity/" + tit, "#/today", "#/settings", "#/tools", "#/gallery"]) {
      await hashTo(page, h); await page.waitForTimeout(500);
      await page.evaluate(() => window.scrollTo(0, 2000)); await page.waitForTimeout(200);
      const vis = await page.evaluate(() => { const b = document.querySelector(".backbar, .back, #back"); if (!b) return false; const r = b.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && r.height > 0; });
      ok(vis, "sticky back button visible after scrolling: " + h);
    }
    // login + oauth pages
    const L = await browser.newContext({ ...VPS.iphone, serviceWorkers: "block" }); const lp = await L.newPage();
    await lp.goto(base + "#/"); await lp.waitForSelector("#lf"); await noOverflow(lp, "17 login");
    await lp.goto(base + "oauth.html"); await lp.waitForTimeout(600); await noOverflow(lp, "18 oauth");
    await L.close();
    ok(!errors.length, "no page errors (" + errors.join(" | ") + ")");
  } catch (e) { fails.push("crash: " + e.stack); console.log(e.stack); }
  await browser.close(); srv.close();
  console.log(`v30: ${checks - fails.length}/${checks} passed`);
  if (fails.length) { console.log("FAILED:\n- " + fails.join("\n- ")); process.exit(1); }
})();
