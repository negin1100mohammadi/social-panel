// v6 end-to-end tests (headless Chromium via Playwright).
// usage: FIXTURE_NOW=<ms> node tests/v6.test.js <fixture_dir> <real_repo_dir>
//   <fixture_dir>  built by: python tests/make_fixture.py <fixture_dir> $FIXTURE_NOW
//   <real_repo_dir> the repo checkout (for the real config/token.enc.json format and real data smoke)
// Covers: every route at 390px + desktop in light + dark; per-post window math (independent implementation +
// hand-computed numbers); every chart/admin link by elementFromPoint and a real click/tap, expanded/collapsed,
// after a background data reload; tools; token unlock modal flow (mocked GitHub API, real WebCrypto);
// service-worker update -> single reload.
// The page's login hash is swapped for a throwaway test credential where a login is needed (the real one is never used).
const { chromium } = require("playwright");
const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto");

const FX = process.argv[2], REPO = process.argv[3] || path.join(__dirname, "..");
const NOW = Number(process.env.FIXTURE_NOW);
if (!FX || !NOW) { console.error("usage: FIXTURE_NOW=ms node tests/v6.test.js <fixture_dir> <repo_dir>"); process.exit(2); }
const HOUR = 3600e3, DAY = 86400e3, OFF = 3.5 * HOUR;
const RANGES = { "3h": [3 * HOUR, 30 * 60e3], "24h": [24 * HOUR, HOUR], "30d": [30 * DAY, DAY], "90d": [90 * DAY, 3 * DAY] };
const PLATS = ["instagram", "youtube", "aparat", "tiktok"];
const REAL_HASH = "1b906a20e9fea1a47f58c9c56aa49688acb2dd0ba5fba3188825f252401a3ba8";
const U = "tester", P = "test-pass-123", TOKEN = "github_pat_TESTTOKEN_v6_abc123";

let checks = 0; const fails = [];
const ok = (c, m) => { checks++; if (!c) fails.push(m); };
const J = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const config = J(path.join(FX, "config.json")), latest = J(path.join(FX, "data/latest.json")), PH = J(path.join(FX, "data/posts_history.json"));

// ------------------------------------------------------------------ independent expectation (not the app's code)
const pt = (v) => { if (v == null) return null; const t = Date.parse(v); return isNaN(t) ? null : t; };
function chanModel(ch) {
  if (!ch) return null;
  const runs = ch.runs.map(pt).filter((x) => x != null).sort((a, b) => a - b);
  const posts = Object.entries(ch.posts || {}).map(([id, e]) => {
    const pts = e.s.map((q) => ({ t: pt(q[0]), v: q[1], l: q[2], c: q[3] })).sort((a, b) => a.t - b.t);
    return { id, pub: pt(e.published), pts, first: pts[0].t, last: pt(e.last) };
  });
  return { runs, posts };
}
function val(p, k, T) { let v; for (const q of p.pts) { if (q.t > T) break; v = q[k]; } return v; }
function gain(p, k, a, b, winFrom) {
  if (p.first > b) return undefined;
  const end = val(p, k, b); if (end == null) return null;
  const fresh = p.pub != null && p.pub >= winFrom;
  let base = p.first <= a ? val(p, k, a) : null;
  if (base == null) {
    const lo = p.first <= a ? a : -Infinity;
    const f = p.pts.find((q) => q.t > lo && q.t <= b && q[k] != null);
    if (!f) return null;
    base = fresh ? 0 : f[k];
  }
  return end - base;
}
function expectWindow(m, r, now) {
  const from = now - RANGES[r][0];
  const rows = [];
  for (const p of m.posts) {
    if (p.first > now || (p.last != null && p.last < from)) continue;
    rows.push({ id: p.id, v: gain(p, "v", from, now, from), l: gain(p, "l", from, now, from), c: gain(p, "c", from, now, from) });
  }
  const tot = {};
  for (const k of ["v", "l", "c"]) { const h = rows.filter((x) => x[k] != null); tot[k] = h.length ? h.reduce((s, x) => s + x[k], 0) : null; }
  const avail = {}; for (const k of ["v", "l", "c"]) avail[k] = m.posts.some((p) => p.pts.some((q) => q[k] != null));
  const runsIn = m.runs.filter((t) => t >= from && t <= now).length;
  return { from, rows, tot, avail, runsIn, firstRun: m.runs[0] };
}
function expectBuckets(m, k, r, now) {
  const [ms, size] = RANGES[r], from = now - ms;
  const out = [];
  for (let g = Math.floor((from + OFF) / size) * size - OFF, i = 0; g <= now; g += size, i++) {
    const a = Math.max(g, from), b = Math.min(g + size, now);
    const has = m.runs.some((t) => (i === 0 ? t >= a : t > a) && t <= b);
    if (!has) { out.push(null); continue; }
    let s = 0; for (const p of m.posts) { const x = gain(p, k, a, b, from); if (x != null) s += x; }
    out.push(s);
  }
  while (out.length && out[0] == null) out.shift();
  return out;
}

