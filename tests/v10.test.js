// v10 end-to-end tests: «هویت» (brand identity) + edit/copy/history in «غربال‌گری» and «اسکریپت نهایی» (built on the v9 harness).
// usage: node tests/v10.test.js <fixture_dir> <media_dir>     (SP_SHOTS=<dir> saves screenshots)
//   fixture: python3 tests/make_fixture.py /tmp/fx $(date +%s000)      media: python3 tests/make_media.py /tmp/spmedia
// Headless Chromium (Playwright) at 390 px (mobile) and 1280 px (desktop). GitHub is replaced by an in-memory repo
// that implements the contents API (sha conflicts: 409/422), git blobs/trees/commits/refs, releases, workflow dispatch.
const { chromium } = require("playwright");
const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto"), cp = require("child_process");

const FX = process.argv[2], MEDIA = process.argv[3];
if (!FX || !MEDIA) { console.error("usage: node tests/v10.test.js <fixture_dir> <media_dir>"); process.exit(2); }
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
const TMP = fs.mkdtempSync("/tmp/spv10-");
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

(async () => {
  const BUF = { updated: new Date().toISOString(), pages: { [P1]: { status: "ok", channels: [{ id: "c1", name: config.pages[0].accounts.instagram, service: "instagram" }, { id: "c2", name: config.pages[0].accounts.tiktok, service: "tiktok" }],
    posts: [{ id: "bp1", text: "پست اول\nخط دوم", dueAt: new Date(Date.now() - 2 * 864e5).toISOString(), channelId: "c1", metricsUpdatedAt: new Date(Date.now() - 3600e3).toISOString(),
        metrics: [{ type: "views", value: 4564 }, { type: "reactions", value: 130 }, { type: "comments", value: 3 }, { type: "reach", value: 4196 }, { type: "shares", value: 63 }, { type: "saves", value: 34 }, { type: "totalTimeWatched", value: 662.66 }, { type: "engagementRate", value: 5.62 }] },
      { id: "bp2", text: "پست دوم", dueAt: new Date(Date.now() - 40 * 864e5).toISOString(), channelId: "c1", metricsUpdatedAt: new Date(Date.now() - 3600e3).toISOString(),
        metrics: [{ type: "views", value: 1943 }, { type: "reactions", value: 33 }, { type: "comments", value: 0 }, { type: "reach", value: 1810 }, { type: "engagementRate", value: 3.65 }] },
      { id: "bp3", text: "tiktok", dueAt: new Date(Date.now() - 864e5).toISOString(), channelId: "c2", metrics: [{ type: "views", value: 127 }] }] }, [P2]: { status: "error", error: "x" } } };
  const { srv, url: base } = await serve(FX, { "/app.js": patchedApp, "/data/buffer.json": JSON.stringify(BUF) });
  const browser = await chromium.launch();
  const R = new Repo();
  R.set("config/token.enc.json", await tokenEnc(P, TOKEN));
  R.set("config/hark_pub.json", testPub);
  try {
    const A = await device(browser, R, "desktop", { pw: P });
    const page = A.page;
    await A.ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base.replace(/\/$/, "") });
    const clip = () => page.evaluate(() => navigator.clipboard.readText());

    // ---------------------------------------------- top bar: «هویت» between the time box and the theme box
    R.set("config/yt_tokens.enc.json", { v: 1, channels: { ["UC" + "A".repeat(22)]: { page: P1, channel_id: "UC" + "A".repeat(22), title: "A", mismatch: false, connected_at: new Date(Date.now() - 3600e3).toISOString(), status: "ok", iv: "AA", ct: "BB" } } });
    await nav(page, base, "#/", "#topbar");
    const kids = await page.$$eval("#topbar > *", (a) => a.map((e) => e.id || e.className));
    ok(JSON.stringify(kids) === JSON.stringify(["refresh", "brand", "tbox", "idbtn", "theme"]), `topbar order: refresh, title, time, «هویت», theme (${kids})`);
    ok((await page.textContent("#idbtn")).trim() === "هویت", "«هویت» label");
    const bg = await page.$eval("#idbtn", (e) => getComputedStyle(e).backgroundImage);
    ok(/gradient/.test(bg), "«هویت» box is purple (gradient)");
    // channels order
    await hashTo(page, "#/channels", ".cgroup");
    const chOrder = await page.$$eval(".cgroup", (a) => a.map((e) => e.getAttribute("data-page")));
    await page.click("#idbtn"); await page.waitForSelector("#id-domains");
    ok(/^#\/identity$/.test(await page.evaluate(() => location.hash)), "«هویت» opens #/identity");
    const idOrder = await page.$$eval("#id-domains .dombox", (a) => a.map((e) => e.getAttribute("data-page")));
    ok(idOrder.length === 5 && JSON.stringify(idOrder) === JSON.stringify(chOrder), `identity list: 5 brands in the channels order (${idOrder})`);

    // ---------------------------------------------- pure functions
    const u = await page.evaluate(() => {
      const V = window.__spV10;
      let d = { fields: { slogan: { v: "user", at: "2026-11-17T12:00:00+03:30", by: "negin", src: "user" } } };
      d = V.applyIdentityOut(d, { id: "m1", created_at: "2026-11-17T11:00:00+03:30", fields: { slogan: { v: "hark-old", draft: true }, domain: "روانشناسی", nope: "x", colors: ["#abc", { name: "بنفش", hex: "7c3aed" }, "zz"] } });
      const keep = d.fields.slogan.v, dom = d.fields.domain, cols = d.fields.colors.v, nope = !!d.fields.nope;
      d = V.applyIdentityOut(d, { id: "m2", created_at: "2026-11-17T13:00:00+03:30", fields: { slogan: "hark-new" } });
      const newer = d.fields.slogan.v;
      d = V.applyIdentityOut(d, { id: "m2", created_at: "2026-11-17T14:00:00+03:30", fields: { slogan: "again" } });
      const brief = V.identityBrief({ name: "Titan Station" }, d);
      const scr = { id: "s1", title: "T", body: "B", script: { title: "S", hook: "H-old", text: "X" } };
      V.applyEdit(scr, { author: "amirhossein", note: "n1", script: { title: "S", hook: "H-new", text: "X" } }, "screen");
      return { keep, dom, cols, nope, newer, final: d.fields.slogan.v, brief, rev: scr.revisions, hook: scr.script.hook, ed: scr.edited_by, n: V.sections().length };
    });
    ok(u.keep === "user", "identity merge: a field the user edited later is not overwritten by Hark");
    ok(u.dom.v === "روانشناسی" && u.dom.src === "hark" && u.dom.draft === true && !u.nope, "identity merge: empty field filled as a Hark draft; unknown keys ignored");
    ok(JSON.stringify(u.cols) === JSON.stringify([{ name: "", hex: "#aabbcc" }, { name: "بنفش", hex: "#7c3aed" }]), "colors normalised to #rrggbb, invalid dropped");
    ok(u.newer === "hark-new" && u.final === "hark-new", "identity merge: a newer Hark value replaces an older one; idempotent by message id");
    ok(/شناسنامه‌ی برند «Titan Station»/.test(u.brief) && /## اسلوگان\nhark-new/.test(u.brief) && /بنفش: #7c3aed/.test(u.brief), "identityBrief: clean Persian brief");
    ok(u.n === 19, "19 identity sections");
    ok(u.hook === "H-new" && u.ed === "amirhossein" && u.rev.length === 1 && /H-old/.test(u.rev[0].prev_text) && u.rev[0].note === "n1", "applyEdit keeps who/when/note/previous text");

    // ---------------------------------------------- Hark -> panel identity drafts (bridge -> browser)
    const DRAFT = { fields: { slogan: { v: "ذهن آرام، زندگی روشن", draft: true }, domain: "روانشناسی کاربردی", pillars: ["سلامت روان", "روابط"],
      colors: { v: [{ name: "بنفش برند", hex: "#5b2a86" }], draft: true }, characters: [{ name: "تایتان", look: "ربات مهربان", personality: "آرام", prompt: "friendly robot" }] } };
    ok(/posted 5 identity field/.test(bridge(R, ["post-identity", P1, JSON.stringify(DRAFT)])), "bridge post-identity");
    ok(bridgeFails(R, ["post-identity", P1, '{"fields":{"nope":"x"}}']) !== false && bridgeFails(R, ["post-identity", P1, '{"fields":{"colors":["zz"]}}']) !== false, "bridge refuses unknown fields and bad colours");
    const outTxt = R.text(outFiles(R, P1)[0]);
    ok(!/ذهن|روانشناسی|identity/.test(outTxt), "identity outbox file is encrypted");
    // the brain merge must leave identity messages alone
    await hashTo(page, "#/brain/" + P1 + "/hark", "#blist");
    ok(outFiles(R, P1).length === 1, "«مغز متفکر» does not consume identity messages");
    await hashTo(page, "#/identity", "#id-domains"); await page.reload(); await page.waitForSelector("#id-domains");
    await until(() => outFiles(R, P1).length === 0);
    ok(outFiles(R, P1).length === 0, "identity page merged + deleted the outbox file");
    ok(/پیشنهاد هارک برای تأیید/.test(await page.textContent('#id-domains [data-page="' + P1 + '"]')), "brand box shows pending Hark drafts");
    await page.click('#id-domains [data-page="' + P1 + '"]'); await page.waitForSelector("#idsecs");
    ok((await page.$$("#idsecs .idsec")).length === 19, "brand page: 19 sections");
    ok(/پیشنهاد هارک — تأیید کن/.test(await page.textContent("#sec-slogan")) && await page.$("#sec-slogan .hkchip"), "Hark field marked «پیشنهاد هارک — تأیید کن»");
    const vraw = R.text("vault/identity-" + P1 + ".enc.json");
    ok(isEncFile(vraw) && !/ذهن|تایتان/.test(vraw), "identity stored encrypted in vault/identity-<page>.enc.json");
    const mir = idMirror(R, P1);
    ok(mir && !/ذهن|تایتان|slogan/.test(mir) && JSON.parse(mir).info === "sp-hark-id-v1" && JSON.parse(mir).kid === "testhark0000", "Hark mirror hark/identity/<page>.json encrypted to Hark (info sp-hark-id-v1)");
    let G = getId(R, P1);
    ok(G.fields.slogan.v === "ذهن آرام، زندگی روشن" && G.fields.slogan.src === "hark" && G.fields.characters.v[0].name === "تایتان", "bridge get-identity decrypts the mirror (JS -> Python)");
    // AAD bound to path
    R.set("hark/identity/" + P2 + ".json", mir);
    ok(bridgeFails(R, ["get-identity", P2]) !== false, "mirror copied to another page's path does not open");
    R.files.delete("hark/identity/" + P2 + ".json");

    // ---------------------------------------------- edit + save a section, approve, colours, characters
    await page.click("#sec-slogan > summary");
    await page.fill('#sec-slogan textarea[data-k="slogan"]', "ذهنت را بشناس");
    await page.click('#sec-slogan [data-act="save"]');
    await page.waitForFunction(() => /نگین/.test(document.querySelector("#sec-slogan .idmeta") && document.querySelector("#sec-slogan .idmeta").textContent));
    G = getId(R, P1);
    ok(G.fields.slogan.v === "ذهنت را بشناس" && G.fields.slogan.src === "user" && G.fields.slogan.by === "negin", "section save: stored as the user's edit and mirrored to Hark");
    // an older Hark value for the same field does not overwrite it
    bridge(R, ["post-identity", P1, JSON.stringify({ fields: { slogan: { v: "قدیمی", at: "2026-01-01T00:00:00+03:30" }, nature: "آموزشی و همدلانه" } })]);
    await page.reload(); await page.waitForSelector("#idsecs");
    await until(() => outFiles(R, P1).length === 0);
    G = getId(R, P1);
    ok(G.fields.slogan.v === "ذهنت را بشناس" && G.fields.nature.v === "آموزشی و همدلانه", "later user edit wins over an older Hark value; new field merged");
    await page.click("#sec-domain > summary");
    await page.click('#sec-domain [data-act="approve"]');
    await page.waitForFunction(() => !document.querySelector("#sec-domain .hkchip"));
    G = getId(R, P1);
    ok(G.fields.domain.src === "user" && G.fields.domain.from_hark === true, "«تأیید» turns a Hark draft into an approved field");
    await page.click("#sec-colors > summary");
    await page.click('#sec-colors [data-act="cadd"]');
    const rows = await page.$$("#sec-colors .crow");
    await rows[1].$(".hex").then((h) => h.fill("#F5A623"));
    await rows[1].$(".cname").then((h) => h.fill("طلایی"));
    ok(await rows[1].$eval('input[type="color"]', (e) => e.value) === "#f5a623", "hex field syncs the colour picker");
    await page.click('#sec-colors [data-act="save"]');
    await page.waitForFunction(() => !document.querySelector("#sec-colors .hkchip") && document.querySelectorAll("#sec-colors .swatches span").length === 2);
    G = getId(R, P1);
    ok(JSON.stringify(G.fields.colors.v) === JSON.stringify([{ name: "بنفش برند", hex: "#5b2a86" }, { name: "طلایی", hex: "#f5a623" }]), "colours saved with hex + name, swatches shown " + JSON.stringify(G.fields.colors));
    await page.click("#sec-characters > summary");
    await page.click('#sec-characters [data-act="chadd"]');
    const cb = (await page.$$("#sec-characters .charb"))[1];
    await (await cb.$(".c-name")).fill("دکتر نور"); await (await cb.$(".c-prompt")).fill("a calm psychologist, soft light");
    await page.click('#sec-characters [data-act="save"]');
    await page.waitForFunction(() => !document.querySelector("#sec-characters .hkchip"));
    G = getId(R, P1);
    ok(G.fields.characters.v.length === 2 && G.fields.characters.v[1].prompt === "a calm psychologist, soft light", "characters saved (name, look, personality, image prompt)");
    await page.click("#sec-ai > summary");
    await page.fill('#sec-ai textarea[data-k="ai_notes"]', "تو نویسنده‌ی محتوای Titan Station هستی.");
    await page.click('#sec-ai [data-act="save"]'); await page.waitForFunction(() => document.querySelector("#sec-ai .okchip"));
    await page.click('#sec-ai [data-act="copyai"]');
    ok(await until(async () => /نویسنده‌ی محتوای/.test(await clip())), "«کپی System prompt»");
    await page.click("#id-copyall");
    const all = await until(async () => { const t = await clip(); return /شناسنامه‌ی برند/.test(t) && t; });
    ok(all && /ذهنت را بشناس/.test(all) && /طلایی: #f5a623/.test(all) && /دکتر نور/.test(all) && /## ستون‌های محتوا|## چارچوب/.test(all) && !/undefined|null/.test(all), "«کپی کل شناسنامه برای ابزار AI» copies a clean Persian brief");

    // ---------------------------------------------- assets: image, font, ZIP (encrypted)
    await page.setInputFiles("#ida-file", [path.join(ASSETS, "titan-logo.png"), path.join(ASSETS, "BrandFont.ttf"), path.join(ASSETS, "pack.zip")]);
    await page.click("#ida-up");
    await page.waitForFunction(() => document.querySelectorAll("#ida-list .asset").length === 3, null, { timeout: 30000 });
    const al = await page.$$eval("#ida-list .asset", (a) => a.map((e) => e.querySelector("small").textContent));
    ok(al.some((t) => /لوگو/.test(t)) && al.some((t) => /فونت/.test(t)) && al.some((t) => /ZIP/.test(t) && /۳ فایل داخل ZIP/.test(t)), `assets listed with kinds (${al.join(" | ")})`);
    ok(R.refs.has("identity-assets"), "assets committed to the identity-assets branch");
    const png = fs.readFileSync(path.join(ASSETS, "titan-logo.png"));
    ok([...R.blobs.values()].every((b) => !b.includes(png.subarray(0, 8)) && !b.includes(Buffer.from("brand pack"))), "uploaded blobs are encrypted (no PNG signature / ZIP text)");
    G = getId(R, P1);
    ok(G.assets.length === 3 && G.assets.every((a) => !a.k) && G.assets.find((a) => a.kind === "zip").zip.length === 3, "get-identity lists asset names (keys hidden in --json)");
    const outPng = path.join(TMP, "back.png");
    bridge(R, ["get-identity-asset", P1, "titan-logo.png", outPng]);
    ok(fs.readFileSync(outPng).equals(png), "bridge get-identity-asset decrypts a file byte-identical");
    const logoRow = await page.$('.asset:has(b:text-is("titan-logo.png"))');
    await (await logoRow.$('[data-act="aview"]')).click();
    await page.waitForSelector("#imgview img");
    ok(await page.$eval("#imgview img", (i) => i.complete && i.naturalWidth === 300), "«نمایش» decrypts and shows the image");
    await page.click('#imgview [data-x="close"]');
    const zipRow = await page.$('.asset:has(b:text-is("pack.zip"))');
    await (await zipRow.$('[data-act="azip"]')).click();
    ok(/imgs\/a\.png/.test(await zipRow.$eval(".ziplist", (e) => e.textContent)), "ZIP contents listed");
    await (await zipRow.$('[data-act="zimgs"]')).click();
    await page.waitForFunction(() => document.querySelectorAll(".zgrid .zimg img").length === 2, null, { timeout: 20000 });
    ok(true, "images inside the ZIP shown (2)");
    await noOverflow(page, "1280 identity brand");
    const fontRow = await page.$('.asset:has(b:text-is("BrandFont.ttf"))');
    await (await fontRow.$('[data-act="adel"]')).click();
    await page.waitForFunction(() => document.querySelectorAll("#ida-list .asset").length === 2);
    ok(getId(R, P1).assets.length === 2, "asset delete");

    // ---------------------------------------------- brain: edit / copy / history in «غربال‌گری» + «اسکریپت نهایی»
    bridge(R, ["post-ideas", P1, JSON.stringify([{ id: "hE", title: "ایده برای ویرایش", body: "متن اولیه" }, { id: "hQ", title: "ایده‌ی در صف", body: "صف" }])]);
    await hashTo(page, "#/brain/" + P1 + "/hark", "#b-hE");
    await page.click('#b-hE [data-act="screen"]'); await until(() => reqFiles(R).length === 1);
    await page.waitForFunction(() => /فرستاده شد/.test(document.querySelector("#b-hE .iact").textContent));
    await page.click('#b-hQ [data-act="screen"]'); await until(() => reqFiles(R).length === 2);
    await page.waitForFunction(() => /فرستاده شد/.test(document.querySelector("#b-hQ .iact").textContent));
    const rq = listReq(R).find((r) => r.title === "ایده برای ویرایش"), rqQ = listReq(R).find((r) => r.title === "ایده‌ی در صف");
    bridge(R, ["post-script", rq.id, JSON.stringify({ title: "اسکریپت اصلی", hook: "هوک قدیمی", beats: ["بیت ۱"], cta: "فالو کن", text: "متن کامل", caption: "کپشن", hashtags: ["#تست"], platforms: { reels: "۳۰ ثانیه" } })]);
    await hashTo(page, "#/brain/" + P1 + "/idea", "#bnew"); await hashTo(page, "#/brain/" + P1 + "/screen", ".sitem");
    await until(() => page.$eval("#b-" + rq.screen_id + " .schip", (e) => e.textContent === "اسکریپت آماده"));
    const S = "#b-" + rq.screen_id;
    const sb = await page.$$eval(S + " .iact button", (a) => a.map((b) => b.textContent));
    ok(sb.includes("ویرایش") && sb.includes("کپی"), `screening item has «ویرایش» + «کپی» (${sb})`);
    ok((await page.$$eval("#b-" + rqQ.screen_id + " .iact button", (a) => a.map((b) => b.textContent))).includes("ویرایش"), "queued screening item has «ویرایش» too");
    await page.click(S + ' [data-act="copy"]');
    ok(await until(async () => /هوک قدیمی/.test(await clip())), "«کپی» on a screening script copies the paste-ready text");
    await page.click(S + ' [data-act="edit"]'); await page.waitForSelector(S + " .edform");
    ok((await page.$$(S + ' .edform input[type="radio"]')).length === 2, "edit form: author picker نگین/امیرحسین");
    await page.check(S + ' .edform input[value="amirhossein"]');
    await page.fill(S + ' [data-f="hook"]', "هوک تازه‌ی امیرحسین");
    await page.fill(S + ' [data-f="note"]', "هوک کوتاه‌تر شد");
    await page.click(S + ' [data-act="esave"]');
    await page.waitForFunction((s) => /هوک تازه/.test(document.querySelector(s + " .scr").textContent), S);
    const em = await page.$eval(S, (e) => ({ meta: e.querySelector(".edmeta").textContent, hist: Array.from(e.querySelectorAll(".iact button")).map((b) => b.textContent).find((t) => /تاریخچه/.test(t)) }));
    ok(/امیرحسین/.test(em.meta) && /هوک کوتاه‌تر شد/.test(em.meta) && /تاریخچه \(۱\)/.test(em.hist || ""), "after «ثبت اصلاحات»: last-edit line (who, note) + «تاریخچه (۱)»");
    await page.click(S + ' [data-act="hist"]');
    ok(await page.$eval(S + " .revs", (e) => !e.hidden && /هوک قدیمی/.test(e.textContent) && /هوک کوتاه‌تر شد/.test(e.textContent)), "«تاریخچه» shows the previous text + note");
    ok(!/هوک تازه/.test(R.text("vault/brain-" + P1 + ".enc.json")), "edits stored encrypted");
    await page.click(S + ' [data-act="copy"]');
    ok(await until(async () => { const t = await clip(); return /هوک تازه/.test(t) && !/هوک قدیمی/.test(t); }), "«کپی» copies the latest edited version");
    // queued item: edit the idea
    const Q = "#b-" + rqQ.screen_id;
    await page.click(Q + ' [data-act="edit"]'); await page.fill(Q + ' [data-f="body"]', "متن صف اصلاح‌شده"); await page.click(Q + ' [data-act="esave"]');
    await page.waitForFunction((q) => document.querySelector(q + " .edmeta"), Q);
    await page.click(Q + ' [data-act="copy"]');
    ok(await until(async () => /متن صف اصلاح‌شده/.test(await clip())), "queued item: idea edit + copy");
    // approve -> final carries the edit
    await page.click(S + ' [data-act="approve"]');
    await page.waitForFunction(() => /\/final\?focus=/.test(location.hash) && document.querySelector(".fitem.focus"));
    ok(/هوک تازه/.test(await page.textContent(".fitem.focus .ibody")), "approved final script uses the edited version");
    const F = ".fitem.focus";
    await page.click(F + ' [data-act="edit"]'); await page.waitForSelector(F + " .edform");
    await page.fill(F + ' [data-f="cta"]', "CTA نهایی نگین"); await page.fill(F + ' [data-f="note"]', "CTA عوض شد");
    await page.click(F + ' [data-act="esave"]');
    await page.waitForFunction(() => /CTA نهایی نگین/.test(document.querySelector(".fitem .ibody").textContent));
    await page.click('.fitem [data-act="copy"]');
    ok(await until(async () => /CTA نهایی نگین/.test(await clip())), "final «کپی» copies the edited text");
    await page.click('.ptool[data-tool="claude"] [data-act="send"]');
    await page.waitForFunction(() => /در صف ساخت/.test(document.querySelector('.ptool[data-tool="claude"]').textContent), null, { timeout: 20000 });
    const pj = listReq(R).find((r) => r.type === "produce");
    ok(pj && /CTA نهایی نگین/.test(pj.script_text) && pj.script.cta === "CTA نهایی نگین" && /هوک تازه/.test(pj.script_text), "produce request carries the latest edited version");
    await page.click('.fitem [data-act="hist"]');
    ok(await page.$eval(".fitem .revs", (e) => !e.hidden && /CTA عوض شد/.test(e.textContent) && /فالو کن/.test(e.textContent)), "final «تاریخچه»");


    // ---------------------------------------------- publish: every unresolved / failed channel gets a final resolution
    const QN = "queue/20261115-231717-test.json";
    const OLDYT = "برای یوتیوب Secretهای YT_CLIENT_ID، YT_CLIENT_SECRET و YT_REFRESH_TOKEN_X لازم است.";
    R.set(QN, { id: "20261115-231717-test", created_at: "2026-11-15T23:17:17+03:30", publish_at: "2026-11-15T23:17:17+03:30", title: "جهان به هیچ نمی‌ارزد", caption: "c",
      targets: [{ page: P1, platform: "youtube" }, { page: P1, platform: "instagram", manual: true }, { page: P1, platform: "aparat" }, { page: P1, platform: "tiktok" }],
      media: { type: "video/mp4", name: "x.mp4" }, asset_url: "https://example.invalid/x.mp4", status: "needs_setup",
      results: { [P1 + "/youtube"]: { status: "needs_setup", reason: OLDYT }, [P1 + "/instagram"]: { status: "manual", reason: "نیاز به اتصال / انتشار دستی" },
        [P1 + "/aparat"]: { status: "needs_setup", reason: "آپارات…" }, [P1 + "/tiktok"]: { status: "failed", reason: "بعد از 3 تلاش ناموفق ماند: HTTP 500" } } });
    await hashTo(page, "#/publish", "#jobs .job");
    const J = '#job-20261115-231717-test';
    await page.waitForSelector(J);
    const rowsP = await page.$$eval(J + " .jtargets li", (a) => a.map((li) => ({ k: li.getAttribute("data-key"), chip: li.querySelector(".schip").textContent, txt: li.textContent, btns: Array.from(li.querySelectorAll("button")).map((b) => b.textContent) })));
    const ytRow = rowsP.find((x) => /youtube/.test(x.k)), igRow = rowsP.find((x) => /instagram/.test(x.k)), apRow = rowsP.find((x) => /aparat/.test(x.k)), ttRow = rowsP.find((x) => /tiktok/.test(x.k));
    ok(ytRow.chip === "اتصال برقرار نیست" && /حالا متصل است/.test(ytRow.txt) && /تلاش دوباره/.test(ytRow.txt) && !/YT_REFRESH_TOKEN/.test(ytRow.txt), `publish: YouTube row shows the real cause, not the old secret message (${ytRow.txt})`);
    ok(/از طریق بافر/.test(igRow.txt) && /اتصال برقرار نیست/.test(igRow.chip), "publish: Instagram row: «اتصال برقرار نیست» + Buffer route named");
    ok(/API عمومی/.test(apRow.txt) && /دستی منتشر کردم/.test(apRow.txt), "publish: Aparat row reason + fix");
    ok([ytRow, igRow, apRow, ttRow].every((x) => JSON.stringify(x.btns) === JSON.stringify(["تلاش دوباره", "دستی منتشر کردم ✓", "لغو / ناموفق"])), "publish: every unresolved/failed row has the 3 resolution buttons");
    ok(/نیاز به اقدام/.test(await page.textContent(J + " .jh .schip")), "publish: job chip «نیاز به اقدام» while a channel is unresolved");
    await page.click(J + ' li[data-key="' + P1 + '/youtube"] [data-jact="retry"]');
    await until(() => (R.json(QN).results[P1 + "/youtube"] || {}).status === "queued");
    let qj = R.json(QN);
    ok(qj.status === "pending" && qj.results[P1 + "/youtube"].attempts === 0 && qj.results[P1 + "/youtube"].prev_reason === OLDYT && R.dispatches.some((d) => d.wf === "publish.yml"), "«تلاش دوباره»: channel re-queued, job pending, publish.yml dispatched");
    await page.waitForSelector(J + ' li[data-key="' + P1 + '/instagram"] [data-jact="manual"]');
    await page.click(J + ' li[data-key="' + P1 + '/instagram"] [data-jact="manual"]');
    await until(() => (R.json(QN).results[P1 + "/instagram"] || {}).status === "published");
    await page.waitForSelector(J + ' li[data-key="' + P1 + '/aparat"] [data-jact="giveup"]');
    await page.click(J + ' li[data-key="' + P1 + '/aparat"] [data-jact="giveup"]');
    await until(() => (R.json(QN).results[P1 + "/aparat"] || {}).status === "failed");
    await page.waitForSelector(J + ' li[data-key="' + P1 + '/tiktok"] [data-jact="giveup"]');
    await page.click(J + ' li[data-key="' + P1 + '/tiktok"] [data-jact="giveup"]');
    await until(() => (R.json(QN).results[P1 + "/tiktok"] || {}).resolved_by === "panel");
    qj = R.json(QN);
    ok(qj.results[P1 + "/aparat"].resolved_by === "panel" && /لغو \/ ناموفق/.test(qj.results[P1 + "/aparat"].reason) && qj.results[P1 + "/instagram"].manual, "«لغو / ناموفق» and «دستی منتشر کردم ✓» recorded");
    ok(qj.status === "pending", "job still pending while YouTube retries");
    qj.results[P1 + "/youtube"] = { status: "published", url: "https://www.youtube.com/watch?v=y", attempts: 1 }; qj.status = "partial"; R.set(QN, qj);
    await page.click("#reloadjobs"); await page.waitForFunction((j) => /جزئی/.test(document.querySelector(j + " .jh .schip").textContent), J);
    ok(!(await page.$(J + " [data-jact]")), "publish: all channels resolved -> final «جزئی», no open buttons left");
    await noOverflow(page, "1280 publish");


    // ---------------------------------------------- analytics: Instagram from Buffer metrics
    await hashTo(page, "#/a/" + P1 + "/instagram", "#summary");
    await page.click('#gfilter button[data-r="30d"]'); await page.waitForSelector('#summary[data-r="30d"]');
    const bk = await page.evaluate(() => ({ v: document.querySelector("#bufkpis") && document.querySelector("#bufkpis").getAttribute("data-views"), kp: document.querySelector("#bufkpis") && document.querySelector("#bufkpis").innerText, x: document.querySelector("#bufx") && document.querySelector("#bufx").innerText,
      gv: document.querySelector("#summary").getAttribute("data-gv"), rows: Array.from(document.querySelectorAll(".prow")).map((e) => e.getAttribute("data-gv")), body: document.body.innerText }));
    ok(bk.v === "6507" && /از بافر، به‌روز/.test(bk.kp), `Buffer: «کل بازدیدها» = sum of Buffer views + «(از بافر، به‌روز: …)» (${bk.v})`);
    ok(/۶٬۰۰۶/.test(bk.x) && /۶۳/.test(bk.x) && /۳۴/.test(bk.x) && /۶۶۳ دقیقه/.test(bk.x) && /۴٫۶٪/.test(bk.x), `Buffer: reach / shares / saves / watch time / eng. rate boxes (${bk.x})`);
    ok(bk.gv === "4564" && bk.rows.includes("4564"), `Buffer: 30-day «بازدید تازه» counts the post published in the window (single snapshot) (${bk.gv}, ${bk.rows})`);
    ok(!/فقط با دسترسی به خود اکانت|بدون اتصال رسمی/.test(bk.body), "Buffer: no «فقط با دسترسی…» / «بدون اتصال رسمی…» text on a Buffer channel");
    await noOverflow(page, "1280 analytics buffer");
    await hashTo(page, "#/a/" + P2 + "/instagram", "#app .ahead");
    await page.waitForTimeout(300);
    ok(!(await page.$("#bufkpis")), "a channel without Buffer keeps the old view");
    // ---------------------------------------------- channels: Buffer badge, desktop admin links
    await hashTo(page, "#/channels", ".cgroup");
    await page.click('.cbox[data-id="' + P1 + '"]'); await page.waitForSelector('.branch[data-page="' + P1 + '"]');
    ok(/متصل \(بافر\) ✓/.test(await page.textContent('.branch[data-page="' + P1 + '"][data-pl="instagram"]')) && /متصل \(بافر\) ✓/.test(await page.textContent('.branch[data-page="' + P1 + '"][data-pl="tiktok"]')), "channels: «متصل (بافر) ✓» on Instagram + TikTok");
    ok(!/بافر/.test(await page.textContent('.branch[data-page="' + P1 + '"][data-pl="youtube"]')) && /آمار و انتشار از طریق بافر/.test(await page.textContent('.cgroup[data-page="' + P1 + '"]')), "channels: Buffer line explains what it enables");
    ok((await page.getAttribute('.branch[data-page="' + P1 + '"][data-pl="instagram"] a.adm', "href")).startsWith("https://www.instagram.com/accounts/login"), "desktop «ورود» keeps the web dashboard");
    ok((await page.$$(".cgroup .app-note")).length === 5 && /اینستا تا ۵ اکانت/.test(await page.textContent(".app-note")), "help line under each brand box");
    // phone: native apps
    {
      const I = await device(browser, R, "iphone", { pw: P });
      await nav(I.page, base, "#/channels", ".cgroup");
      await I.page.click('.cbox[data-id="' + P1 + '"]'); await I.page.waitForSelector('.branch[data-page="' + P1 + '"]');
      const hrefs = await I.page.$$eval('.branch[data-page="' + P1 + '"] a.adm', (a) => a.map((x) => [x.closest(".branch").getAttribute("data-pl"), x.getAttribute("href"), x.getAttribute("data-fallback"), x.getAttribute("target")]));
      const H = (pl) => hrefs.find((h) => h[0] === pl);
      const ig = config.pages[0].accounts.instagram, tt = String(config.pages[0].accounts.tiktok).replace(/^@/, "");
      ok(H("instagram")[1] === "instagram://user?username=" + ig && H("instagram")[2] === "https://www.instagram.com/" + ig + "/" && !H("instagram")[3], `iPhone: Instagram «ورود» opens the app (${H("instagram")})`);
      ok(H("tiktok")[1] === "https://www.tiktok.com/@" + tt, `iPhone: TikTok universal link (${H("tiktok")})`);
      ok(/^https:\/\/studio\.youtube\.com\//.test(H("youtube")[1]) && !/accounts\.google/.test(H("youtube")[1]), `iPhone: YouTube Studio app link (${H("youtube")})`);
      ok(/aparat\.com\/dashboard/.test(H("aparat")[1]), "iPhone: Aparat unchanged");
      await noOverflow(I.page, "375 iphone channels");
      await I.ctx.close();
    }
    // ---------------------------------------------- layout: 375 px light + dark, top bar fits
    for (const theme of ["light", "dark"]) {
      const M = await device(browser, R, "mobile", { pw: P, theme });
      await M.ctx.setDefaultTimeout(25000);
      await M.page.setViewportSize({ width: 375, height: 812 });
      for (const [h, sel] of [["#/", "#idbtn"], ["#/identity", "#id-domains"], ["#/identity/" + P1, "#idsecs"], ["#/brain/" + P1 + "/screen", ".sitem"], ["#/brain/" + P1 + "/final", ".fitem"]]) {
        await nav(M.page, base, h); await M.page.reload(); await M.page.waitForSelector(sel, { timeout: 25000 });
        if (h === "#/identity/" + P1) { for (const s of ["card", "colors", "characters"]) await M.page.click("#sec-" + s + " > summary"); await M.page.click('.asset:has(b:text-is("pack.zip")) [data-act="azip"]'); }
        if (/screen|final/.test(h)) { await M.page.click('.bitem [data-act="edit"]'); await M.page.waitForSelector(".edform"); await M.page.click('.bitem [data-act="hist"]').catch(() => {}); }
        const tb = await M.page.$$eval("#topbar > *", (a) => a.map((e) => { const r = e.getBoundingClientRect(); return [e.id || e.className, Math.round(r.left), Math.round(r.right), Math.round(r.width)]; }));
        const W = 375, sorted = tb.slice().sort((x, y) => x[1] - y[1]);
        const overlap = sorted.some((x, i) => i && x[1] < sorted[i - 1][2] - 0.5), inside = tb.every((x) => x[1] >= 0 && x[2] <= W);
        ok(!overlap && inside && tb.find((x) => x[0] === "idbtn")[3] >= 40, `375 ${theme} ${h}: top bar fits, no overlap (${JSON.stringify(tb)})`);
        await noOverflow(M.page, `375 ${theme} ${h}`);
      }
      await M.ctx.close();
    }
    await nav(page, base, "#/"); await page.reload(); await page.waitForSelector("#idbtn"); await noOverflow(page, "1280 home");
    await A.ctx.close();
  } catch (e) {
    fails.push("exception: " + (e && e.stack || e));
  } finally {
    await browser.close(); srv.close();
  }
  errors.forEach((e) => fails.push("page error: " + e));
  console.log(`v10: ${checks} checks, ${fails.length} failed`);
  fails.forEach((f) => console.log(" - " + f));
  process.exit(fails.length ? 1 : 0);
})();
