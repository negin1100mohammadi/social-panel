// v13 end-to-end tests: «هویت» kit import (team-approved fields + encrypted assets from Hark) — harness copied from v10.test.js
// usage: node tests/v13.test.js <fixture_dir> <media_dir>     (SP_SHOTS=<dir> saves screenshots)
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
    wide: Array.from(document.querySelectorAll("#app *")).filter((e) => { const a = document.getElementById("app").getBoundingClientRect(), r = e.getBoundingClientRect(); return r.width && (r.right > a.right + 1 || r.left < a.left - 1) && !e.closest(".sfilter,.tabs,.chm-wrap,.toast"); }).slice(0, 4).map((e) => e.tagName + "." + e.className + " " + Math.round(e.getBoundingClientRect().width)) }), W);
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
const TMP = fs.mkdtempSync("/tmp/spv13-");
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

(async () => {
  const { srv, url: base } = await serve(FX, { "/app.js": patchedApp });
  const browser = await chromium.launch();
  const R = new Repo();
  R.set("config/token.enc.json", await tokenEnc(P, TOKEN));
  R.set("config/hark_pub.json", testPub);
  try {
    const A = await device(browser, R, "desktop", { pw: P });
    const page = A.page;
    await A.ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base.replace(/\/$/, "") });
    await nav(page, base, "#/identity", "#id-domains");
    // ---------------- pure merge rules
    const u = await page.evaluate(() => {
      const V = window.__spV10;
      let d = { fields: { slogan: { v: "تیم", at: "2026-11-17T08:00:00.000Z", by: "negin", src: "user" }, domain: { v: "پیش‌نویس هارک", at: "2026-11-17T09:00:00.000Z", by: "hark", src: "hark", draft: true } } };
      d = V.applyIdentityOut(d, { id: "k1", team: true, by: "kit", label: "از کیت امیرحسین/نگین (Pages.zip)", created_at: "2026-11-17T07:00:00.000Z",
        fields: { slogan: "کیت", domain: "روانشناسی (کیت)", other_rules: "قانون ۱", other_history: "تاریخچه" },
        assets: [{ id: "akit1", name: "logo.png", kind: "logo", sha: "a".repeat(40), k: "AAAA", iv: "BBBB", path: "p/akit1.bin", size: 10, thumb: "data:image/png;base64,iVBOR" }, { id: "bad/id", sha: "x", k: "y", iv: "z" }] });
      const a = JSON.parse(JSON.stringify(d));
      d = V.applyIdentityOut(d, { id: "k1", team: true, fields: { domain: "دوباره" } }); // same id: ignored
      d = V.applyIdentityOut(d, { id: "k2", team: true, by: "kit", label: "L2", created_at: "2026-11-17T10:00:00.000Z", fields: { domain: "کیت جدیدتر" }, assets: [{ id: "akit1", name: "dup", sha: "b", k: "c", iv: "d" }] });
      const brief = V.identityBrief({ name: "X" }, d);
      return { a, d, brief, n: V.sections().length };
    });
    ok(u.a.fields.slogan.v === "تیم", "kit import never overwrites a field the team edited (even with an older timestamp rule aside)");
    ok(u.a.fields.domain.v === "روانشناسی (کیت)" && u.a.fields.domain.src === "user" && u.a.fields.domain.draft === false && u.a.fields.domain.kit === "از کیت امیرحسین/نگین (Pages.zip)" && u.a.fields.domain.by === "kit",
      "kit import replaces a Hark draft (even a newer one) as team-approved content tagged with the kit label");
    ok(u.a.assets.length === 1 && u.a.assets[0].id === "akit1" && u.a.assets[0].branch === "identity-assets" && u.a.assets[0].path === "p/akit1.bin", "kit assets merged (invalid ids dropped)");
    ok(u.d.fields.domain.v === "کیت جدیدتر" && u.d.assets.length === 1, "a newer kit import updates an earlier kit field; duplicate asset ids ignored; same message id idempotent");
    ok(/## سایر \(از کیت\)\nقوانین تولید و اجرا: قانون ۱/.test(u.brief) && !/تاریخچه\n/.test(u.brief.replace(/\(در پنل[^)]*\)/, "")) && /در پنل، بخش «سایر \(از کیت\)»: تاریخچه و پیوست‌ها/.test(u.brief), "brief: «سایر» rules included, long kit notes only referenced");
    ok(u.n === 20, "20 sections");

    // ---------------- Hark drafts first (like the 17 Nov prefill), then a team edit, then the kit import with files
    bridge(R, ["post-identity", P1, JSON.stringify({ fields: { domain: "پیش‌نویس", tone: "لحن پیش‌نویس", slogan: "اسلوگان پیش‌نویس" } })]);
    await page.reload(); await page.waitForSelector("#id-domains"); await until(() => outFiles(R, P1).length === 0);
    await hashTo(page, "#/identity/" + P1, "#idsecs");
    await page.click("#sec-slogan > summary");
    await page.fill('#sec-slogan textarea[data-k="slogan"]', "اسلوگانی که تیم نوشت");
    await page.click('#sec-slogan [data-act="save"]');
    await page.waitForFunction(() => /نگین/.test((document.querySelector("#sec-slogan .idmeta") || {}).textContent || ""));
    const KIT = { label: "از کیت امیرحسین/نگین (Pages.zip)", team: true, by: "kit",
      fields: { domain: "روانشناسی — کیت", slogan: "کیت می‌گوید", colors: [{ name: "سبز شفق", hex: "#2EE59D" }], characters: [{ name: "راوی دانا", look: "سفید صدفی", personality: "مهربان", prompt: "pearl-white figure" }],
        other_rules: "قوانین کیت", other_accounts: "حساب‌ها", other_status: "وضعیت", other_history: "تاریخچه", other_files: "فایل‌ها", ai_notes: "System prompt کیت" },
      asset_files: [{ path: path.join(ASSETS, "titan-logo.png"), kind: "logo" }, { path: path.join(ASSETS, "pack.zip") }, { path: path.join(ASSETS, "clip.mp4") }] };
    fs.writeFileSync(path.join(TMP, "kit.json"), JSON.stringify(KIT));
    const out = bridge(R, ["post-identity", P1, path.join(TMP, "kit.json")]); syncBlobs(R);
    ok(/posted 10 identity field\(s\) as team-approved \+ 3 encrypted file/.test(out), "bridge post-identity: team import + 3 encrypted files (" + out.trim() + ")");
    const br = JSON.parse(fs.readFileSync(path.join(LOCAL, ".branches", "identity-assets.json")));
    ok(Object.keys(br).length === 3 && Object.keys(br).every((k) => k.startsWith(P1 + "/a") && k.endsWith(".bin")), "files committed to identity-assets/<page>/<id>.bin");
    ok(Object.values(br).every((s) => !/PNG|ftyp|readme/.test(R.blobs.get(s).toString("latin1"))), "uploaded blobs are ciphertext");
    ok(!/کیت|titan-logo/.test(R.text(outFiles(R, P1)[0])), "kit outbox message encrypted");
    await page.reload(); await page.waitForSelector("#idsecs"); await until(() => outFiles(R, P1).length === 0);
    await page.reload(); await page.waitForSelector("#idsecs");
    ok(outFiles(R, P1).length === 0, "panel merged + deleted the kit message");
    ok((await page.inputValue('#sec-slogan textarea[data-k="slogan"]')) === "اسلوگانی که تیم نوشت", "team-edited slogan kept");
    ok((await page.inputValue('#sec-domain textarea[data-k="domain"]')) === "روانشناسی — کیت", "Hark draft replaced by kit value");
    ok(/از کیت امیرحسین\/نگین \(Pages\.zip\)/.test(await page.textContent("#sec-domain .idmeta")) && !(await page.$("#sec-domain .hkchip")) && !(await page.$('#sec-domain [data-act="approve"]')), "kit field tagged «از کیت…», not a Hark suggestion");
    ok(await page.$("#sec-tone .hkchip"), "untouched Hark draft (tone) stays a suggestion");
    ok(await page.$("#sec-other") && (await page.inputValue('#sec-other textarea[data-k="other_rules"]')) === "قوانین کیت", "«سایر (از کیت)» section shows kit notes");
    const names = await page.$$eval("#ida-list .asset b", (a) => a.map((e) => e.textContent));
    ok(names.length === 3 && names.includes("titan-logo.png") && names.includes("pack.zip") && names.includes("clip.mp4"), "3 kit files listed under the brand's files (" + names + ")");
    ok(await page.$('#ida-list .asset img.athumb[src^="data:image/png"]'), "logo thumbnail shown");
    ok(/از کیت/.test(await page.textContent("#ida-list")), "files tagged with the kit label");
    const zrow = await page.$$("#ida-list .asset");
    let zi = -1; for (let i = 0; i < names.length; i++) if (names[i] === "pack.zip") zi = i;
    await zrow[zi].$eval('[data-act="azip"]', (b) => b.click());
    ok(/imgs\/a\.png/.test(await zrow[zi].textContent()), "ZIP file list read by the bridge");
    await zrow[zi].$eval('[data-act="zimgs"]', (b) => b.click());
    ok(await until(() => page.$$eval("#ida-list .zgrid img", (a) => a.length === 2)), "ZIP images decrypt + open in the panel (Python-encrypted blob -> browser)");
    const li = names.indexOf("titan-logo.png");
    await zrow[li].$eval('[data-act="aview"]', (b) => b.click());
    ok(await until(() => page.$eval("#imgview img", (i) => i.naturalWidth === 300)), "logo decrypts and displays");
    await page.click('#imgview [data-x="close"]');
    const G = getId(R, P1);
    ok(G.fields.domain.kit && G.fields.slogan.by === "negin" && G.assets.length === 3, "mirror for Hark has the kit fields + files");
    ok(/wrote .*back\.png \(\d+ bytes/.test(bridge(R, ["get-identity-asset", P1, "titan-logo.png", path.join(TMP, "back.png")])) && fs.readFileSync(path.join(TMP, "back.png")).equals(fs.readFileSync(path.join(ASSETS, "titan-logo.png"))), "bridge round-trip of a kit file");
    await page.click("#id-copyall"); const clipT = await page.evaluate(() => navigator.clipboard.readText());
    ok(/قوانین کیت/.test(clipT) && !/\nحساب‌ها\n/.test(clipT) && /System prompt کیت/.test(clipT), "copy-all brief: kit rules + AI notes in, long notes out");
    // mobile 375
    const M = await device(browser, R, "iphone", { pw: P });
    await nav(M.page, base, "#/identity/" + P1, "#idsecs");
    await noOverflow(M.page, "kit-import-375");
    ok(!errors.length, "no page errors (" + errors.join(" | ") + ")");
  } catch (e) { fails.push("exception: " + (e && e.stack || e)); console.log(e); }
  await browser.close(); srv.close();
  console.log(`v13: ${checks - fails.length}/${checks} passed`);
  if (fails.length) { console.log("FAILED:\n- " + fails.join("\n- ")); process.exit(1); }
})();