// ------------------------------------------------------------------ server (fixture or repo), optional patched login hash
function serve(dir, opts = {}) {
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".jpg": "image/jpeg" };
  return new Promise((res) => {
    const srv = http.createServer((q, s) => {
      const u = decodeURIComponent(q.url.split("?")[0]);
      if (opts.override && opts.override[u] != null) { const b = typeof opts.override[u] === "function" ? opts.override[u]() : opts.override[u]; s.writeHead(200, { "Content-Type": types[path.extname(u)] || "text/plain", "Cache-Control": "no-cache" }); return s.end(b); }
      let f = path.join(dir, u); if (f.endsWith("/")) f += "index.html";
      fs.readFile(f, (e, d) => { if (e) { s.writeHead(404); s.end(); } else { s.writeHead(200, { "Content-Type": types[path.extname(f)] || "application/octet-stream", "Cache-Control": "no-cache" }); s.end(d); } });
    }).listen(0, () => res({ srv, url: "http://127.0.0.1:" + srv.address().port + "/" }));
  });
}
const appSrc = fs.readFileSync(path.join(FX, "app.js"), "utf8");
const salt = /var AUTH_SALT = "([^"]+)"/.exec(appSrc)[1];
const testHash = crypto.createHash("sha256").update(salt + U + "|" + P).digest("hex");
const patchedApp = appSrc.replace(/var AUTH_HASH = "[0-9a-f]+"/, 'var AUTH_HASH = "' + testHash + '"');
ok(/var AUTH_HASH = "1b906a20e9fea1a47f58c9c56aa49688acb2dd0ba5fba3188825f252401a3ba8"/.test(appSrc), "login hash in app.js must be unchanged");

// encrypt exactly like the app (PBKDF2-SHA256 310000 -> AES-GCM-256), done here with Node crypto
function encryptLikeApp(tok, pw) {
  const s = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const key = crypto.pbkdf2Sync(pw, s, 310000, 32, "sha256");
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(tok, "utf8"), c.final(), c.getAuthTag()]);
  return { v: 1, salt: s.toString("base64"), iv: iv.toString("base64"), ct: ct.toString("base64"), created_at: new Date(NOW - 3600e3).toISOString() };
}
async function mockGitHub(ctx, st) {
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "GET,PUT,DELETE,POST" };
  await ctx.route(/https:\/\/(api\.github\.com|raw\.githubusercontent\.com)\/.*/, async (route) => {
    const r = route.request(), url = new URL(r.url()), m = r.method();
    if (m === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const json = (code, b) => route.fulfill({ status: code, headers: { ...cors, "Content-Type": "application/json" }, body: JSON.stringify(b) });
    const auth = r.headers()["authorization"] || "";
    if (url.pathname.endsWith("/config/token.enc.json")) {
      st.encHits = (st.encHits || 0) + 1;
      if (url.host === "api.github.com" && st.apiDown) return json(500, { message: "down" });
      if (url.host.startsWith("raw.")) st.rawHits = (st.rawHits || 0) + 1;
      if (!st.remote) return json(404, { message: "Not Found" });
      return json(200, st.remote);
    }
    if (/^\/repos\/negin1100mohammadi\/social-panel\/?$/.test(url.pathname)) return auth === "Bearer " + TOKEN ? json(200, { permissions: { push: true } }) : json(401, { message: "Bad credentials" });
    if (/\/actions\/workflows$/.test(url.pathname)) return auth === "Bearer " + TOKEN ? json(200, { workflows: [] }) : json(401, {});
    if (/\/contents\/queue/.test(url.pathname)) return json(200, []);
    return json(404, { message: "Not Found" });
  });
  await ctx.route(/^https:\/\/(fonts\.googleapis|fonts\.gstatic)\.com\/.*/, (r) => r.fulfill({ status: 200, body: "" }));
}

const VIEWPORTS = { mobile: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, desktop: { viewport: { width: 1280, height: 900 } } };
async function newCtx(browser, vp, theme, init = {}) {
  const ctx = await browser.newContext({ ...VIEWPORTS[vp], serviceWorkers: "block", locale: "fa-IR", timezoneId: "America/New_York" });
  await ctx.addInitScript(([h, th, extra]) => {
    if (h && !localStorage.getItem("sp_auth")) localStorage.setItem("sp_auth", h);
    if (th) localStorage.setItem("sp_theme", th);
    for (const [k, v] of Object.entries(extra.ls || {})) if (localStorage.getItem(k) == null) localStorage.setItem(k, v);
    for (const [k, v] of Object.entries(extra.ss || {})) sessionStorage.setItem(k, v);
  }, [init.noAuth ? null : (init.hash || REAL_HASH), theme, { ls: init.ls || {}, ss: init.ss || {} }]);
  return ctx;
}
async function newPage(ctx) {
  const page = await ctx.newPage();
  await page.clock.setFixedTime(NOW);
  page._errors = [];
  page.on("pageerror", (e) => page._errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|net::ERR|api\.github\.com|raw\.githubusercontent/.test(m.text())) page._errors.push(m.text()); });
  return page;
}
const go = async (page, base, h, sel) => { await page.goto(base + h); if (sel) await page.waitForSelector(sel, { timeout: 15000 }); };
const hashTo = async (page, h, sel) => { await page.evaluate((x) => { location.hash = x; }, h); if (sel) await page.waitForSelector(sel, { timeout: 10000 }); };

