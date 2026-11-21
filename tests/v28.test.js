// v28 end-to-end tests: Brain 8-step line — ۵ «اسکریپت ویس‌اور» (voscript robot) + ۶ «ساخت صدا» (voice request, upload, dual approval), produce carries voice/music,
// sticky back button above the «در حال به‌روزرسانی» box. Harness copied from v13.test.js. usage: node tests/v28.test.js <fixture_dir> <media_dir>
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
    wide: Array.from(document.querySelectorAll("#app *")).filter((e) => { const a = document.getElementById("app").getBoundingClientRect(), r = e.getBoundingClientRect(); return r.width && (r.right > a.right + 1 || r.left < a.left - 1) && !e.closest(".sfilter,.tabs,.chm-wrap,.toast,.line,.progress"); }).slice(0, 4).map((e) => e.tagName + "." + e.className + " " + Math.round(e.getBoundingClientRect().width)) }), W);
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
const SEED = (P) => ({ items: [], hark: [], screen: [], final: [
  { id: "fA", page: P, title: "ویدیوی صبح", text: "هوک: صبح‌ها این کار رو می‌کنی؟\nبیت ۱: گوشی قبل از آب", script: { hook: "صبح‌ها این کار رو می‌کنی؟" }, content_type: "video", created_at: "2026-11-20T08:00:00Z", jobs: {} },
  { id: "fB", page: P, title: "اسلاید نکته‌ها", text: "اسلاید ۱: نکته\nاسلاید ۲: نکته", script: {}, content_type: "slide", created_at: "2026-11-20T07:00:00Z", jobs: {} },
  { id: "fC", page: P, title: "قدیمی فرستاده‌شده", text: "متن", script: {}, content_type: "video", created_at: "2026-11-19T07:00:00Z", jobs: { claude: { id: "jold", state: "queued", requested_at: "2026-11-19T08:00:00Z" } } },
  { id: "fD", page: P, title: "بدون نوع", text: "متن", script: {}, created_at: "2026-11-18T07:00:00Z", jobs: {} },
  // v29.1: sent to make before v28 without a type (Negin's «من سر ساعت می‌رسم» case) → back to ۴
  { id: "fE", page: P, title: "قدیمی بدون نوع فرستاده‌شده", text: "متن", script: {}, created_at: "2026-11-17T07:00:00Z", jobs: { claude: { id: "jE", state: "queued", requested_at: "2026-11-17T08:00:00Z" } } },
  // v29.1: typed + music approved, AI Studio job ended in a network error → «دستی»
  { id: "fF", page: P, title: "موسیقی آماده", text: "متن", script: {}, content_type: "slide", created_at: "2026-11-16T07:00:00Z",
    vo: { mode: "music", music: { note: "لوفای" }, approvals: { "نگین": { at: "x" }, "امیرحسین": { at: "x" } } },
    jobs: { aistudio: { id: "jF", state: "error", reason: "AI Studio از مرورگر هارک باز نمی‌شود (خطای شبکه)", requested_at: "2026-11-16T08:00:00Z" } } }] });
async function approveBoth(page, card, act) {
  for (const who of ["نگین", "امیرحسین"]) {
    await page.selectOption(card + " select[data-me]", who);
    await page.waitForFunction(([c, w]) => { const s = document.querySelector(c + " select[data-me]"); return s && s.value === w; }, [card, who]);
    await page.click(card + ' [data-act="' + act + '"]');
    await page.waitForFunction(([c, w]) => !document.querySelector(c) || /پس گرفتن تأیید/.test((document.querySelector(c + " .v6appr") || {}).textContent || "") || location.hash.indexOf("/" + "vo?") < 0, [card, who], { timeout: 15000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 400));
  }
}

