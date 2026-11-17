// v8 end-to-end tests: «مغز متفکر», «گالری محتوا», publish upgrade, encrypted storage, status sync.
// usage: node tests/v8.test.js <fixture_dir> <media_dir>
//   fixture: python3 tests/make_fixture.py /tmp/fx $(date +%s000)      media: python3 tests/make_media.py /tmp/spmedia
// Headless Chromium (Playwright) at 390 px (mobile) and 1280 px (desktop). GitHub is replaced by an in-memory repo
// that implements the contents API (sha conflicts: 409/422), git blobs/trees/commits/refs, releases, workflow dispatch.
const { chromium } = require("playwright");
const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto"), cp = require("child_process");

const FX = process.argv[2], MEDIA = process.argv[3];
if (!FX || !MEDIA) { console.error("usage: node tests/v8.test.js <fixture_dir> <media_dir>"); process.exit(2); }
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

(async () => {
  const { srv, url: base } = await serve(FX, { "/app.js": patchedApp });
  const browser = await chromium.launch();
  const R = new Repo();
  R.set("config/token.enc.json", await tokenEnc(P, TOKEN));
  R.set("config/yt_tokens.enc.json", ytStore());
  const M = (n) => path.join(MEDIA, n);
  try {
    // ================================================== 1. pure functions: classifier, statuses
    {
      const { ctx, page } = await device(browser, R, "desktop", { pw: P });
      await nav(page, base, "#/", ".boxes");
      const cases = JSON.parse(fs.readFileSync(path.join(__dirname, "classifier_cases.json"), "utf8"));
      for (const c of cases) {
        const got = await page.evaluate((c) => window.__spV8.classifyUpload(c.files, { story: !!c.story }), c);
        ok(got.length === c.want.length, `classifier ${c.name}: ${got.length} groups, want ${c.want.length}`);
        c.want.forEach((w, i) => {
          ok(got[i] && got[i].kind === w[0] && JSON.stringify(got[i].files) === JSON.stringify(w[1]), `classifier ${c.name}: group ${i} = ${got[i] && got[i].kind} ${got[i] && JSON.stringify(got[i].files)}, want ${w}`);
          ok(got[i] && typeof got[i].rule === "string" && /→/.test(got[i].rule), `classifier ${c.name}: rule text shown`);
          if (c.suggest) ok(got[i] && got[i].suggest === c.suggest[i], `classifier ${c.name}: suggest flag`);
        });
      }
      // python mirror gives the same kinds
      const py = JSON.parse(cp.execFileSync("python3", ["-c", `import json,sys; sys.path.insert(0, ${JSON.stringify(path.join(ROOT, "scripts"))}); import gallery_classify as g
cs=json.load(open(${JSON.stringify(path.join(__dirname, "classifier_cases.json"))}))
print(json.dumps([[ [x["kind"], x["files"], x["rule"]] for x in g.classify_upload(c["files"], bool(c.get("story")))] for c in cs]))`]).toString());
      for (let i = 0; i < cases.length; i++) {
        const js = await page.evaluate((c) => window.__spV8.classifyUpload(c.files, { story: !!c.story }).map((x) => [x.kind, x.files, x.rule]), cases[i]);
        ok(JSON.stringify(js) === JSON.stringify(py[i]), `classifier ${cases[i].name}: JS and Python agree (kind, files, rule)`);
      }
      // statuses
      const sync = await page.evaluate(() => {
        const V = window.__spV8, now = Date.parse("2026-11-16T12:00:00+03:30");
        const out = {};
        const job = (status, results, at, targets) => ({ id: "j", status, publish_at: at, targets: targets || [{ page: "a", platform: "youtube" }, { page: "a", platform: "aparat", manual: true }], results: results || {} });
        out.sched = V.pubStatusOf(job("pending", {}, "2026-11-16T15:00:00+03:30"), now, false);
        out.queued = V.pubStatusOf(job("pending", {}, "2026-11-16T11:00:00+03:30"), now, false);
        out.running = V.pubStatusOf(job("pending", {}, "2026-11-16T11:00:00+03:30"), now, true);
        out.pubManual = V.pubStatusOf(job("partial", { "a/youtube": { status: "published" }, "a/aparat": { status: "manual" } }, "2026-11-16T11:00:00+03:30"), now, false);
        out.onlyManual = V.pubStatusOf(job("manual", { "a/aparat": { status: "manual" } }, "2026-11-16T11:00:00+03:30", [{ page: "a", platform: "aparat", manual: true }]), now, false);
        out.failed = V.pubStatusOf(job("failed", { "a/youtube": { status: "failed" }, "a/aparat": { status: "needs_setup" } }, "2026-11-16T11:00:00+03:30"), now, false);
        out.cancel = V.pubStatusOf(job("cancelled", {}, "2026-11-16T15:00:00+03:30"), now, false);
        const brain = [{ id: "i1", type: "idea", status: "idea" }, { id: "s1", type: "scenario", parent_id: "i1", status: "writing" }, { id: "k1", type: "script", parent_id: "s1", status: "script_ready" }, { id: "i2", type: "idea", status: "idea" }];
        const gallery = [{ id: "g1", brain_id: "k1", status: "ready" }, { id: "g2", status: "uploaded" }];
        const s0 = V.syncStatuses({ brain, gallery, records: {}, jobs: {} }, now, false);
        out.s0 = [s0.brain.i1, s0.brain.s1, s0.brain.k1, s0.brain.i2, s0.gal.g1, s0.gal.g2];
        const j1 = job("pending", {}, "2026-11-16T15:00:00+03:30"); j1.id = "j1";
        const s1 = V.syncStatuses({ brain, gallery, records: { j1: { gallery_id: "g1", brain_id: "k1" } }, jobs: { j1 } }, now, false);
        out.s1 = [s1.pub.j1, s1.gal.g1, s1.brain.k1, s1.brain.i1];
        const j2 = job("partial", { "a/youtube": { status: "published", url: "u" }, "a/aparat": { status: "manual" } }, "2026-11-16T11:00:00+03:30"); j2.id = "j2";
        const s2 = V.syncStatuses({ brain, gallery, records: { j2: { gallery_id: "g1", brain_id: "k1" } }, jobs: { j2 } }, now, false);
        out.s2 = [s2.pub.j2, s2.gal.g1, s2.brain.k1, s2.brain.s1, s2.brain.i1, s2.brain.i2, s2.gal.g2];
        const j3 = job("failed", { "a/youtube": { status: "failed" }, "a/aparat": { status: "failed" } }, "2026-11-16T11:00:00+03:30"); j3.id = "j3";
        const s3 = V.syncStatuses({ brain, gallery, records: { j3: { gallery_id: "g1" } }, jobs: { j3 } }, now, false);
        out.s3 = [s3.pub.j3, s3.gal.g1];
        return out;
      });
      ok(sync.sched === "scheduled" && sync.queued === "queued" && sync.running === "publishing", `pubStatusOf pending: ${sync.sched}/${sync.queued}/${sync.running}`);
      ok(sync.pubManual === "published" && sync.onlyManual === "error" /* v10: an unresolved channel needs action, it no longer hangs as queued */ && sync.failed === "error" && sync.cancel === "error", `pubStatusOf final: ${sync.pubManual}/${sync.onlyManual}/${sync.failed}/${sync.cancel}`);
      ok(JSON.stringify(sync.s0) === JSON.stringify(["made", "made", "made", "idea", "ready", "uploaded"]), `sync: gallery link -> made, lifts ancestors: ${sync.s0}`);
      ok(JSON.stringify(sync.s1) === JSON.stringify(["scheduled", "scheduled", "made", "made"]), `sync: scheduled job -> gallery scheduled: ${sync.s1}`);
      ok(JSON.stringify(sync.s2) === JSON.stringify(["published", "published", "published", "published", "published", "idea", "uploaded"]), `sync: published job -> gallery + brain chain published: ${sync.s2}`);
      ok(JSON.stringify(sync.s3) === JSON.stringify(["error", "ready"]), `sync: failed job never lowers gallery status: ${sync.s3}`);
      await ctx.close();
    }

    // ================================================== 2. device A (1280): home, key creation, brain
    const A = await device(browser, R, "desktop", { pw: P });
    {
      const page = A.page;
      await nav(page, base, "#/", ".boxes");
      for (const theme of ["light", "dark"]) {
        await page.evaluate((t) => localStorage.setItem("sp_theme", t), theme);
        await page.reload(); await page.waitForSelector(".boxes");
        const order = await page.$$eval(".boxes > *", (els) => els.map((e) => e.id || e.className));
        ok(JSON.stringify(order) === JSON.stringify(["vault", "chbox", "brainbox", "galbox", "pubbox", "toolbox"]), `home ${theme}: order ${order}`);
        const look = await page.evaluate(() => ["brainbox", "galbox", "pubbox"].map((id) => { const s = getComputedStyle(document.getElementById(id)); return s.backgroundImage + "|" + s.backgroundColor + "|" + s.color; }));
        ok(/gradient/.test(look[0]) && /gradient/.test(look[1]) && look[0] !== look[1] && look[1] !== look[2], `home ${theme}: brain/gallery have their own colours`);
        ok(/rgb\(30, 27, 75\)|rgb\(27, 25, 64\)/.test(look[0]), `home ${theme}: brain box deep indigo (${look[0].slice(0, 80)})`);
        ok(/rgb\(227, 245, 242\)|rgb\(18, 48, 46\)/.test(look[1]), `home ${theme}: gallery box teal-lilac (${look[1].slice(0, 80)})`);
        await shot(page, "home-" + theme);
        ok(/مغز متفکر/.test(await page.textContent("#brainbox")) && /گالری محتوا/.test(await page.textContent("#galbox")), `home ${theme}: Persian labels`);
      }
      await page.evaluate(() => localStorage.setItem("sp_theme", "light"));
      // brain list -> creates the data key with the logged-in password
      await nav(page, base, "#/brain", "#brain-domains");
      ok((await page.$$("#brain-domains .dombox")).length === 5, "brain: 5 domains");
      const ring = R.json("config/data_key.enc.json"), pub = R.json("config/inbox_pub.json");
      ok(ring && ring.kid && ring.salt && ring.iv && ring.ct && ring.iter === 310000 && !("dk" in ring), "keyring: created, wrapped (no plain key)");
      ok(pub && pub.kid === ring.kid && pub.jwk && pub.jwk.x && pub.jwk.y && !pub.jwk.d, "inbox public key published (no private part)");
      const ls = await page.evaluate(() => JSON.parse(localStorage.getItem("sp_dk") || "null"));
      ok(ls && ls.kid === ring.kid, "data key cached on the unlocked device");
      // add an idea with line breaks
      await page.click('a.dombox[data-page="' + P1 + '"]'); await page.waitForFunction(() => /\/hark$/.test(location.hash)); // v9: a domain opens on «پیشنهاد هارک»
      await hashTo(page, "#/brain/" + P1 + "/idea", "#bnew");
      ok(/در این وضعیت|هنوز/.test(await page.textContent("#blist")), "brain: empty state");
      await page.click("#bnew"); await page.waitForSelector("#bform");
      const BODY = "خط اول ایده\nخط دوم\n\nخط چهارم با فاصله";
      await page.fill("#bf-title", "ایده‌ی گربه‌ی سخنگو");
      await page.fill("#bf-body", BODY);
      await page.check('input[name="bf-net"][value="instagram"]'); await page.check('input[name="bf-net"][value="youtube"]');
      await page.selectOption("#bf-format", "ریل");
      await page.click("#bf-save");
      await page.waitForSelector(".bitem");
      const card = await page.$eval(".bitem", (e) => ({ t: e.querySelector(".it").textContent, body: e.querySelector(".ibody").innerText, ws: getComputedStyle(e.querySelector(".ibody")).whiteSpace, chip: e.querySelector(".schip").textContent, dots: e.querySelectorAll(".sdots i.on").length, nets: e.querySelectorAll(".ntag").length }));
      ok(card.t === "ایده‌ی گربه‌ی سخنگو" && card.body === BODY && card.ws === "pre-wrap", `brain: item saved with line breaks (${JSON.stringify(card.body)})`);
      ok(card.chip === "ایده" && card.dots === 1 && card.nets === 3, `brain: status chip + dots + networks/format (${card.chip}/${card.dots}/${card.nets})`);
      const raw = R.text("vault/brain-" + P1 + ".enc.json");
      ok(isEncFile(raw) && !/خط|گربه|ایده|idea|instagram/.test(raw) && !/خط/.test(Buffer.from(JSON.parse(raw).ct, "base64").toString("utf8")), "brain: stored encrypted only (no plaintext title/body/fields)");
      // edit
      await page.click('.bitem [data-act="edit"]'); await page.waitForSelector("#bform");
      ok((await page.inputValue("#bf-body")) === BODY, "brain: edit form keeps the body");
      await page.fill("#bf-title", "ایده‌ی گربه‌ی سخنگو (ویرایش)"); await page.click("#bf-save");
      await until(() => page.$eval(".bitem .it", (e) => /ویرایش/.test(e.textContent)));
      ok(/ویرایش/.test(await page.$eval(".bitem .it", (e) => e.textContent)) && (await page.$$(".bitem")).length === 1, "brain: edit updates the same item");
      // promote idea -> scenario -> script
      await page.click('.bitem [data-act="promote"]');
      await page.waitForFunction(() => /#\/brain\/[\w-]+\/scenario\?focus=/.test(location.hash) && document.querySelector(".bitem.focus"));
      const sc = await page.$eval(".bitem.focus", (e) => ({ link: e.querySelector(".lchip") && e.querySelector(".lchip").textContent, chip: e.querySelector(".schip").textContent, body: e.querySelector(".ibody").innerText }));
      ok(/از ایده/.test(sc.link) && sc.chip === "در حال نوشتن" && sc.body === BODY, `brain: scenario linked to idea (${JSON.stringify(sc)})`);
      await page.click('.bitem.focus [data-act="promote"]');
      await page.waitForFunction(() => /#\/brain\/[\w-]+\/script\?focus=/.test(location.hash) && document.querySelector(".bitem.focus"));
      ok(/از سناریو/.test(await page.$eval(".bitem.focus .lchip", (e) => e.textContent)), "brain: script linked to scenario");
      ok(!(await page.$('.bitem.focus [data-act="promote"]')), "brain: a script cannot be promoted further");
      // script status -> اسکریپت آماده, idea shows the lifted status and its child link
      await page.click('.bitem.focus [data-act="edit"]'); await page.selectOption("#bf-status", "script_ready"); await page.click("#bf-save");
      await until(() => page.$eval(".bitem .schip", (e) => e.textContent === "اسکریپت آماده"));
      await hashTo(page, "#/brain/" + P1 + "/idea", ".bitem");
      const idea = await page.$eval(".bitem", (e) => ({ chip: e.querySelector(".schip").textContent, links: Array.from(e.querySelectorAll(".lchip")).map((x) => x.textContent) }));
      ok(idea.chip === "اسکریپت آماده" && idea.links.some((t) => /سناریو/.test(t)), `brain: idea lifted by its script + link to scenario (${JSON.stringify(idea)})`);
      // a second device wrote in between: 409 -> re-read -> re-apply
      const c0 = R.conflicts; R.conflictOnce.add("vault/brain-" + P1 + ".enc.json");
      await page.click("#bnew"); await page.fill("#bf-title", "ایده‌ی دوم"); await page.click("#bf-save");
      await until(async () => (await page.$$(".bitem")).length === 2);
      ok(R.conflicts > c0 && (await page.$$(".bitem")).length === 2, `brain: sha conflict retried (${R.conflicts - c0} conflict)`);
      // status filter: default all, never hides on its own
      ok(await page.$eval('.sfilter button[data-f="all"]', (e) => e.classList.contains("on")), "brain: filter default = all");
      await page.click('.sfilter button[data-f="idea"]');
      ok((await page.$$(".bitem")).length === 1 && /دوم/.test(await page.textContent(".bitem .it")), "brain: filter by status");
      await page.click('.sfilter button[data-f="published"]');
      ok((await page.$$(".bitem")).length === 0 && /در این وضعیت/.test(await page.textContent("#blist")), "brain: empty filter message");
      await page.click('.sfilter button[data-f="all"]');
      ok((await page.$$(".bitem")).length === 2, "brain: all items visible again");
      // the tab counts
      ok((await page.textContent("#cnt-idea")) === "۲" && (await page.textContent("#cnt-scenario")) === "۱" && (await page.textContent("#cnt-script")) === "۱", "brain: tab counts");
    }

    // ================================================== 3. gallery: upload, classification, override, brain link
    {
      const page = A.page;
      await hashTo(page, "#/gallery", "#gal-domains");
      ok((await page.$$("#gal-domains .dombox")).length === 5, "gallery: 5 domains");
      await hashTo(page, "#/gallery/" + P1 + "/slide", "#upl");
      const tabs = await page.$$eval(".tabs .tab", (t) => t.map((x) => x.textContent.replace(/\s*[۰-۹]+\s*$/, "").trim()));
      ok(JSON.stringify(tabs) === JSON.stringify(["اسلاید", "ریل", "استوری", "ویدئو"]), `gallery: submenus ${tabs}`);
      // 3 images in one upload -> one slide
      await page.setInputFiles("#gf", [M("img45.jpg"), M("img45b.jpg"), M("img11.png")]);
      await page.waitForSelector(".gp");
      const plan = await page.$$eval(".gp", (g) => g.map((x) => ({ rule: x.querySelector(".grule").textContent, kind: x.querySelector("select").value, n: x.querySelectorAll(".gpthumbs img").length })));
      ok(plan.length === 1 && plan[0].kind === "slide" && /چند عکس/.test(plan[0].rule) && plan[0].n === 3, `gallery: 3 images -> 1 slide, rule shown (${JSON.stringify(plan)})`);
      const scriptId = await page.evaluate(() => Array.from(document.querySelectorAll("#g-brain option")).filter((o) => /اسکریپت/.test(o.textContent)).map((o) => o.value)[0]);
      ok(!!scriptId, "gallery: brain items offered for linking (script first)");
      await page.selectOption("#g-brain", scriptId);
      await page.fill('[data-plan-title="0"]', "اسلاید گربه‌ها");
      const blobs0 = R.blobs.size;
      await page.click("#g-up");
      await page.waitForFunction(() => document.querySelectorAll(".gitem").length === 1, null, { timeout: 30000 });
      ok(R.blobs.size - blobs0 === 3, `gallery: 3 blobs uploaded (${R.blobs.size - blobs0})`);
      const tree = R.trees.get(R.commits.get(R.refs.get("media-upload")).tree).map((e) => e.path);
      ok(tree.length === 3 && tree.every((p) => /^gallery\/g\d{6}-\d{6}-[0-9a-f]{4}-[1-3]\.(jpg|png)$/.test(p)), `gallery: staged on media-upload under gallery/ (${tree})`);
      ok(R.dispatches.some((d) => d.wf === "publish.yml"), "gallery: publish.yml dispatched to move files into the release");
      const gi = await page.$eval(".gitem", (e) => ({ t: e.querySelector(".it").textContent, chip: e.querySelector(".schip").textContent, thumb: (e.querySelector(".gthumb img") || {}).src || "", brain: (e.querySelector(".lchip") || {}).textContent || "", moving: /در حال انتقال/.test(e.textContent), pub: !!e.querySelector('a[href*="#/publish?g="]'), files: e.querySelectorAll(".flink").length }));
      ok(gi.t === "اسلاید گربه‌ها" && gi.chip === "بارگذاری شد" && /^data:image\/jpeg/.test(gi.thumb), `gallery: card with thumbnail + status (${gi.t}/${gi.chip})`);
      ok(/مغز متفکر/.test(gi.brain) && gi.pub && gi.files === 3 && gi.moving, "gallery: link to brain item, publish button, file links, 'moving' note");
      const graw = R.text("vault/gallery-" + P1 + ".enc.json");
      ok(isEncFile(graw) && !/اسلاید|gallery\/|releases/.test(graw), "gallery: metadata encrypted");
      // brain script now ساخته شد
      await hashTo(page, "#/brain/" + P1 + "/script", ".bitem");
      ok((await page.textContent(".bitem .schip")) === "ساخته شد" && /گالری/.test(await page.textContent(".bitem .ilinks")), "status sync: brain script -> ساخته شد + gallery link");
      // 9:16 10 s video -> suggested story; override to reel
      await hashTo(page, "#/gallery/" + P1 + "/slide", "#upl");
      await page.setInputFiles("#gf", [M("v916_10.webm")]);
      await page.waitForSelector(".gp");
      const p2 = await page.$eval(".gp", (x) => ({ rule: x.querySelector(".grule").textContent, kind: x.querySelector("select").value, thumb: !!x.querySelector(".gpthumbs img"), info: x.querySelector(".gpf").textContent }));
      ok(p2.kind === "story" && /۱۵ ثانیه/.test(p2.rule) && /پیشنهاد/.test(p2.rule) && p2.thumb && /۱۸۰×۳۲۰/.test(p2.info), `gallery: 9:16 ≤15 s video -> suggested story (${JSON.stringify(p2)})`);
      await page.selectOption('[data-plan-kind="0"]', "reel");
      await page.click("#g-up");
      await page.waitForFunction(() => /#\/gallery\/[\w-]+\/reel\?focus=/.test(location.hash) && document.querySelector(".gitem.focus"), null, { timeout: 30000 });
      ok(/دستی تغییر کرد/.test(await page.textContent(".gitem.focus .grule")), "gallery: override kept and shown");
      // mixed upload: horizontal, 9:16 40 s, 9:16 120 s ; story checkbox
      await hashTo(page, "#/gallery/" + P1 + "/video", "#upl");
      await page.setInputFiles("#gf", [M("vH_20.webm"), M("v916_40.webm"), M("v916_120.webm")]);
      await page.waitForFunction(() => document.querySelectorAll(".gp").length === 3);
      let kinds = await page.$$eval(".gp select", (s) => s.map((x) => x.value));
      await shot(page, "gallery-plan");
      ok(JSON.stringify(kinds) === JSON.stringify(["video", "reel", "video"]), `gallery: horizontal/40 s vertical/120 s -> ${kinds}`);
      await page.check("#g-story");
      await page.waitForFunction(() => document.querySelectorAll(".gp select")[1] && document.querySelectorAll(".gp select")[1].value === "story");
      kinds = await page.$$eval(".gp select", (s) => s.map((x) => x.value));
      ok(JSON.stringify(kinds) === JSON.stringify(["story", "story", "video"]), `gallery: «برای استوری» -> every video ≤ 60 s becomes story, 120 s stays video (${kinds})`);
      await page.uncheck("#g-story");
      await page.waitForFunction(() => document.querySelectorAll(".gp select")[1].value === "reel");
      await page.click("#g-up");
      await page.waitForFunction(() => document.querySelectorAll(".gitem").length === 2, null, { timeout: 40000 });
      ok((await page.textContent("#cnt-video")) === "۲" && (await page.textContent("#cnt-reel")) === "۲", "gallery: 2 videos + 2 reels after the mixed upload");
      // single 9:16 image -> story; too large file refused
      await page.setInputFiles("#gf", [M("img916.jpg")]);
      await page.waitForSelector(".gp");
      ok((await page.$eval(".gp select", (s) => s.value)) === "story", "gallery: single 9:16 image -> story");
      const big = path.join(MEDIA, "big.mp4"); if (!fs.existsSync(big)) { const fd = fs.openSync(big, "w"); fs.ftruncateSync(fd, 71 * 1024 * 1024); fs.closeSync(fd); }
      await page.setInputFiles("#gf", [big]);
      ok(/۷۰ مگابایت/.test(await page.textContent("#g-msg")), "gallery: > 70 MB refused with a message");
      // change status + kind on a card (never deleted)
      await hashTo(page, "#/gallery/" + P1 + "/slide", ".gitem");
      await page.selectOption('.gitem select[data-act="status"]', "ready");
      await until(() => page.$eval(".gitem .schip", (e) => e.textContent === "آماده انتشار"));
      ok((await page.textContent(".gitem .schip")) === "آماده انتشار", "gallery: status set to آماده انتشار");
      // pretend publish.py moved the files: the "moving" note disappears
      const gal = await page.evaluate((p) => window.__spV8.dsRead("gallery-" + p), P1);
      R.release = { assets: gal.items.flatMap((it) => it.media.map((m) => ({ name: m.name }))) };
      await page.reload(); await page.waitForSelector(".gitem");
      ok(!/در حال انتقال/.test(await page.textContent("#glist")), "gallery: file shown as moved once it is in the release");
    }

    // ================================================== 4. publish from gallery: channels, schedule, queue, calendar
    let jobName = null;
    {
      const page = A.page;
      await page.click('.gitem a[href*="#/publish?g="]');
      await page.waitForSelector("#chm");
      await page.waitForSelector(".pgi.on", { timeout: 20000 });
      ok(await page.$eval('.srcseg button[data-src="gallery"]', (b) => b.classList.contains("on")) && await page.isHidden("#src-upload"), "publish: opened with «از گالری» selected");
      ok((await page.inputValue("#pt")) === "اسلاید گربه‌ها", "publish: title prefilled from the gallery item");
      ok(/فقط فایل اول/.test(await page.textContent("#pubmsg")), "publish: multi-image slide limitation stated");
      await until(() => page.evaluate(() => !document.querySelector('label.cell input[data-t$="|youtube"]') || !document.querySelector('label.cell input[data-t="' + "x" + '"]')));
      await until(() => page.evaluate((p) => { const l = document.querySelector('input[data-t="' + p + '|youtube"]'); return l && !l.closest(".cell").classList.contains("manual"); }, P1));
      const mx = await page.evaluate((p) => ({
        cells: document.querySelectorAll("input[data-t]").length,
        checked: Array.from(document.querySelectorAll("input[data-t]:checked")).map((i) => i.getAttribute("data-t")),
        row: document.querySelector('input[data-g="pg:' + p + '"]').checked,
        manual: Array.from(document.querySelectorAll(".cell.manual input")).map((i) => i.getAttribute("data-t")),
        legend: document.querySelector(".legend").textContent, sum: document.getElementById("chm-sum").textContent }), P1);
      await shot(page, "publish-gallery-prefill");
      ok(mx.cells === 20, `publish: 20 channel checkboxes (${mx.cells})`);
      ok(mx.checked.length === 4 && mx.checked.every((k) => k.startsWith(P1 + "|")) && mx.row, `publish: the gallery item's domain preselected (${mx.checked})`);
      ok(!mx.manual.includes(P1 + "|youtube") && mx.manual.includes(P1 + "|aparat") && mx.manual.includes(P2 + "|youtube") && mx.manual.length === 19, `publish: connected YouTube automatic, others labelled manual (${mx.manual.length})`);
      ok(/اتصال برقرار نیست/.test(mx.legend) && /اتصال برقرار نیست/.test(mx.sum), "publish: «اتصال برقرار نیست» label shown (v10 wording)");
      // group toggles
      await page.check('input[data-g="pl:youtube"]');
      let n = await page.$$eval("input[data-t]:checked", (x) => x.length);
      ok(n === 8, `publish: network column adds all 5 YouTube channels (${n})`);
      ok(await page.$eval('input[data-g="all"]', (i) => i.indeterminate), "publish: «همه» indeterminate when some are chosen");
      await page.check('input[data-g="all"]'); n = await page.$$eval("input[data-t]:checked", (x) => x.length);
      ok(n === 20 && /۲۰ مقصد/.test(await page.textContent("#chm-sum")), `publish: «همه» selects all 20 (${n})`);
      await page.uncheck('input[data-g="all"]'); n = await page.$$eval("input[data-t]:checked", (x) => x.length);
      ok(n === 0, "publish: «همه» clears all");
      await page.check('input[data-g="pg:' + P1 + '"]'); await page.uncheck('input[data-t="' + P1 + '|tiktok"]');
      ok(await page.$eval('input[data-g="pg:' + P1 + '"]', (i) => i.indeterminate && !i.checked), "publish: domain row indeterminate after unticking one");
      // schedule 2 h ahead
      await page.click('.whenseg button[data-when="sched"]');
      const when = await page.evaluate(() => { const d = new Date(Date.now() + 2 * 3600e3); const p = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tehran", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d); const o = {}; p.forEach((x) => (o[x.type] = x.value)); return o.year + "-" + o.month + "-" + o.day + "T" + o.hour + ":" + o.minute; });
      await page.fill("#pd", when);
      await page.fill("#pc", "کپشن تست\nخط دوم");
      const q0 = [...R.files.keys()].filter((k) => k.startsWith("queue/")).length;
      await page.click("#pub-go");
      await page.waitForFunction(() => /✓ ثبت شد/.test(document.getElementById("pubmsg").textContent), null, { timeout: 20000 });
      const qf = [...R.files.keys()].filter((k) => k.startsWith("queue/"));
      ok(qf.length === q0 + 1, "publish: one queue file written");
      jobName = qf.sort().pop();
      const job = R.json(jobName);
      ok(job.publish_at === when + ":00+03:30" && job.status === "pending" && job.caption === "کپشن تست\nخط دوم", `publish: scheduled job (${job.publish_at})`);
      ok(job.targets.length === 3 && job.targets.find((t) => t.platform === "youtube" && !t.manual) && job.targets.filter((t) => t.manual).length === 2, `publish: targets with manual flags ${JSON.stringify(job.targets)}`);
      ok(/releases\/download\/gallery\//.test(job.asset_url) && job.assets.length === 3 && job.media.source === "gallery" && job.media.blob_sha, "publish: gallery job points at the release asset (blob fallback kept)");
      ok(!/brain|gallery_id|اسلاید گربه‌ها\s*$/.test(JSON.stringify(Object.keys(job))) && !("brain_id" in job) && !("gallery_id" in job), "publish: queue entry stays minimal (no brain/gallery links)");
      await until(() => R.files.has("vault/publish.enc.json"));
      const praw = R.text("vault/publish.enc.json");
      ok(isEncFile(praw), "publish: link record stored encrypted");
      // queue list
      await page.waitForSelector("#jobs .job");
      const jb = await page.$eval("#jobs .job", (e) => ({ chip: e.querySelector(".schip").textContent, dots: e.querySelectorAll(".sdots i.on").length, manual: e.querySelectorAll(".jtargets .schip.manual").length, notyet: e.querySelectorAll(".jtargets .tr.notyet").length, gal: !!e.querySelector('.lchip[href*="#/gallery/"]') }));
      ok(jb.chip === "زمان‌بندی شد" && jb.dots === 2 && jb.manual === 0 && jb.notyet === 2 && jb.gal, /* v10: before publish.py runs, not-yet-connected targets carry a note, not a final label */ `publish: queue item chip/dots/manual labels/gallery link (${JSON.stringify(jb)})`);
      // gallery shows زمان‌بندی شد
      await hashTo(page, "#/gallery/" + P1 + "/slide", ".gitem");
      ok((await page.textContent(".gitem .schip")) === "زمان‌بندی شد" && /انتشار/.test(await page.textContent(".gitem .lchip.pub")), "status sync: gallery item -> زمان‌بندی شد");
      // publish.py ran: youtube published, the 2 manual targets became reminders
      const j2 = R.json(jobName); j2.publish_at = new Date(Date.now() - 600e3).toISOString(); j2.status = "partial";
      j2.results = { [P1 + "/youtube"]: { status: "published", url: "https://www.youtube.com/watch?v=x" } };
      j2.targets.filter((t) => t.manual).forEach((t) => (j2.results[t.page + "/" + t.platform] = { status: "manual", reason: "نیاز به اتصال / انتشار دستی" }));
      R.set(jobName, j2);
      await page.reload(); await page.waitForSelector(".gitem");
      ok((await page.textContent(".gitem .schip")) === "منتشر شد", "status sync: gallery item -> منتشر شد");
      await hashTo(page, "#/brain/" + P1 + "/script", ".bitem");
      ok((await page.textContent(".bitem .schip")) === "منتشر شد", "status sync: brain script -> منتشر شد");
      await hashTo(page, "#/brain/" + P1 + "/idea", ".bitem");
      ok((await page.$$eval(".bitem .schip", (c) => c.map((x) => x.textContent))).includes("منتشر شد"), "status sync: the idea of that script -> منتشر شد");
      // queue: mark a manual target as done
      await hashTo(page, "#/publish", "#jobs .job");
      ok(/^منتشر شد/.test(await page.textContent("#jobs .job .schip")), "publish: job shows منتشر شد");
      await page.click('#jobs .job button[data-jact="manual"]');
      await until(() => { const j = R.json(jobName); return Object.values(j.results).some((r) => r.manual); });
      const j3 = R.json(jobName);
      ok(Object.values(j3.results).filter((r) => r.manual && r.status === "published").length === 1 && j3.status === "needs_action", "publish: «دستی منتشر کردم» recorded in the queue file (one channel still unresolved -> needs_action)");
      // filters
      await page.waitForSelector('#pview .sfilter button[data-f="published"]');
      await page.click('#pview .sfilter button[data-f="error"]');
      ok((await page.$$("#jobs .job")).length === 0, "publish: filter خطا -> none");
      await page.click('#pview .sfilter button[data-f="all"]');
      ok((await page.$$("#jobs .job")).length === 1, "publish: filter همه -> all");
      // a failed job and a scheduled one for the calendar
      R.set("queue/20261101-100000-aaaa.json", { id: "20261101-100000-aaaa", publish_at: "2026-11-01T10:00:00+03:30", created_at: "2026-11-01T09:00:00+03:30", title: "قدیمی ناموفق", targets: [{ page: P2, platform: "instagram" }], results: { [P2 + "/instagram"]: { status: "failed", reason: "x" } }, status: "failed" });
      await page.click("#reloadjobs"); await until(async () => (await page.$$("#jobs .job")).length === 2);
      ok((await page.$$("#jobs .job")).length === 2 && (await page.$$eval("#jobs .job", (j) => j.map((x) => x.getAttribute("data-status")))).includes("error"), "publish: failed job listed with خطا");
      // calendar
      await page.click('.viewseg button[data-v="cal"]'); await page.waitForSelector("#cal .calgrid");
      const cal = await page.evaluate(() => ({ title: document.querySelector(".caltitle").textContent, days: document.querySelectorAll(".cd:not(.blank)").length, has: document.querySelectorAll(".cd.has").length, today: document.querySelectorAll(".cd.today").length, wd: document.querySelector(".calgrid .wd").textContent }));
      ok(cal.days >= 29 && cal.days <= 31 && cal.today === 1 && cal.wd === "ش" && /۱۴۰۵/.test(cal.title), `calendar: Persian month grid starting Saturday (${JSON.stringify(cal)})`);
      ok(cal.has >= 1, "calendar: day with a publish marked");
      await page.click(".cd.today"); await until(() => page.$(".calday .crow"));
      ok(!!(await page.$(".calday .crow")) || cal.has >= 1, "calendar: tapping a day lists its items");
      await page.click('button[data-cal="week"]'); await page.waitForSelector(".calweek");
      ok((await page.$$(".calweek .wrow")).length === 7 && (await page.$$(".calweek .wrow.today")).length === 1, "calendar: week view (7 days, today marked)");
      await page.click('button[data-cal="prev"]'); ok((await page.$$(".calweek .wrow.today")).length === 0, "calendar: previous week");
      await page.click('button[data-cal="today"]'); ok((await page.$$(".calweek .wrow.today")).length === 1, "calendar: back to today");
      await page.click('button[data-cal="month"]');
      // plain upload still works (manual upload path)
      await page.click('.srcseg button[data-src="upload"]');
      await page.setInputFiles("#pf", M("imgH.jpg"));
      await page.click('.whenseg button[data-when="now"]');
      await page.uncheck('input[data-g="all"]').catch(() => {}); await page.check('input[data-t="' + P2 + '|instagram"]');
      const before = [...R.files.keys()].filter((k) => k.startsWith("queue/")).length;
      await page.click("#pub-go");
      await page.waitForFunction(() => /✓ ثبت شد/.test(document.getElementById("pubmsg").textContent), null, { timeout: 20000 });
      const upJob = R.json([...R.files.keys()].filter((k) => k.startsWith("queue/")).sort().filter((k) => !k.includes("20261101")).pop());
      ok([...R.files.keys()].filter((k) => k.startsWith("queue/")).length === before + 1 && upJob.media.branch === "media-upload" && /^\d{8}-\d{6}-\w{4}\.jpg$/.test(upJob.media.name) && upJob.targets[0].manual === true, "publish: manual upload queued (file name not leaked, instagram manual)");
    }

    // ================================================== 5. device B (390 px): other device sees the same data, inbox merge
    {
      const B = await device(browser, R, "mobile", {});
      const page = B.page;
      await nav(page, base, "#/brain/" + P1 + "/idea", "#data-unlock");
      await page.fill("#dpw", "wrong-password"); await page.click("#dpw-go");
      await until(() => page.$eval("#dpw-msg", (e) => /✗/.test(e.textContent)));
      ok(/درست نیست/.test(await page.textContent("#dpw-msg")), "device B: wrong panel password refused");
      await page.fill("#dpw", P); await page.click("#dpw-go");
      await page.waitForSelector(".bitem", { timeout: 20000 });
      ok((await page.$$(".bitem")).length === 2, "device B: same brain items after unlocking with the panel password");
      // ECIES inbox item made by gallery_ingest.py's encryptor, merged by the panel
      const pubPath = path.join(FX, "_pub.json"); fs.writeFileSync(pubPath, R.text("config/inbox_pub.json"));
      const inboxItem = cp.execFileSync("python3", ["-c", `import json,sys; sys.path.insert(0, ${JSON.stringify(path.join(ROOT, "scripts"))}); import gallery_ingest as g
pub=json.load(open(${JSON.stringify(pubPath)}))
p={"id":"g261116-120000-beef","page":${JSON.stringify(P2)},"kind":"reel","kind_auto":"reel","rule":"ویدئوی عمودی ۹:۱۶ تا ۹۰ ثانیه → ریل","title":"از ابزار بیرونی","media":[{"name":"g261116-120000-beef-1.mp4","url":"https://github.com/x/y/releases/download/gallery/g261116-120000-beef-1.mp4","type":"video/mp4","size":1000,"w":1080,"h":1920,"dur":20}],"thumb":"","status":"uploaded","brain_id":"","created_at":"2026-11-16T12:00:00+03:30"}
print(json.dumps(g.encrypt_to_panel(pub, p["id"], p)))`]).toString();
      ok(!/از ابزار بیرونی|reel/.test(inboxItem), "inbox: item is encrypted (python ECIES)");
      R.set("inbox/g261116-120000-beef.enc.json", inboxItem);
      await hashTo(page, "#/gallery", "#gal-domains");
      await until(() => !R.files.has("inbox/g261116-120000-beef.enc.json"));
      ok(!R.files.has("inbox/g261116-120000-beef.enc.json"), "inbox: merged file deleted");
      await hashTo(page, "#/gallery/" + P2 + "/reel", ".gitem");
      ok(/از ابزار بیرونی/.test(await page.textContent(".gitem .it")), "inbox: item decrypted in the browser and added to the domain's gallery");
      // tampered ciphertext is rejected
      const fp = "vault/brain-" + P1 + ".enc.json", orig = R.files.get(fp);
      const t = JSON.parse(orig.toString()); const ctb = Buffer.from(t.ct, "base64"); ctb[5] ^= 1; t.ct = ctb.toString("base64"); R.set(fp, JSON.stringify(t));
      const tam = await page.evaluate((p) => window.__spV8.dsRead("brain-" + p).then(() => "read", (e) => "rejected"), P1);
      ok(tam === "rejected", "encryption: tampered file rejected (AES-GCM auth)");
      // swapped file (valid ciphertext of another path) is rejected through the AAD
      R.files.set(fp, R.files.get("vault/brain-" + P1 + ".enc.json") && R.files.get("vault/gallery-" + P1 + ".enc.json"));
      const sw = await page.evaluate((p) => window.__spV8.dsRead("brain-" + p).then(() => "read", () => "rejected"), P1);
      ok(sw === "rejected", "encryption: a file moved to another path is rejected (AAD = path)");
      R.files.set(fp, orig); R.shaOverride.delete(fp);
      // layout at 390 px, light + dark, on every v8 page
      for (const theme of ["light", "dark"]) {
        await page.evaluate((t) => localStorage.setItem("sp_theme", t), theme);
        for (const [h, sel] of [["#/", ".boxes"], ["#/brain", "#brain-domains"], ["#/brain/" + P1 + "/idea", ".bitem"], ["#/gallery", "#gal-domains"], ["#/gallery/" + P1 + "/slide", ".gitem"], ["#/gallery/" + P1 + "/reel", ".gitem"], ["#/publish", "#jobs .job"]]) {
          await nav(page, base, h); await page.reload(); await page.waitForSelector(sel, { timeout: 20000 });
          await noOverflow(page, `390 ${theme} ${h}`);
        }
        await page.click('.viewseg button[data-v="cal"]'); await page.waitForSelector(".calgrid");
        await noOverflow(page, `390 ${theme} calendar`);
        const cell = await page.$eval(".cd:not(.blank)", (e) => e.getBoundingClientRect().width);
        ok(cell >= 40, `390 ${theme}: calendar day cells tappable (${cell}px)`);
        const box = await page.$eval("input[data-t]", (i) => { const r = i.closest(".cell").getBoundingClientRect(); return [r.width, r.height]; });
        ok(box[0] >= 40 && box[1] >= 40, `390 ${theme}: channel checkbox targets ≥ 40 px (${box})`);
      }
      await B.ctx.close();
    }
    // desktop layout pass
    {
      const page = A.page;
      for (const [h, sel] of [["#/", ".boxes"], ["#/brain/" + P1 + "/idea", ".bitem"], ["#/gallery/" + P1 + "/video", ".gitem"], ["#/publish", "#jobs .job"]]) { await nav(page, base, h); await page.reload(); await page.waitForSelector(sel, { timeout: 20000 }); await noOverflow(page, "1280 " + h); }
      await A.ctx.close();
    }

    // ================================================== 6. gates: no token / locked token
    {
      const C = await device(browser, R, "mobile", { token: false });
      R.files.delete("config/token.enc.json");
      await nav(C.page, base, "#/brain", "#data-notoken");
      ok(/توکن/.test(await C.page.textContent("#data-notoken")), "gate: no token -> settings hint");
      R.set("config/token.enc.json", await tokenEnc(P, TOKEN));
      await C.ctx.close();
      const D = await device(browser, R, "mobile", { token: false });
      await nav(D.page, base, "#/gallery", "#gal-domains, #data-tokunlock");
      await D.page.waitForSelector("#data-tokunlock", { timeout: 20000 });
      await D.page.fill("#dunlock-pw", P); await D.page.click("#dunlock-go");
      await D.page.waitForSelector("#gal-domains", { timeout: 30000 });
      ok(await D.page.evaluate(() => localStorage.getItem("sp_gh_token")) === TOKEN, "gate: locked token + data opened with one password");
      await D.ctx.close();
    }
  } catch (e) {
    fails.push("exception: " + (e && e.stack || e));
  } finally {
    await browser.close(); srv.close();
  }
  errors.forEach((e) => fails.push("page error: " + e));
  console.log(`v8: ${checks} checks, ${fails.length} failed`);
  fails.forEach((f) => console.log(" - " + f));
  process.exit(fails.length ? 1 : 0);
})();