(async () => {
  const { srv, url: base } = await serve(FX);
  const st = { remote: null };
  const browser = await chromium.launch();

  // ================================================================ 1. every route, 2 widths x 2 themes
  const routes = ["#/", "#/channels", "#/tools", "#/publish", "#/settings"].concat(config.pages.flatMap((cp) => PLATS.map((pl) => `#/a/${cp.id}/${pl}`)));
  for (const vp of ["mobile", "desktop"]) for (const theme of ["light", "dark"]) {
    const ctx = await newCtx(browser, vp, theme, { ss: { sp_unlock_later: "1" } });
    await mockGitHub(ctx, st);
    const page = await newPage(ctx);
    await go(page, base, "#/", ".boxes");
    for (const h of routes) {
      await hashTo(page, h, "#topbar");
      if (h.startsWith("#/a/")) await page.waitForSelector(".ahead");
      const info = await page.evaluate(() => ({ text: document.getElementById("app").innerText, html: document.getElementById("app").innerHTML, sw: document.documentElement.scrollWidth, iw: window.innerWidth, theme: document.documentElement.getAttribute("data-theme") }));
      const tag = `${vp}/${theme} ${h}`;
      ok(!/NaN|undefined|Infinity|\[object/.test(info.text), `${tag}: NaN/undefined in text`);
      ok(info.sw <= info.iw + 1, `${tag}: horizontal overflow ${info.sw} > ${info.iw}`);
      ok(info.theme === theme, `${tag}: theme ${info.theme}`);
      if (h === "#/") ok(await page.$("#toolbox") && await page.$("#pubbox") && await page.$(".chbox") && await page.$(".vault"), `${tag}: home boxes missing`);
      if (h === "#/") { const bg = await page.$eval("#toolbox", (e) => getComputedStyle(e).backgroundColor); ok(theme === "light" ? bg === "rgb(238, 240, 243)" : bg === "rgb(42, 44, 51)", `${tag}: tools box colour ${bg}`); }
      if (h.startsWith("#/a/")) {
        const [, , pid, pl] = h.split("/");
        const hd = await page.$eval(".ahead", (e) => ({ p: e.getAttribute("data-page"), pl: e.getAttribute("data-platform"), title: (document.getElementById("a-title") || {}).textContent, plat: (document.getElementById("a-platform") || {}).textContent, icon: !!e.querySelector(".picon." + e.getAttribute("data-platform")) }));
        const cp = config.pages.find((c) => c.id === pid);
        ok(hd.p === pid && hd.pl === pl && hd.title === cp.name && hd.icon && hd.plat === { instagram: "اینستاگرام", youtube: "یوتیوب", aparat: "آپارات", tiktok: "تیک‌تاک" }[pl], `${tag}: header ${JSON.stringify(hd)}`);
      }
    }
    if (vp === "mobile") await page.screenshot({ path: `/tmp/v6shot-${theme}-analytics.png`, fullPage: true });
    ok(!page._errors.length, `${vp}/${theme}: page errors ${page._errors.slice(0, 3).join(" | ")}`);
    await ctx.close();
  }

  // ================================================================ 2. per-post window math
  {
    const ctx = await newCtx(browser, "mobile", "light", { ss: { sp_unlock_later: "1" } });
    await mockGitHub(ctx, st);
    const page = await newPage(ctx);
    await go(page, base, "#/", ".boxes");
    for (const cp of config.pages) for (const pl of PLATS) {
      const key = cp.id + "/" + pl, m = chanModel(PH.channels[key]);
      await hashTo(page, `#/a/${key}`, ".ahead");
      const r = latest.pages[cp.id].platforms[pl];
      if (!(r && (r.ok || r.stale))) continue;
      for (const rg of Object.keys(RANGES)) {
        await page.click(`#gfilter button[data-r="${rg}"]`);
        await page.waitForSelector(`#summary[data-r="${rg}"]`);
        const S = await page.$eval("#summary", (e) => ({ gv: e.getAttribute("data-gv"), gl: e.getAttribute("data-gl"), gc: e.getAttribute("data-gc"), from: e.getAttribute("data-from"), to: e.getAttribute("data-to"), runs: e.getAttribute("data-runs"), win: (e.querySelector("#win") || {}).textContent || "", cov: (e.querySelector("#coverage") || {}).textContent || "", text: e.innerText }));
        const tag = `${key} [${rg}]`;
        ok(S.from === new Date(NOW - RANGES[rg][0]).toISOString() && S.to === new Date(NOW).toISOString(), `${tag}: window ${S.from}..${S.to}`);
        const fmtW = (t) => new Intl.DateTimeFormat("fa-IR", { month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Tehran" }).format(new Date(t));
        ok(S.win.includes("از " + fmtW(NOW - RANGES[rg][0])) && S.win.includes("تا " + fmtW(NOW)), `${tag}: window text "${S.win}"`);
        const onBtn = await page.$eval("#gfilter button.on", (b) => b.getAttribute("data-r"));
        ok(onBtn === rg, `${tag}: global filter button state ${onBtn}`);
        if (!m || pl === "tiktok" || !m.posts.length) {
          if (pl === "tiktok") ok(/تیک‌تاک آمار تک‌تک ویدیوها را بدون دسترسی به اکانت نمی‌دهد/.test(S.text), `${tag}: tiktok must say per-post data is not available`);
          continue;
        }
        const E = expectWindow(m, rg, NOW);
        for (const k of ["v", "l", "c"]) {
          const got = S["g" + k], want = E.tot[k] == null ? "" : String(E.tot[k]);
          ok(got === want, `${tag}: total ${k} ${got} != ${want}`);
        }
        ok(Number(S.runs) === E.runsIn, `${tag}: runs in window ${S.runs} != ${E.runsIn}`);
        if (E.firstRun > E.from) ok(S.cov.includes("داده از " + fmtW(E.firstRun) + " موجود است"), `${tag}: coverage should say data starts ${fmtW(E.firstRun)}: "${S.cov}"`);
        else ok(!/داده از .* موجود است/.test(S.cov), `${tag}: coverage wrongly says partial`);
        // per-post rows
        const rows = await page.$$eval("#plist .prow", (els) => els.map((e) => ({ id: e.getAttribute("data-id"), v: e.getAttribute("data-gv"), l: e.getAttribute("data-gl"), c: e.getAttribute("data-gc") })));
        ok(rows.length === E.rows.length, `${tag}: rows ${rows.length} != ${E.rows.length}`);
        const byId = Object.fromEntries(E.rows.map((x) => [x.id, x]));
        for (const row of rows) {
          const e = byId[row.id]; if (!e) { ok(false, `${tag}: unexpected row ${row.id}`); continue; }
          for (const k of ["v", "l", "c"]) ok(row[k] === (e[k] == null ? "" : String(e[k])), `${tag}: post ${row.id} ${k} ${row[k]} != ${e[k]}`);
        }
        const sk = E.avail.v ? "v" : E.avail.l ? "l" : "c";
        const seq = rows.map((x) => (x[sk] === "" ? -Infinity : Number(x[sk])));
        ok(seq.every((x, i) => i === 0 || seq[i - 1] >= x), `${tag}: rows not sorted by ${sk}`);
        // timeline: bars per bucket and cumulative line, for every metric available
        for (const mm of ["views", "likes", "comments"]) {
          const k = { views: "v", likes: "l", comments: "c" }[mm];
          if (!E.avail[k]) { ok(await page.$(`#trend button[data-m="${mm}"][disabled]`), `${tag}: unavailable metric ${mm} should be disabled`); continue; }
          for (const type of ["bar", "line"]) {
            await page.click(`#trend button[data-m="${mm}"]`); await page.click(`#trend button[data-type="${type}"]`);
            const T = await page.$eval("#trend", (e) => ({ m: e.getAttribute("data-m"), type: e.getAttribute("data-type"), bars: [...e.querySelectorAll("rect.bar")].map((b) => Number(b.getAttribute("data-v"))), dots: [...e.querySelectorAll("circle.dot")].map((b) => Number(b.getAttribute("data-v"))), line: !!e.querySelector("polyline.ln"), meta: e.querySelector(".tl-meta") && { total: Number(e.querySelector(".tl-meta").getAttribute("data-total")), n: Number(e.querySelector(".tl-meta").getAttribute("data-n")) }, state: (e.querySelector(".chart") || {}).getAttribute && e.querySelector(".chart").getAttribute("data-state") }));
            const eb = expectBuckets(m, k, rg, NOW), en = eb.filter((x) => x != null), et = en.reduce((s, x) => s + x, 0);
            const t2 = `${tag} ${mm}/${type}`;
            ok(T.m === mm && T.type === type, `${t2}: toggle state ${T.m}/${T.type}`);
            if (!en.length) { ok(T.state === "insufficient", `${t2}: expected no-measurement state, got ${T.state}`); continue; }
            ok(T.meta && T.meta.n === en.length && T.meta.total === et, `${t2}: timeline n/total ${JSON.stringify(T.meta)} != ${en.length}/${et}`);
            ok(et === (E.tot[k] || 0), `${t2}: bucket sum ${et} != window total ${E.tot[k]}`);
            if (type === "bar") ok(JSON.stringify(T.bars) === JSON.stringify(en), `${t2}: bars ${T.bars.slice(0, 8)} != ${en.slice(0, 8)}`);
            else { ok(T.line || en.length === 1, `${t2}: no line`); if (en.length <= 48) { let acc = 0; const cum = en.map((x) => (acc += x)); ok(JSON.stringify(T.dots) === JSON.stringify(cum), `${t2}: cumulative dots ${T.dots.slice(-3)} != ${cum.slice(-3)}`); } }
          }
        }
      }
    }
    // hand-computed account (pretime-tv/youtube): see tests/make_fixture.py
    await hashTo(page, "#/a/pretime-tv/youtube", ".ahead");
    const HAND = { "3h": { v: 137, l: 2, rows: { A: [100, 2], B: [30, null], C: [7, 0] } }, "24h": { v: 237, l: 3, rows: { A: [200, 3], B: [30, null], C: [7, 0] } }, "90d": { v: 1237, l: 3, rows: { A: [200, 3], B: [1030, null], C: [7, 0] } } };
    for (const [rg, h] of Object.entries(HAND)) {
      await page.click(`#gfilter button[data-r="${rg}"]`);
      const S = await page.$eval("#summary", (e) => ({ v: e.getAttribute("data-gv"), l: e.getAttribute("data-gl"), c: e.getAttribute("data-gc"), cov: e.querySelector("#coverage").textContent }));
      ok(S.v === String(h.v) && S.l === String(h.l) && S.c === "", `hand ${rg}: totals ${JSON.stringify(S)} != ${h.v}/${h.l}/—`);
      const rows = await page.$$eval("#plist .prow", (els) => els.map((e) => [e.getAttribute("data-id"), e.getAttribute("data-gv"), e.getAttribute("data-gl"), e.getAttribute("data-fresh"), e.innerText]));
      for (const [id, v, l, fresh, text] of rows) {
        ok(v === String(h.rows[id][0]) && l === (h.rows[id][1] == null ? "" : String(h.rows[id][1])), `hand ${rg}: row ${id} ${v}/${l} != ${h.rows[id]}`);
        if (id === "C") ok(fresh === "1" && /از صفر حساب شده/.test(text), `hand ${rg}: C must be "published in window, counted from 0"`);
        if (id === "B" && rg === "24h") ok(/از اولین ثبت/.test(text), `hand ${rg}: B must say counted from first record`);
      }
      ok(rows.map((x) => x[0]).join() === (rg === "90d" ? "B,A,C" : "A,B,C"), `hand ${rg}: order ${rows.map((x) => x[0])}`);
      if (rg !== "3h") ok(/داده از .* موجود است/.test(S.cov), `hand ${rg}: coverage must state data start`);
    }
    // global filter persists across pages and reloads
    await page.click('#gfilter button[data-r="30d"]');
    await hashTo(page, "#/a/titan-station/aparat", "#summary");
    ok(await page.$eval("#summary", (e) => e.getAttribute("data-r")) === "30d", "global filter must carry to another channel page");
    await page.reload(); await page.waitForSelector("#summary");
    ok(await page.$eval("#summary", (e) => e.getAttribute("data-r")) === "30d", "global filter must persist after reload");
    ok(!page._errors.length, "math: page errors " + page._errors.slice(0, 3).join(" | "));
    await ctx.close();
  }

  // ================================================================ 3. chart links: hit-testing + real click/tap
  for (const vp of ["mobile", "desktop"]) {
    const ctx = await newCtx(browser, vp, "light", { ss: { sp_unlock_later: "1" } });
    await mockGitHub(ctx, st);
    const page = await newPage(ctx);
    await go(page, base, "#/channels", ".cbox");
    const order0 = await page.$$eval(".cgroup", (els) => els.map((e) => e.getAttribute("data-page")));
    async function hitTest(label) {
      const btns = await page.$$eval(".branch a", (els) => els.map((a, i) => { a.scrollIntoView({ block: "center" }); const r = a.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2; const hit = document.elementFromPoint(x, y); return { i, href: a.getAttribute("href"), cls: a.className, own: !!hit && hit.closest("a") === a, w: r.width, h: r.height }; }));
      btns.forEach((b) => ok(b.own, `${vp} ${label}: link ${b.cls} ${b.href} is covered by another element at its centre`));
      btns.filter((b) => /chartbtn/.test(b.cls)).forEach((b) => ok(b.w >= 40 && b.h >= 40, `${vp} ${label}: chart button too small ${b.w}x${b.h}`));
      // no two links overlap
      const rects = await page.$$eval(".branch a", (els) => els.map((a) => { const r = a.getBoundingClientRect(); return [r.left, r.top + window.scrollY, r.right, r.bottom + window.scrollY, a.getAttribute("href")]; }));
      for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) { const a = rects[i], b = rects[j]; const ov = a[0] < b[2] - 0.5 && b[0] < a[2] - 0.5 && a[1] < b[3] - 0.5 && b[1] < a[3] - 0.5; ok(!ov, `${vp} ${label}: ${a[4]} overlaps ${b[4]}`); }
      return btns;
    }
    async function clickAllCharts(label, useTap) {
      const routes = await page.$$eval(".chartbtn", (els) => els.map((a) => a.getAttribute("href")));
      for (const href of routes) {
        const el = await page.$(`.chartbtn[href="${href}"]`);
        await el.scrollIntoViewIfNeeded();
        const bb = await el.boundingBox();
        const x = bb.x + bb.width / 2, y = bb.y + bb.height / 2;
        if (useTap) await page.touchscreen.tap(x, y); else await page.mouse.click(x, y);
        await page.waitForSelector(".ahead");
        const [, , pid, pl] = href.split("/");
        const got = await page.evaluate(() => ({ h: location.hash, p: document.querySelector(".ahead").getAttribute("data-page"), pl: document.querySelector(".ahead").getAttribute("data-platform") }));
        ok(got.h === href && got.p === pid && got.pl === pl, `${vp} ${label}: tapping ${href} opened ${got.h} (${got.p}/${got.pl})`);
        await page.goBack(); await page.waitForSelector(".cbox");
      }
      return routes.length;
    }
    // collapsed: no chart links at all, and the group buttons are tappable
    ok((await page.$$(".chartbtn")).length === 0 || (await page.$$(".cgroup.open")).length > 0, `${vp}: collapsed groups must not render chart links`);
    // each group alone, then all open
    for (const id of order0) {
      await page.evaluate(() => sessionStorage.setItem("sp_open", "{}")); await page.reload(); await page.waitForSelector(".cbox");
      await page.click(`.cbox[data-id="${id}"]`);
      await hitTest(`only ${id} open`);
      const n = await clickAllCharts(`only ${id} open`, vp === "mobile");
      ok(n === 4, `${vp}: ${id} should have 4 chart links, has ${n}`);
    }
    await page.evaluate((ids) => sessionStorage.setItem("sp_open", JSON.stringify(Object.fromEntries(ids.map((i) => [i, true])))), order0);
    await page.reload(); await page.waitForSelector(".branch");
    const before = await hitTest("all open");
    // background events must not move anything: token-sync check, data reload, fonts
    const pos0 = await page.$$eval(".chartbtn", (els) => els.map((a) => { const r = a.getBoundingClientRect(); return [a.getAttribute("href"), Math.round(r.top + window.scrollY), Math.round(r.left)]; }));
    await page.evaluate(() => window.__spDebug.load(true));
    await page.evaluate(() => window.__spDebug.mutateActivity());
    await page.evaluate(() => window.__spDebug.syncOnStart());
    await page.waitForTimeout(300);
    const pos1 = await page.$$eval(".chartbtn", (els) => els.map((a) => { const r = a.getBoundingClientRect(); return [a.getAttribute("href"), Math.round(r.top + window.scrollY), Math.round(r.left)]; }));
    ok(JSON.stringify(pos0) === JSON.stringify(pos1), `${vp}: chart links moved after background reload/sync`);
    // even an explicit re-render keeps the visit's order
    await page.evaluate(() => window.__spDebug.render());
    const order1 = await page.$$eval(".cgroup", (els) => els.map((e) => e.getAttribute("data-page")));
    ok(order1.join() === order0.join(), `${vp}: channel order changed within the visit ${order1} vs ${order0}`);
    await hitTest("all open after reload");
    const n = await clickAllCharts("all open", vp === "mobile");
    ok(n === config.pages.length * 4, `${vp}: expected ${config.pages.length * 4} chart links, got ${n}`);
    // admin ("ورود") links
    const adm = await page.$$eval(".branch", (els) => els.map((b) => ({ pl: b.getAttribute("data-pl"), page: b.getAttribute("data-page"), hrefs: [...b.querySelectorAll("a.adm")].map((a) => a.href), target: [...b.querySelectorAll("a.adm")].map((a) => a.target) })));
    for (const a of adm) {
      const t = `${vp} admin ${a.page}/${a.pl}`;
      ok(a.target.every((x) => x === "_blank"), `${t}: must open in a new tab`);
      if (a.pl === "instagram") ok(a.hrefs[0] === "https://www.instagram.com/accounts/login/?next=%2Faccounts%2Fprofessional_dashboard%2F" && a.hrefs[1] === "https://business.facebook.com/latest/home", `${t}: ${a.hrefs}`);
      if (a.pl === "aparat") ok(a.hrefs[0] === "https://www.aparat.com/dashboard", `${t}: ${a.hrefs}`);
      if (a.pl === "tiktok") ok(a.hrefs[0] === "https://www.tiktok.com/tiktokstudio", `${t}: ${a.hrefs}`);
      if (a.pl === "youtube") ok(/^https:\/\/accounts\.google\.com\/ServiceLogin\?service=youtube&continue=https%3A%2F%2Fstudio\.youtube\.com%2F/.test(a.hrefs[0]), `${t}: ${a.hrefs}`);
    }
    ok(await page.$(".adm-note"), `${vp}: multi-account note missing`);
    ok(!page._errors.length, `${vp} links: page errors ` + page._errors.slice(0, 3).join(" | "));
    await ctx.close();
  }

  // ================================================================ 4. tools
  {
    const ctx = await newCtx(browser, "mobile", "light", { ss: { sp_unlock_later: "1" } });
    await mockGitHub(ctx, st);
    const page = await newPage(ctx);
    await go(page, base, "#/", "#toolbox");
    await page.click("#toolbox"); await page.waitForSelector("#tlist");
    const T = config.tools;
    const names = await page.$$eval(".tool .tn b", (els) => els.map((e) => e.textContent));
    ok(JSON.stringify(names) === JSON.stringify(T.items.map((i) => i.name)), `tools list ${names}`);
    ok(!/@/.test(await page.$eval("#tlist", (e) => e.innerText)) && !/@/.test(JSON.stringify(T)), "tools must not show or store e-mail addresses");
    for (const it of T.items) {
      await page.click(`.tool[data-tool="${it.id}"] .thead`);
      await page.waitForSelector(`.tool.open[data-tool="${it.id}"]`);
      const accs = await page.$$eval(`.tool[data-tool="${it.id}"] .tacc`, (els) => els.map((a) => ({ name: a.textContent, href: a.getAttribute("href"), target: a.target })));
      if (!it.url) {
        ok(!accs.length && /لینک تنظیم نشده/.test(await page.$eval(`.tool[data-tool="${it.id}"]`, (e) => e.innerText)), `tools ${it.id}: should say link not set`);
        ok(it.editable && await page.$(`#turl-${it.id}`), `tools ${it.id}: editable link field`);
        await page.fill(`#turl-${it.id}`, "muse.example.com/app"); await page.click(`.turl[data-tool="${it.id}"] button`);
        await page.waitForSelector(`.tool[data-tool="${it.id}"] .tacc`);
        const a2 = await page.$$eval(`.tool[data-tool="${it.id}"] .tacc`, (els) => els.map((a) => a.getAttribute("href")));
        ok(a2.length === 2 && a2.every((h) => h === "https://muse.example.com/app"), `tools ${it.id}: saved link ${a2}`);
        await page.reload(); await page.waitForSelector(`.tool[data-tool="${it.id}"] .tacc`);
        ok(await page.$eval(`#turl-${it.id}`, (e) => e.value) === "https://muse.example.com/app", `tools ${it.id}: link kept after reload`);
        continue;
      }
      ok(accs.length === 2 && accs[0].name === "نگین" && accs[1].name === "امیرحسین", `tools ${it.id}: account buttons ${JSON.stringify(accs)}`);
      ok(accs.every((a) => a.href === it.url && a.target === "_blank"), `tools ${it.id}: buttons must open ${it.url} (${accs.map((a) => a.href)})`);
    }
    ok(!(await page.$$eval("#tlist img", (e) => e.length)), "tools must not hotlink images");
    ok(!page._errors.length, "tools: page errors " + page._errors.slice(0, 3).join(" | "));
    await ctx.close();
  }

  // ================================================================ 5. token unlock flow (patched login hash)
  {
    const { srv: srv2, url: base2 } = await serve(FX, { override: { "/app.js": patchedApp } });
    const st2 = { remote: encryptLikeApp(TOKEN, P) };
    // a) already logged in on this device, no token, synced copy exists -> modal on a normal page
    let ctx = await newCtx(browser, "mobile", "light", { hash: testHash });
    await mockGitHub(ctx, st2);
    let page = await newPage(ctx);
    await go(page, base2, "#/channels", ".cbox");
    await page.waitForSelector("#unlock-modal", { timeout: 8000 });
    ok(/برای فعال‌سازی اتصال، رمز پنل را یک بار وارد کن/.test(await page.$eval("#unlock-modal", (e) => e.innerText)), "modal text");
    await page.fill("#unlock-pw", "wrong-password"); await page.click("#unlock-go");
    await page.waitForSelector('#unlock-msg[data-state="error"]', { timeout: 20000 });
    ok(/این رمز درست نیست/.test(await page.textContent("#unlock-msg")), "wrong password message");
    ok(!(await page.evaluate(() => localStorage.getItem("sp_gh_token"))), "no token after wrong password");
    await page.fill("#unlock-pw", P); await page.click("#unlock-go");
    await page.waitForSelector("#unlock-modal", { state: "detached", timeout: 20000 });
    ok(await page.evaluate(() => localStorage.getItem("sp_gh_token")) === TOKEN, "token stored after unlock");
    await hashTo(page, "#/publish", "#pubform");
    ok(true, "publish form shown after unlock");
    await hashTo(page, "#/settings", "#token-status");
    await page.waitForSelector('#token-status[data-state="connected"]', { timeout: 10000 });
    ok(!(await page.$("#unlock-card")), "settings must not ask again once connected");
    ok(!page._errors.length, "unlock a: page errors " + page._errors.join(" | "));
    await ctx.close();
    // b) direct to #/publish: inline form, no modal; "later" on the modal keeps publish inline
    ctx = await newCtx(browser, "desktop", "dark", { hash: testHash });
    await mockGitHub(ctx, st2);
    page = await newPage(ctx);
    await go(page, base2, "#/publish", "#topbar");
    await page.waitForSelector("#pub-unlock", { timeout: 8000 });
    ok(!(await page.$("#unlock-modal")), "publish page uses the inline form, not the modal");
    await hashTo(page, "#/settings", "#unlock-card");
    ok(await page.$("#token-status[data-state='none']"), "settings shows not connected while locked");
    await hashTo(page, "#/", ".boxes");
    await page.waitForSelector("#unlock-modal");
    ok(/رمز پنل/.test(await page.$eval("#pubbox", (e) => e.innerText)), "home publish box mentions the panel password");
    await page.click("#unlock-later");
    await hashTo(page, "#/channels", ".cbox");
    ok(!(await page.$("#unlock-modal")), "'later' hides the modal for this session");
    await hashTo(page, "#/publish", "#pub-unlock");
    await page.fill("#punlock-pw", P); await page.click("#punlock-go");
    await page.waitForSelector("#pubform", { timeout: 20000 });
    ok(await page.evaluate(() => localStorage.getItem("sp_gh_token")) === TOKEN, "token stored from publish page");
    await ctx.close();
    // c) API down -> raw.githubusercontent fallback still unlocks
    const st3 = { remote: st2.remote, apiDown: true };
    ctx = await newCtx(browser, "mobile", "light", { hash: testHash });
    await mockGitHub(ctx, st3);
    page = await newPage(ctx);
    await go(page, base2, "#/settings", "#unlock-card");
    await page.fill("#sunlock-pw", P); await page.click("#sunlock-go");
    await page.waitForSelector('#token-status[data-state="connected"]', { timeout: 20000 });
    ok(st3.rawHits > 0, "raw.githubusercontent fallback used when the API fails");
    await ctx.close();
    // d) fresh login: password typed at login opens the synced token, no modal
    ctx = await newCtx(browser, "mobile", "light", { noAuth: true });
    await mockGitHub(ctx, st2);
    page = await newPage(ctx);
    await go(page, base2, "#/", "#lf");
    await page.fill("#u", U); await page.fill("#p", P); await page.click("#lf button[type=submit]");
    await page.waitForFunction((t) => localStorage.getItem("sp_gh_token") === t, TOKEN, { timeout: 20000 });
    await page.waitForTimeout(300);
    ok(!(await page.$("#unlock-modal")), "no modal after a login that unlocked the token");
    await ctx.close();
    // e) login, but the synced copy was made with another password -> modal is forced
    const st4 = { remote: encryptLikeApp(TOKEN, "some-other-password") };
    ctx = await newCtx(browser, "mobile", "light", { noAuth: true, ss: { sp_unlock_later: "1" } });
    await mockGitHub(ctx, st4);
    page = await newPage(ctx);
    await go(page, base2, "#/", "#lf");
    await page.fill("#u", U); await page.fill("#p", P); await page.click("#lf button[type=submit]");
    await page.waitForSelector("#unlock-modal", { timeout: 20000 });
    ok(true, "modal forced after login when the synced copy needs another password");
    await ctx.close();
    // f) the real committed config/token.enc.json: format accepted, wrong password rejected cleanly
    const realEnc = J(path.join(REPO, "config/token.enc.json"));
    ok(realEnc.v === 1 && Buffer.from(realEnc.salt, "base64").length === 16 && Buffer.from(realEnc.iv, "base64").length === 12 && Buffer.from(realEnc.ct, "base64").length > 16 && !isNaN(Date.parse(realEnc.created_at)), "real token.enc.json has the expected format");
    const st5 = { remote: realEnc };
    ctx = await newCtx(browser, "mobile", "light", { hash: testHash });
    await mockGitHub(ctx, st5);
    page = await newPage(ctx);
    await go(page, base2, "#/channels", ".cbox");
    await page.waitForSelector("#unlock-modal", { timeout: 8000 });
    await page.fill("#unlock-pw", "definitely-not-the-password"); await page.click("#unlock-go");
    await page.waitForSelector('#unlock-msg[data-state="error"]', { timeout: 20000 });
    ok(/این رمز درست نیست/.test(await page.textContent("#unlock-msg")), "real enc file: wrong password -> clear message");
    ok(!page._errors.length, "real enc: page errors " + page._errors.join(" | "));
    await ctx.close();
    srv2.close();
  }

  // ================================================================ 6. service worker update -> exactly one reload
  {
    let swVer = "v6";
    const swSrc = fs.readFileSync(path.join(FX, "sw.js"), "utf8");
    const { srv: srv3, url: base3 } = await serve(FX, { override: { "/sw.js": () => swSrc.replace('const VERSION = "v6"', `const VERSION = "${swVer}"`) } });
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "allow" });
    await ctx.addInitScript((h) => { localStorage.setItem("sp_auth", h); sessionStorage.setItem("sp_unlock_later", "1"); }, REAL_HASH);
    await ctx.route(/https:\/\/(api\.github\.com|raw\.githubusercontent\.com|fonts\.googleapis\.com|fonts\.gstatic\.com)\/.*/, (r) => r.fulfill({ status: 404, body: "" }));
    const page = await ctx.newPage();
    let navs = 0; page.on("framenavigated", (f) => { if (f === page.mainFrame()) navs++; });
    await page.goto(base3 + "#/channels"); await page.waitForSelector(".cbox");
    await page.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 15000 });
    await page.waitForTimeout(500);
    const n0 = navs;
    swVer = "v6-test2";
    await page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r.update()));
    await page.waitForTimeout(4000);
    ok(navs - n0 === 1, `SW update should reload the page exactly once (got ${navs - n0})`);
    const keys = await page.evaluate(() => caches.keys());
    ok(keys.every((k) => /v6-test2/.test(k)), `old caches must be removed: ${keys}`);
    await ctx.close(); srv3.close();
  }

  await browser.close(); srv.close();
  console.log(`${checks} checks, ${fails.length} failed`);
  fails.slice(0, 80).forEach((f) => console.log("FAIL " + f));
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
