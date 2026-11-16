// v9 end-to-end tests: Hark channel + «پیشنهاد هارک / پیشنهاد ما / غربال‌گری / اسکریپت نهایی» (built on the v8 harness).
// usage: node tests/v9.test.js <fixture_dir> <media_dir>
//   fixture: python3 tests/make_fixture.py /tmp/fx $(date +%s000)      media: python3 tests/make_media.py /tmp/spmedia
// Headless Chromium (Playwright) at 390 px (mobile) and 1280 px (desktop). GitHub is replaced by an in-memory repo
// that implements the contents API (sha conflicts: 409/422), git blobs/trees/commits/refs, releases, workflow dispatch.
const { chromium } = require("playwright");
const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto"), cp = require("child_process");

const FX = process.argv[2], MEDIA = process.argv[3];
if (!FX || !MEDIA) { console.error("usage: node tests/v9.test.js <fixture_dir> <media_dir>"); process.exit(2); }
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
const VPS = { mobile: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, desktop: { viewport: { width: 1280, height: 900 } } };
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
const TMP = fs.mkdtempSync("/tmp/spv9-");
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
    // ---------------------------------------------- brain home: domains open on «پیشنهاد هارک», keys created
    await nav(page, base, "#/brain", "#brain-domains");
    ok((await page.$$("#brain-domains .dombox")).length === 5, "brain home: 5 domains");
    ok(/\/hark$/.test(await page.getAttribute('a.dombox[data-page="' + P1 + '"]', "href")), "brain home: a domain opens on «پیشنهاد هارک»");
    ok(/پیشنهاد هارک/.test(await page.textContent("#brain-domains")), "brain home: counts mention Hark ideas");
    ok(R.json("config/inbox_pub.json") && R.json("config/inbox_pub.json").jwk, "inbox public key published by the panel");
    // pure functions
    const u = await page.evaluate(() => {
      const V = window.__spV9, sc = { title: "T", hook: "H1", beats: ["b1", { t: "0:05", text: "b2" }], cta: "C", caption: "Cap", hashtags: ["a", "#b"], platforms: { reels: "30 s", shorts: { length: "45 s", note: "n" }, tiktok: "20 s" }, text: "FULL" };
      const txt = V.scriptText(sc, "x");
      let d = { items: [] };
      const m1 = { id: "o1", type: "ideas", ideas: [{ id: "h1", title: "a" }, { id: "h1", title: "dup" }, { title: "" }] };
      d = V.applyHarkOut(d, m1, "p"); d = V.applyHarkOut(d, m1, "p");
      d.final = [{ id: "f1", jobs: { claude: { id: "jNEW", state: "queued" } } }];
      d = V.applyHarkOut(d, { id: "o2", type: "job_result", final_id: "f1", tool: "claude", job_id: "jOLD", state: "done" }, "p");
      const keepNew = d.final[0].jobs.claude.id;
      d = V.applyHarkOut(d, { id: "o3", type: "job_result", final_id: "f1", tool: "claude", job_id: "jNEW", state: "error", reason: "r" }, "p");
      return { txt, hark: d.hark.length, keepNew, after: d.final[0].jobs.claude, tools: V.tools().map((t) => t[1]) };
    });
    ok(["H1", "1. b2".replace("1.", "2. [0:05]"), "CTA:", "FULL", "Cap", "#a #b", "Instagram Reels: 30 s", "YouTube Shorts: 45 s — n", "TikTok: 20 s"].every((s) => u.txt.includes(s)), "scriptText: hook, beats, CTA, text, caption, hashtags, per-platform lengths");
    ok(u.hark === 1, "applyHarkOut: idempotent, no duplicate idea ids, empty titles skipped");
    ok(u.keepNew === "jNEW" && u.after.state === "error" && u.after.reason === "r", "applyHarkOut: an old job result never overwrites a newer queued job");
    ok(JSON.stringify(u.tools) === JSON.stringify(["Claude", "Gemini", "Google AI Studio", "ChatGPT", "Hark", "Flow", "Muse"]), "production tools: the 7 tools in order");

    // ---------------------------------------------- Hark -> panel: ideas (python bridge -> browser)
    const IDEAS = [{ id: "hA", title: "ایده‌ی هارک الف", body: "خط ۱\nخط ۲", why: "ترند این هفته", networks: ["instagram", "tiktok"], format: "ریل" }, { id: "hB", title: "ایده‌ی هارک ب", body: "حذف می‌شود" }, { id: "hC", title: "ایده‌ی هارک ج", body: "منتقل می‌شود" }];
    const o1 = bridge(R, ["post-ideas", P1, "-"], JSON.stringify(IDEAS));
    ok(/posted 3 idea/.test(o1) && outFiles(R, P1).length === 1, "bridge post-ideas: one outbox file written");
    const outTxt = R.text(outFiles(R, P1)[0]);
    ok(!/هارک|ideas|instagram|ترند/.test(outTxt) && JSON.parse(outTxt).epk && JSON.parse(outTxt).kid === R.json("config/inbox_pub.json").kid, "outbox file is encrypted to the panel's inbox key (no plaintext)");
    // a tampered file and a path-swapped file must not be merged
    const o2 = bridge(R, ["post-ideas", P1, JSON.stringify([{ id: "hT", title: "tampered" }])]);
    const tamp = outFiles(R, P1).find((k) => !k.endsWith(path.basename(outFiles(R, P1)[0])) ) ;
    const tf = outFiles(R, P1).filter((k) => R.text(k) !== outTxt)[0]; const tj = R.json(tf); const cb = Buffer.from(tj.ct, "base64"); cb[3] ^= 1; tj.ct = cb.toString("base64"); R.set(tf, JSON.stringify(tj));
    R.set("hark/out/" + P2 + "/swapped.json", outTxt.replace(/"page": "[^"]+"/, '"page": "' + P2 + '"')); // valid ciphertext, wrong path
    await hashTo(page, "#/brain/" + P1 + "/hark", ".hitem");
    await until(async () => (await page.$$(".hitem")).length === 3);
    const tabs = await page.$$eval(".tabs .tab", (a) => a.map((x) => x.getAttribute("data-tab") + ":" + x.childNodes[0].textContent.trim()));
    ok(JSON.stringify(tabs) === JSON.stringify(["hark:پیشنهاد هارک", "idea:پیشنهاد ما", "screen:غربال‌گری", "final:اسکریپت نهایی", "scenario:سناریوها", "script:اسکریپت‌ها"]), `tabs in order (${tabs})`);
    ok((await page.$$(".hitem")).length === 3, "«پیشنهاد هارک»: 3 Hark ideas merged");
    ok(await until(() => outFiles(R, P1).length === 1), "merged outbox file deleted, tampered one left in place");
    ok(!(await page.textContent("#blist")).includes("tampered"), "tampered outbox item rejected");
    const first = await page.$eval("#b-hA", (e) => ({ body: e.querySelector(".ibody").innerText, why: e.querySelector(".why").textContent, btns: Array.from(e.querySelectorAll(".iact button")).map((b) => b.textContent), nets: e.querySelectorAll(".ntag").length }));
    ok(first.body === "خط ۱\nخط ۲" && /ترند/.test(first.why) && first.nets === 3, "Hark idea card: body with line breaks, why, networks/format");
    ok(JSON.stringify(first.btns) === JSON.stringify(["بفرست برای غربال‌گری", "انتقال به ایده‌های من", "حذف"]), `Hark idea card buttons (${first.btns})`);
    ok((await page.textContent("#cnt-hark")) === "۳", "tab count «پیشنهاد هارک»");
    const vraw = R.text("vault/brain-" + P1 + ".enc.json");
    ok(isEncFile(vraw) && !/هارک|"hA"/.test(vraw), "Hark ideas stored only inside the encrypted brain file");
    await hashTo(page, "#/brain/" + P2 + "/hark", "#blist");
    ok(/هنوز هارک/.test(await page.textContent("#blist")) && R.files.has("hark/out/" + P2 + "/swapped.json"), "path-swapped outbox file rejected (AAD = page/id)");
    R.files.delete("hark/out/" + P2 + "/swapped.json"); R.files.delete(tf);

    // ---------------------------------------------- send to screening, delete, move
    await hashTo(page, "#/brain/" + P1 + "/hark", ".hitem");
    await page.click('#b-hA [data-act="screen"]');
    await until(() => reqFiles(R).length === 1);
    await page.waitForFunction(() => /فرستاده شد/.test(document.querySelector("#b-hA .iact").textContent));
    const rq1 = R.text(reqFiles(R)[0]);
    ok(!/هارک|screen|titan|hamrah|خط/.test(rq1) && JSON.parse(rq1).kid === "testhark0000" && JSON.parse(rq1).epk, "screening request encrypted to Hark's key (no plaintext)");
    let L = listReq(R);
    ok(L.length === 1 && L[0].type === "screen" && L[0].title === "ایده‌ی هارک الف" && L[0].body === "خط ۱\nخط ۲" && L[0].page === P1 && /هوک/.test(L[0].brief) && L[0].screen_id, "bridge list-requests decrypts the browser's request (JS -> Python)");
    ok(/در غربال‌گری · در صف هارک/.test(await page.textContent("#b-hA .ilinks")), "Hark idea links to its screening item");
    await page.click('#b-hB [data-act="del"]');
    await until(async () => !(await page.$("#b-hB")));
    ok(!(await page.$("#b-hB")), "«حذف» removes a Hark idea");
    bridge(R, ["post-ideas", P1, JSON.stringify([{ id: "hB", title: "ایده‌ی هارک ب", body: "دوباره" }])]);
    await hashTo(page, "#/brain/" + P1 + "/idea", "#bnew"); await hashTo(page, "#/brain/" + P1 + "/hark", ".hitem");
    await until(() => outFiles(R, P1).length === 0);
    ok(!(await page.$("#b-hB")), "a deleted Hark idea does not come back when re-posted");
    await page.click('#b-hC [data-act="move"]');
    await page.waitForFunction(() => /\/idea\?focus=/.test(location.hash) && document.querySelector(".bitem.focus"));
    const moved = await page.$eval(".bitem.focus", (e) => ({ t: e.querySelector(".it").textContent, a: e.querySelector(".atag") && e.querySelector(".atag").textContent, send: !!e.querySelector('[data-act="screen"]') }));
    ok(moved.t === "ایده‌ی هارک ج" && moved.a === "هارک" && moved.send, `«انتقال به ایده‌های من» moves it into «پیشنهاد ما» (${JSON.stringify(moved)})`);
    ok((await page.textContent("#cnt-hark")) === "۱", "Hark tab count after delete + move");

    // ---------------------------------------------- «پیشنهاد ما»: author picker, send to screening
    await page.click("#bnew"); await page.waitForSelector("#bform");
    ok((await page.$$('input[name="bf-author"]')).length === 2 && await page.isChecked('input[name="bf-author"][value="negin"]'), "«پیشنهاد ما» form: author picker نگین/امیرحسین (default نگین)");
    await page.check('input[name="bf-author"][value="amirhossein"]');
    await page.fill("#bf-title", "ایده‌ی امیرحسین"); await page.fill("#bf-body", "متن ایده"); await page.click("#bf-save");
    await page.waitForFunction(() => Array.from(document.querySelectorAll(".bitem .it")).some((e) => e.textContent === "ایده‌ی امیرحسین"));
    const myCard = await page.$('.bitem:has(.it:text-is("ایده‌ی امیرحسین"))');
    ok((await myCard.$eval(".atag", (e) => e.textContent)) === "امیرحسین", "own idea shows its author");
    await (await myCard.$('[data-act="screen"]')).click();
    await until(() => reqFiles(R).length === 2);
    await page.waitForFunction(() => Array.from(document.querySelectorAll(".bitem")).some((c) => /ایده‌ی امیرحسین/.test(c.textContent) && /فرستاده شد/.test(c.textContent)));
    L = listReq(R);
    const rqOwn = L.find((r) => r.title === "ایده‌ی امیرحسین");
    ok(rqOwn && rqOwn.author === "امیرحسین" && rqOwn.source === "idea", "own idea sent to screening with its author");
    ok(await page.evaluate(() => localStorage.getItem("sp_author")) === '"amirhossein"', "author choice remembered on this device");

    // ---------------------------------------------- «غربال‌گری»: queued -> script ready -> approve
    await hashTo(page, "#/brain/" + P1 + "/screen", ".sitem");
    let st = await page.$$eval(".sitem", (a) => a.map((e) => [e.querySelector(".schip").textContent, e.querySelector('[data-act="approve"]').disabled]));
    ok(st.length === 2 && st.every((x) => x[0] === "در صف هارک" && x[1] === true), `screening: 2 items «در صف هارک», approve disabled (${JSON.stringify(st)})`);
    const rqA = L.find((r) => r.title === "ایده‌ی هارک الف");
    const SCRIPT = { title: "اسکریپت وایرال الف", hook: "صبر کن! این را تا حالا ندیدی", beats: [{ t: "0:03", text: "سؤال" }, { t: "0:08", text: "جواب غافلگیرکننده" }], cta: "فالو کن برای قسمت بعد", caption: "کپشن تست", hashtags: ["گربه", "#ریلز"], platforms: { reels: "۲۵ ثانیه", shorts: "۳۰ ثانیه", tiktok: "۲۱ ثانیه" }, text: "متن کامل\nخط دوم" };
    ok(/posted script/.test(bridge(R, ["post-script", rqA.id, JSON.stringify(SCRIPT)])), "bridge post-script");
    ok(bridgeFails(R, ["post-job-result", rqA.id, '{"state":"done"}']) !== false, "bridge refuses a job result for a screening request");
    await hashTo(page, "#/brain/" + P1 + "/idea", "#bnew"); await hashTo(page, "#/brain/" + P1 + "/screen", ".sitem");
    await until(() => page.$eval("#b-" + rqA.screen_id + " .schip", (e) => e.textContent === "اسکریپت آماده"));
    const ready = await page.$eval("#b-" + rqA.screen_id, (e) => ({ chip: e.querySelector(".schip").textContent, t: e.querySelector(".it").textContent, txt: e.querySelector(".scr").innerText, dis: e.querySelector('[data-act="approve"]').disabled, btn: e.querySelector('[data-act="approve"]').textContent }));
    ok(ready.chip === "اسکریپت آماده" && ready.t === "اسکریپت وایرال الف" && !ready.dis && ready.btn === "تأیید و انتقال به اسکریپت نهایی", "screening: «اسکریپت آماده», approve enabled");
    ok(["صبر کن", "جواب غافلگیرکننده", "فالو کن", "#گربه", "Instagram Reels", "TikTok", "کپشن تست"].every((s) => ready.txt.includes(s)), "screening: hook, beats, CTA, caption, hashtags, platform lengths shown");
    await page.click("#b-" + rqA.screen_id + ' [data-act="approve"]');
    await page.waitForFunction(() => /\/final\?focus=/.test(location.hash) && document.querySelector(".fitem.focus"));

    // ---------------------------------------------- «اسکریپت نهایی»: links, copy, send per tool, send all, results
    const fin = await page.$eval(".fitem.focus", (e) => ({ id: e.getAttribute("data-id"), rows: Array.from(e.querySelectorAll(".ptool")).map((r) => r.getAttribute("data-tool")), copy: !!e.querySelector('[data-act="copy"]'), all: !!e.querySelector('[data-act="sendall"]'), body: e.querySelector(".ibody").innerText }));
    ok(JSON.stringify(fin.rows) === JSON.stringify(["claude", "gemini", "aistudio", "chatgpt", "hark", "flow", "muse"]) && fin.copy && fin.all, "final: 7 tool rows + «کپی متن» + «ارسال به همه»");
    ok(/صبر کن/.test(fin.body) && /#ریلز/.test(fin.body), "final: the full paste-ready text");
    ok(await page.$eval("#tlinks", (e) => e.open), "final: project-link settings open while no link is set");
    await page.fill("#tl-claude", "https://claude.ai/project/titan-test"); await page.fill("#tl-muse", "muse.example.com/p/1");
    await page.click("#tl-save");
    await page.waitForFunction(() => /claude\.ai/.test(document.querySelector('.ptool[data-tool="claude"] small').textContent), null, { timeout: 20000 });
    ok(/muse\.example\.com/.test(await page.textContent('.ptool[data-tool="muse"] small')) && /تنظیم نشده/.test(await page.textContent('.ptool[data-tool="gemini"] small')), "final: per-domain project links saved (https added), missing ones flagged");
    ok(!/claude\.ai|muse\.example/.test(R.text("vault/brain-" + P1 + ".enc.json")), "project links stored encrypted");
    await page.click('.fitem [data-act="copy"]');
    const clip = await until(() => page.evaluate(() => navigator.clipboard.readText()).then((t) => /صبر کن/.test(t) && t));
    ok(clip && /CTA/.test(clip), "«کپی متن» copies the full script");
    const nReq = reqFiles(R).length;
    await page.click('.ptool[data-tool="claude"] [data-act="send"]');
    await page.waitForFunction(() => /در صف ساخت/.test(document.querySelector('.ptool[data-tool="claude"]').textContent), null, { timeout: 20000 });
    ok(reqFiles(R).length === nReq + 1 && await page.$eval('.ptool[data-tool="claude"] [data-act="send"]', (b) => b.disabled), "send to Claude: one request, «در صف ساخت», button locked");
    await page.click('.fitem [data-act="sendall"]');
    await page.waitForFunction(() => document.querySelectorAll(".ptool .j-queued").length === 7, null, { timeout: 20000 });
    ok(reqFiles(R).length === nReq + 7, `«ارسال به همه»: the 6 other tools queued (${reqFiles(R).length - nReq} requests)`);
    L = listReq(R);
    const jobs = L.filter((r) => r.type === "produce");
    const jc = jobs.find((j) => j.tool === "claude");
    ok(jobs.length === 7 && jc.project_url === "https://claude.ai/project/titan-test" && jc.final_id === fin.id && /صبر کن/.test(jc.script_text) && jc.gallery.brain_id === fin.id && jc.project_name === config.pages[0].name, "produce requests decrypt with tool, project link, script text and gallery hook");
    ok(jobs.find((j) => j.tool === "muse").project_url === "https://muse.example.com/p/1" && jobs.find((j) => j.tool === "gemini").project_url === "", "produce requests carry each tool's own link");
    ok(/posted job result/.test(bridge(R, ["post-job-result", jc.id, JSON.stringify({ state: "done", gallery_id: "g261116-130000-abcd", gallery_kind: "reel" })])), "bridge post-job-result done");
    const jg = jobs.find((j) => j.tool === "gemini");
    bridge(R, ["post-job-result", jg.id, JSON.stringify({ state: "error", reason: "سهمیه‌ی ساخت ویدئو تمام شده" })]);
    ok(bridgeFails(R, ["post-job-result", jg.id, '{"state":"error"}']) !== false, "bridge refuses an error result without a reason");
    await hashTo(page, "#/brain/" + P1 + "/idea", "#bnew"); await hashTo(page, "#/brain/" + P1 + "/final", ".fitem");
    await page.waitForSelector('.ptool[data-tool="claude"] .j-done', { timeout: 20000 });
    const cl = await page.$eval('.ptool[data-tool="claude"] .j-done', (a) => [a.textContent, a.getAttribute("href")]);
    ok(/ساخته شد/.test(cl[0]) && cl[1] === "#/gallery/" + P1 + "/reel?focus=g261116-130000-abcd", `job done -> «ساخته شد» links to the gallery item (${cl})`);
    const ge = await page.$eval('.ptool[data-tool="gemini"]', (e) => [e.querySelector(".jchip").textContent, e.querySelector(".jerr").textContent, e.querySelector("[data-act=send]").textContent]);
    ok(ge[0] === "خطا" && /سهمیه/.test(ge[1]) && ge[2] === "ارسال دوباره", "job error -> «خطا» with the reason + resend");
    ok(await page.$$eval(".ptool .j-queued", (a) => a.length) === 5, "other jobs still «در صف ساخت»");
    await hashTo(page, "#/brain/" + P1 + "/screen", ".sitem");
    ok(/تأیید شد/.test(await page.textContent("#b-" + rqA.screen_id + " .schip")) && /در اسکریپت نهایی/.test(await page.textContent("#b-" + rqA.screen_id)), "approved screening item links to its final script");
    // mark-done
    const ids = listReq(R).map((r) => r.id);
    bridge(R, ["mark-done", ...ids]);
    ok(reqFiles(R).length === 0, `bridge mark-done removes handled requests (${ids.length})`);
    ok(bridgeFails(R, ["post-ideas", "no-such-page", "[]"]) !== false, "bridge refuses an unknown page");

    // ---------------------------------------------- layout: 390 px light + dark, 1280 px
    for (const theme of ["light", "dark"]) {
      const M = await device(browser, R, "mobile", { pw: P, theme });
      bridge(R, ["post-ideas", P1, JSON.stringify([{ title: "یک عنوان خیلی خیلی بلند برای امتحان شکستن خط در صفحه‌ی موبایل آیفون بدون اسکرول افقی", body: "x".repeat(400), why: "y" }])]);
      for (const [h, sel] of [["#/brain", "#brain-domains"], ["#/brain/" + P1 + "/hark", ".hitem"], ["#/brain/" + P1 + "/idea", ".bitem"], ["#/brain/" + P1 + "/screen", ".sitem"], ["#/brain/" + P1 + "/final", ".fitem"]]) {
        await nav(M.page, base, h); await M.page.reload(); await M.page.waitForSelector(sel, { timeout: 25000 });
        await noOverflow(M.page, `390 ${theme} ${h}`);
      }
      const btn = await M.page.$eval('.ptool [data-act="send"]', (b) => b.getBoundingClientRect().height);
      ok(btn >= 34, `390 ${theme}: tool send buttons tappable (${btn}px)`);
      await M.ctx.close();
    }
    for (const [h, sel] of [["#/brain/" + P1 + "/hark", ".hitem"], ["#/brain/" + P1 + "/final", ".fitem"]]) { await nav(page, base, h); await page.reload(); await page.waitForSelector(sel, { timeout: 20000 }); await noOverflow(page, "1280 " + h); }
    // panel without hark_pub.json: a clear error, nothing written
    R.files.delete("config/hark_pub.json");
    const N = await device(browser, R, "desktop", { pw: P });
    await nav(N.page, base, "#/brain/" + P1 + "/hark", ".hitem");
    const n0 = reqFiles(R).length;
    await N.page.click('.hitem [data-act="screen"]');
    await until(() => N.page.evaluate(() => /کلید عمومی هارک/.test(document.body.textContent)));
    ok(/کلید عمومی هارک/.test(await N.page.textContent("body")) && reqFiles(R).length === n0, "no Hark public key -> clear error, nothing sent");
    await N.ctx.close(); await A.ctx.close();
  } catch (e) {
    fails.push("exception: " + (e && e.stack || e));
  } finally {
    await browser.close(); srv.close();
  }
  errors.forEach((e) => fails.push("page error: " + e));
  console.log(`v9: ${checks} checks, ${fails.length} failed`);
  fails.forEach((f) => console.log(" - " + f));
  process.exit(fails.length ? 1 : 0);
})();