(async () => {
  const { srv, url: base } = await serve(FX, { "/app.js": patchedApp });
  const browser = await chromium.launch();
  const R = new Repo();
  R.set("config/token.enc.json", await tokenEnc(P, TOKEN));
  R.set("config/hark_pub.json", testPub);
  try {
    const A = await device(browser, R, "desktop", { pw: P });
    const page = A.page;
    await nav(page, base, "#/brain/" + P1 + "/vo", "#blist");
    await page.evaluate(([p, seed]) => window.__spV8.dsUpdate("brain-" + p, () => seed), [P1, SEED(P1)]);
    // ---------------- pure rules
    const u = await page.evaluate(() => {
      const V = window.__spV28, now = { at: "x" };
      const legacy = { content_type: "video", jobs: {} }, sent = { content_type: "video", jobs: { claude: { state: "queued" } } };
      const music = { content_type: "slide", jobs: {}, vo: { mode: "music", music: { note: "لوفای" }, approvals: { "نگین": now, "امیرحسین": now } } };
      const voiceHalf = { content_type: "slide", jobs: {}, vo: { mode: "voice", text: "متن", approvals: { "نگین": now, "امیرحسین": now } }, voice: { audio: { url: "https://x/a.mp3" }, approvals: { "نگین": now } } };
      const voiceAll = JSON.parse(JSON.stringify(voiceHalf)); voiceAll.voice.approvals["امیرحسین"] = now;
      let d = { final: [{ id: "f1", vo: { mode: "voice", request_id: "r1", state: "queued" }, voice: { job: { id: "j9", state: "queued", tool: "elevenlabs" } } }] };
      d = V.applyHarkOut(d, { id: "o1", type: "voscript", request_id: "rOLD", final_id: "f1", vo: { text: "کهنه" } }, "p");
      const stale = !d.final[0].vo.text;
      d = V.applyHarkOut(d, { id: "o2", type: "voscript", request_id: "r1", final_id: "f1", vo: { text: "سلام", segments: [{ t: "0:00–0:03", text: "سلام" }] }, provider: "gemini", model: "m" }, "p");
      d = V.applyHarkOut(d, { id: "o3", type: "voice_result", job_id: "j9", final_id: "f1", state: "done", audio_url: "https://github.com/a/b/releases/download/gallery/v.mp3" }, "p");
      return { n: V.line().length, names: V.line().map((x) => x[1]), legacy: V.finalStep(legacy), sent: V.finalStep(sent), none: V.finalStep({ jobs: {} }), music: V.finalStep(music), musicReady: V.voReady(music),
        half: V.finalStep(voiceHalf), all: V.finalStep(voiceAll), stale, vo: d.final[0].vo, voice: d.final[0].voice, segs: V.parseVoSegs("0:00–0:03 | اسلاید ۱ | سلام | آروم\nفقط متن"),
        tools: V.voiceTools().map((t) => t.id), pst: V.pstages().map((x) => x[0]).slice(0, 8).join(",") };
    });
    ok(u.n === 8 && u.names.join("›") === "مغز متفکر›غربال‌گری›اسکریپت نهایی›نوع محتوا›اسکریپت ویس‌اور›ساخت صدا›ساخت›مشاهده و انتشار", "line has the 8 steps in Negin's order");
    ok(u.legacy === 4 && u.sent === 4 && u.none === 3, "old finals (v29.1): typed -> ۵ اسکریپت ویس‌اور even if already sent, untyped -> ۴ (" + [u.legacy, u.sent, u.none] + ")");
    ok(u.music === 6 && u.musicReady && u.half === 5 && u.all === 6, "music skips ساخت صدا; voice waits until both approve the audio");
    ok(u.stale && u.vo.text === "سلام" && u.vo.state === "ready" && u.vo.provider === "gemini" && u.vo.segments === undefined && u.vo.script.segments.length === 1, "voscript result merged (stale request ignored)");
    ok(u.voice.job.state === "done" && u.voice.audio.url.endsWith("v.mp3") && u.voice.audio.source === "tool", "voice_result merged as the item's audio");
    ok(u.segs.length === 2 && u.segs[0].scene === "اسلاید ۱" && u.segs[0].note === "آروم" && u.segs[1].text === "فقط متن", "timing lines parsed");
    ok(u.tools.join() === "elevenlabs,other", "voice tools from config.json voice_tools");
    ok(u.pst === "idea,screen,script,ctype,vo,voice,make,view", "pipeline columns follow the 8-step line");
    // ---------------- v29.1: stage derivation from what is really done
    const w = await page.evaluate(() => {
      const V = window.__spV28, A = { "نگین": { at: "x" }, "امیرحسین": { at: "x" } };
      const oldSent = { jobs: { claude: { state: "queued" } } }, oldErr = { jobs: { aistudio: { state: "error" } } };
      const typedSent = { content_type: "video", jobs: { claude: { state: "done" } } };
      const music = { content_type: "slide", jobs: {}, vo: { mode: "music", music: { note: "x" }, approvals: A } };
      const voiceNoAudio = { content_type: "slide", jobs: {}, vo: { mode: "voice", text: "t", approvals: A } };
      const voiceOne = { content_type: "slide", jobs: {}, vo: { mode: "voice", text: "t", approvals: { "نگین": { at: "x" } } } };
      return { s1: V.finalStep(oldSent), t1: V.finalTicks(oldSent), s2: V.finalStep(oldErr), sm: V.finalStep(music), tm: V.finalTicks(music),
        sv: V.finalStep(voiceNoAudio), tv: V.finalTicks(voiceNoAudio), s1a: V.finalStep(voiceOne), sd: V.finalStep(typedSent), td: V.finalTicks(typedSent) };
    });
    ok(w.s1 === 3 && w.s2 === 3 && w.t1.slice(3, 7).every((x) => !x) && w.t1.slice(0, 3).every(Boolean), "v29.1: old item sent to make without a type -> step ۴; steps ۴–۷ not ticked (" + w.s1 + "," + w.t1 + ")");
    ok(w.sm === 6 && w.tm[3] && w.tm[4] && w.tm[5] && !w.tm[6], "v29.1: music approved -> ۷ ساخت, ۶ ticked (skipped)");
    ok(w.sv === 5 && w.tv[4] && !w.tv[5] && w.s1a === 4, "v29.1: voice-over approved but no voice -> ۶; one approval -> ۵");
    ok(w.sd === 7 && w.td[3] && !w.td[4] && !w.td[5] && w.td[6], "v29.1: something made -> ۸ with honest ticks (no voice-over ✓)");
    // ---------------- v29.1 UI: old untyped item at ۴ with steps ۴–۶ unticked; stepper badges; AI Studio manual
    await hashTo(page, "#/brain/" + P1 + "/ctype", "#b-fE");
    const mE = await page.$$eval("#b-fE .ln-mini a", (a) => a.map((e) => e.className));
    ok(mE[3] === "cur" && mE.slice(4).every((c) => c === "") && mE.slice(0, 3).every((c) => c === "done"), "v29.1: card mini stepper of the old item: ۴ current, ۵–۸ not ticked (" + mE + ")");
    ok(/برگشته/.test(await page.textContent("#b-fE")), "v29.1: old item explains why it is back at ۴");
    const cnt = await page.$$eval("#line-top .ln-st em", (a) => a.map((e) => e.textContent));
    ok(/۲/.test(cnt[3]) && /۳/.test(cnt[4]) && /۱/.test(cnt[6]), "v29.1: stepper badges count by real state (" + cnt + ")");
    await hashTo(page, "#/brain/" + P1 + "/make", "#b-fF");
    const af = await page.$eval('#b-fF .ptool[data-tool="aistudio"]', (e) => ({ t: e.textContent, man: !!e.querySelector(".j-manual"), err: !!e.querySelector(".jerr, .j-error"), b: (e.querySelector('[data-act="send"]') || {}).disabled }));
    ok(af.man && !af.err && /دستی/.test(af.t) && /دکمه‌ی اکانت/.test(af.t) && af.b === false && !/خطای شبکه/.test(af.t), "v29.1: AI Studio error shown as grey «دستی» with a usable «ارسال» (" + JSON.stringify(af) + ")");
    await hashTo(page, "#/brain/" + P1 + "/vo", "#blist .voitem");

    // ---------------- UI: stepper + step ۵
    await page.reload(); await page.waitForSelector("#blist .voitem");
    ok((await page.$$("#line-top .ln-st")).length === 8, "stepper shows 8 steps");
    ok(/مرحله‌ی ۵ از ۸/.test(await page.textContent("#line-top")), "stepper footer: step 5 of 8");
    const vids = await page.$$eval("#blist .voitem", (a) => a.map((e) => e.getAttribute("data-id")));
    ok(vids.includes("fA") && vids.includes("fB") && vids.includes("fC") && !vids.includes("fD") && !vids.includes("fE"), "old typed finals (sent or not) wait at «اسکریپت ویس‌اور» (" + vids + ")");
    ok((await page.$$("#blist .voitem .ln-mini a")).length === 8 * vids.length, "card mini-lines have 8 dots");
    await page.click('#b-fA [data-act="vomode"][data-mode="voice"]');
    await page.waitForSelector('#b-fA [data-act="vorun"]');
    await page.click('#b-fA [data-act="vorun"]');
    await until(() => R.dispatches.some((x) => x.wf === "voscript.yml"));
    const dsp = R.dispatches.filter((x) => x.wf === "voscript.yml")[0];
    const rq = listReq(R).filter((r) => r.type === "voscript")[0];
    ok(rq && dsp && dsp.body.inputs.request_id === rq.id && rq.final_id === "fA" && rq.content_type === "video" && /گوشی قبل از آب/.test(rq.script_text), "«نوشتن ویس‌اور» = encrypted voscript request + voscript.yml dispatch with its id");
    ok(!/گوشی/.test(R.text("hark/requests/" + rq.id + ".json")), "voscript request encrypted");
    ok(await page.waitForSelector("#b-fA .scrrun", { timeout: 5000 }).then(() => true, () => false), "card shows the running state");
    const ro = voRobot(R, rq.id);
    ok(/ok: mock\/mock/.test(ro) && !reqFiles(R).includes("hark/requests/" + rq.id + ".json"), "voscript.py answered and deleted the request");
    await page.reload(); await page.waitForSelector("#b-fA .vosegs", { timeout: 20000 });
    ok(/نوشته‌شده با تست/.test(await page.textContent("#b-fA")) && /هوک آزمایشی/.test(await page.textContent("#b-fA .scr")), "voice-over text + «نوشته‌شده با …» shown");
    // redo with a note
    await page.click('#b-fA [data-act="voredoform"]'); await page.fill('#b-fA [data-f="vonote"]', "کوتاه‌تر و شوخ‌تر");
    await page.click('#b-fA .voredo [data-act="vorun"]');
    await until(() => listReq(R).some((r) => r.type === "voscript" && r.redo));
    const rq2 = listReq(R).filter((r) => r.type === "voscript" && r.redo)[0];
    ok(rq2 && rq2.note === "کوتاه‌تر و شوخ‌تر" && /هوک آزمایشی/.test(rq2.previous), "«دوباره (با یادداشت)» sends note + previous text");
    voRobot(R, rq2.id); await page.reload(); await page.waitForSelector("#b-fA .vosegs");
    // edit
    await page.click('#b-fA [data-act="voedit"]');
    await page.fill('#b-fA [data-f="votext"]', "سلام! صبح‌ها اول آب بخور.");
    await page.fill('#b-fA [data-f="vosegs"]', "0:00–0:03 | صحنه ۱ | سلام! | پرانرژی\n0:03–0:06 | صحنه ۲ | صبح‌ها اول آب بخور.");
    await page.click('#b-fA [data-act="vosave"]');
    await page.waitForFunction(() => /صبح‌ها اول آب بخور/.test((document.querySelector("#b-fA .scr") || {}).textContent || ""));
    ok((await page.$$("#b-fA .vosegs li")).length === 2 && /تاریخچه/.test(await page.textContent("#b-fA .iact")), "edit saved with timing + history");
    // comment
    await page.fill('#b-fA [data-f="vocmt"]', "لحن خوبه"); await page.click('#b-fA [data-act="vocmt"]');
    await page.waitForFunction(() => /لحن خوبه/.test((document.querySelector("#b-fA .cmts") || {}).textContent || ""));
    // approvals → ساخت صدا
    await approveBoth(page, "#b-fA", "voappr");
    ok(await until(() => page.evaluate(() => /\/voice\?focus=fA/.test(location.hash))), "both approved -> jumps to «ساخت صدا»");
    await page.waitForSelector("#b-fA.vcitem");
    ok(/ElevenLabs/.test(await page.textContent("#b-fA .ptools")) && /موقته/.test(await page.textContent("#b-fA")), "voice tools listed (preliminary note)");
    await page.click('#b-fA .ptool[data-tool="elevenlabs"] [data-act="vsend"]');
    await until(() => listReq(R).some((r) => r.type === "voice"));
    const vr = listReq(R).filter((r) => r.type === "voice")[0];
    ok(vr && vr.tool === "elevenlabs" && vr.tool_url === "https://elevenlabs.io/app/speech-synthesis" && /صبح‌ها اول آب بخور/.test(vr.vo_text) && vr.final_id === "fA" && vr.comments.some((c) => c.text === "لحن خوبه"), "«ارسال برای ساخت صدا» = encrypted voice request with the approved text");
    await page.reload(); await page.waitForSelector("#b-fA .jchip.j-queued");
    const mp3 = path.join(ASSETS, "tool.mp3"); fs.writeFileSync(mp3, Buffer.concat([Buffer.from("ID3"), crypto.randomBytes(800)]));
    const pv = bridge(R, ["post-voice-result", vr.id, JSON.stringify({ state: "done", audio_file: mp3, note: "صدای مرد، گرم" })]); syncBlobs(R);
    const br = JSON.parse(fs.readFileSync(path.join(LOCAL, ".branches", "media-upload.json")));
    ok(/posted voice result/.test(pv) && Object.keys(br).some((k) => /^gallery\/voice-tool-[0-9a-f]{6}\.mp3$/.test(k)) && JSON.parse(fs.readFileSync(path.join(LOCAL, ".dispatches.json")))[0].workflow === "publish.yml", "bridge post-voice-result stages the audio for the gallery release + dispatches publish.yml");
    await page.reload(); await page.waitForSelector("#b-fA .vaudio audio", { timeout: 20000 });
    ok(/releases\/download\/gallery\/voice-tool-/.test(await page.getAttribute("#b-fA .vaudio audio", "src")) && /ElevenLabs|ساخته‌شده با/.test(await page.textContent("#b-fA .vaudio")), "Hark's audio plays inline with its source");
    // own upload replaces it
    await page.setInputFiles('#b-fA [data-f="vfile"]', WAV);
    await page.click('#b-fA [data-act="vup"]');
    await page.waitForFunction(() => /بارگذاری‌شده/.test((document.querySelector("#b-fA .vaudio") || {}).textContent || ""), null, { timeout: 20000 });
    const mref = R.refs.get("media-upload"), mtree = mref && R.trees.get(R.commits.get(mref).tree);
    ok(mtree && mtree.some((e) => /^gallery\/voice-v.*\.wav$/.test(e.path)), "upload staged on media-upload under gallery/");
    ok(R.dispatches.some((x) => x.wf === "publish.yml"), "upload dispatches publish.yml (moves it into the release)");
    ok(/^blob:/.test(await page.getAttribute("#b-fA .vaudio audio", "src")) && /صداهای قبلی/.test(await page.textContent("#b-fA")), "uploaded audio plays right away; previous audio kept");
    await approveBoth(page, "#b-fA", "vappr");
    ok(await until(() => page.evaluate(() => /\/make\?focus=fA/.test(location.hash))), "audio approved by both -> «ساخت»");
    await page.waitForSelector('#b-fA [data-act="send"][data-tool="claude"]');
    await page.click('#b-fA [data-act="send"][data-tool="claude"]');
    await until(() => listReq(R).some((r) => r.type === "produce" && r.final_id === "fA"));
    const pr = listReq(R).filter((r) => r.type === "produce" && r.final_id === "fA")[0];
    ok(pr && /releases\/download\/gallery\/voice-v.*\.wav$/.test(pr.voice_url) && pr.voice_source === "upload" && pr.voiceover.mode === "voice" && pr.voiceover.segments.length === 2 && pr.music === null, "produce carries voice_url + voice-over text/timing");
    // ---------------- music path (fB)
    await hashTo(page, "#/brain/" + P1 + "/vo?focus=fB", "#b-fB");
    await page.click('#b-fB [data-act="vomode"][data-mode="music"]');
    await page.waitForSelector('#b-fB [data-f="mnote"]');
    await page.fill('#b-fB [data-f="mnote"]', "لوفای آروم"); await page.fill('#b-fB [data-f="mlink"]', "example.com/track");
    await page.click('#b-fB [data-act="musicsave"]');
    await page.waitForSelector('#b-fB [data-act="voappr"]');
    await approveBoth(page, "#b-fB", "voappr");
    ok(await until(() => page.evaluate(() => /\/make\?focus=fB/.test(location.hash))), "music approved -> skips «ساخت صدا» to «ساخت»");
    await page.waitForSelector('#b-fB [data-act="send"][data-tool="gemini"]');
    ok(/لوفای آروم/.test(await page.textContent("#b-fB .vosum")), "make card shows the music note");
    await page.click('#b-fB [data-act="send"][data-tool="gemini"]');
    await until(() => listReq(R).some((r) => r.type === "produce" && r.final_id === "fB"));
    const pm = listReq(R).filter((r) => r.type === "produce" && r.final_id === "fB")[0];
    ok(pm && pm.music.note === "لوفای آروم" && pm.music.link === "https://example.com/track" && pm.voice_url === "" && pm.voiceover.mode === "music", "produce carries the music note/link");
    ok(!/لوفای|صبح‌ها اول/.test(R.text("vault/brain-" + P1 + ".enc.json")), "voice-over + music stored encrypted");
    // legacy sent item still in make; gate on unready items
    await hashTo(page, "#/brain/" + P1 + "/make", "#b-fC");
    ok(!!(await page.$('#b-fC button[disabled]')) && !(await page.$('#b-fC [data-act="send"]')) && /مرحله‌ی ۵/.test(await page.textContent("#b-fC")), "v29.1: already-sent legacy final without approved voice-over waits (send disabled, points to step ۵)");
    // pipeline columns
    await hashTo(page, "#/pipeline", ".pflow");
    ok(/اسکریپت ویس‌اور/.test(await page.textContent(".pflow")) && /ساخت صدا/.test(await page.textContent(".pflow")), "pipeline flow shows the two new columns");

    // ---------------- account picker (fake e-mails only; the real list lives only in the encrypted vault)
    const ACC = [{ email: "amir.titan@example.com", person: "amirhossein", brand: P1 }, { email: "negin.test@example.com", person: "negin" }, { email: "team.x@example.com", tools: ["claude"] }];
    ok(/posted 3 account/.test(bridge(R, ["post-accounts", "-"], JSON.stringify(ACC))), "bridge post-accounts (encrypted)");
    ok(!/example\.com/.test(R.text(outFiles(R, "accounts")[0])), "accounts outbox file is ciphertext");
    ok(/secret field/.test(bridgeFails(R, ["post-accounts", JSON.stringify([{ email: "a@b.co", password: "x" }])]) || ""), "bridge refuses anything but e-mails");
    await hashTo(page, "#/settings", "#acct-body");
    await page.waitForSelector("#acct-body .acset", { timeout: 20000 });
    ok((await page.$$("#acct-body .acset")).length === 3 && !outFiles(R, "accounts").length, "panel merged the accounts into its store and deleted the outbox file");
    ok(R.files.has("vault/accounts.enc.json") && isEncFile(R.text("vault/accounts.enc.json")) && !/example\.com/.test(R.text("vault/accounts.enc.json")), "accounts stored only encrypted (vault/accounts.enc.json)");
    ok(!/example\.com/.test(R.text("config.json") || ""), "no account e-mail in config.json");
    await page.fill("#ac-email", "new.one@example.org"); await page.selectOption("#ac-person", "negin");
    await page.check('input[name="ac-tool"][value="gemini"]'); await page.click('#acct-body [data-ac="save"]');
    await until(() => page.$$eval("#acct-body .acset", (a) => a.length === 4));
    const nrow = await page.$$("#acct-body .acset"); await nrow[3].$eval('[data-ac="del"]', (b) => b.click());
    ok(await until(() => page.$$eval("#acct-body .acset", (a) => a.length === 3)), "settings: add + remove an account");
    await hashTo(page, "#/tools", "#tlist");
    await page.evaluate(() => { window.__opened = []; window.open = (u) => { window.__opened.push(u); return null; }; });
    const gIcon = await page.$('.bicon[data-pick-tool="gemini"][data-pick-brand="' + P1 + '"]') || await page.$('.bicon[data-pick-tool="gemini"]');
    const gUrl = await gIcon.getAttribute("data-pick-url");
    await gIcon.click();
    await page.waitForSelector(".acct-ovl .acrow", { timeout: 15000 }); await shot(page, "picker");
    const grp = await page.$$eval(".acct-ovl .acgrp > b", (a) => a.map((e) => e.textContent));
    ok(grp.includes("نگین") && grp.includes("امیرحسین") && grp.length === 3, "picker groups accounts by person (" + grp + ")");
    await page.click('.acct-ovl .acrow:has-text("amir.titan@example.com")');
    const op = await page.evaluate(() => window.__opened.slice());
    ok(op[0] === "https://accounts.google.com/AccountChooser?Email=" + encodeURIComponent("amir.titan@example.com") + "&continue=" + encodeURIComponent(gUrl) && !(await page.$(".acct-ovl")), "Google tool: AccountChooser with the e-mail + the brand project link");
    const cIcon = await page.$('.bicon[data-pick-tool="claude"]');
    if (cIcon) {
      await cIcon.click(); await page.waitForSelector(".acct-ovl .acrow");
      await page.click('.acct-ovl .acrow:has-text("team.x@example.com")');
      await page.waitForSelector(".acct-ovl .acbox");
      ok(/team\.x@example\.com/.test(await page.textContent(".acct-ovl .acbox")) && await page.$('.acct-ovl [data-x="copy"]'), "Claude: e-mail shown with copy + hint");
      await page.click('.acct-ovl [data-x="login"]');
      ok((await page.evaluate(() => window.__opened.slice())).includes("https://claude.ai/login"), "Claude: opens its login page (no auto-login)");
      await page.click('.acct-ovl [data-x="close"]');
    } else ok(false, "no claude brand tile in the fixture");
    await hashTo(page, "#/brain/" + P1 + "/make", "#b-fC");
    await page.click('#b-fC .ptool[data-tool="chatgpt"] .acpick');
    ok(await page.waitForSelector(".acct-ovl .acrow", { timeout: 10000 }).then(() => true, () => false), "Brain «ساخت» tool button opens the account picker");
    await page.click('.acct-ovl [data-x="close"]');
    // ---------------- sticky back button vs the updating box (mobile)
    const M = await device(browser, R, "iphone", { pw: P });
    for (const h of ["#/brain/" + P1 + "/voice", "#/tools", "#/brain/" + P1 + "/vo"]) {
      await nav(M.page, base, h, "#back");
      await M.page.waitForTimeout(600);
      await M.page.click("#refresh");
      await M.page.waitForSelector("#prog.on", { timeout: 8000 }).catch(() => {});
      await M.page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await M.page.waitForTimeout(300);
      const g = await M.page.evaluate(() => {
        const b = document.getElementById("back").getBoundingClientRect(), p = document.getElementById("prog"), t = document.getElementById("topbar").getBoundingClientRect();
        const pr = p.getBoundingClientRect(), on = p.classList.contains("on") && getComputedStyle(p).display !== "none";
        const hit = document.elementFromPoint(b.left + 30, b.top + b.height / 2);
        return { bt: b.top, bb: b.bottom, tb: t.bottom, pt: pr.top, on, hit: !!(hit && hit.closest("#back")), scrolled: scrollY > 0 };
      });
      ok(g.on && g.hit && Math.abs(g.bt - g.tb) <= 2 && g.pt >= g.bb - 1, h + ": back button stays visible under the top bar after scrolling and the updating box sits below it (" + JSON.stringify(g) + ")");
    }
    await nav(M.page, base, "#/brain/" + P1 + "/vo", "#blist"); await noOverflow(M.page, "vo-375");
    await nav(M.page, base, "#/brain/" + P1 + "/voice?focus=fA", "#blist"); await noOverflow(M.page, "voice-375");
    await nav(M.page, base, "#/guide", "#back");
    await M.page.click('.ghead[data-g="brain"]'); await M.page.waitForSelector("#g-brain .gbody");
    const gb = await M.page.textContent("#g-brain");
    await M.page.click('.ghead[data-g="topbar"]'); await M.page.waitForSelector("#g-topbar .gbody");
    ok(/۵ · اسکریپت ویس‌اور/.test(gb) && /۶ · ساخت صدا/.test(gb) && /۸ · مشاهده و انتشار/.test(gb) && /دکمه‌ی برگشت/.test(await M.page.textContent("#g-topbar")) && /v29/.test(await M.page.textContent(".ghero")), "guide (v28) explains the new steps and the back button");
    ok(!errors.length, "no page errors (" + errors.join(" | ") + ")");
  } catch (e) { fails.push("exception: " + (e && e.stack || e)); console.log(e); }
  await browser.close(); srv.close();
  console.log(`v28: ${checks - fails.length}/${checks} passed`);
  if (fails.length) { console.log("FAILED:\n- " + fails.join("\n- ")); process.exit(1); }
})();
