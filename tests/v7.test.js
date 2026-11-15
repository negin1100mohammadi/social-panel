// v7 end-to-end tests: YouTube official connection (headless Chromium via Playwright; GitHub + Google mocked).
// usage: FIXTURE_NOW=<ms> node tests/v7.test.js <fixture_dir>      (fixture from tests/make_fixture.py)
// Covers: "اتصال" buttons on every YouTube row (390 px + desktop; visible, tappable, chart button still hit-testable),
// the Google OAuth URL (every parameter) + state nonce in sessionStorage, no-token guard, statuses (none/ok/mismatch/
// revoked), analytics card + comments inbox (newest first) + queued reply -> yt-reply.yml dispatch payload -> result,
// settings "حساب‌های متصل", oauth.html (state check, dispatch payload, polling, result, mismatch, Google error,
// no token, code removed from the address bar), service worker never caching oauth.html.
const { chromium } = require("playwright");
const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto");

const FX = process.argv[2];
const NOW = Number(process.env.FIXTURE_NOW);
if (!FX || !NOW) { console.error("usage: FIXTURE_NOW=ms node tests/v7.test.js <fixture_dir>"); process.exit(2); }
const U = "tester", P = "test-pass-123", TOKEN = "github_pat_TESTTOKEN_v7_abc123";
const REAL_HASH = "1b906a20e9fea1a47f58c9c56aa49688acb2dd0ba5fba3188825f252401a3ba8";
let checks = 0; const fails = [];
const ok = (c, m) => { checks++; if (!c) fails.push(m); };
const J = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const config = J(path.join(FX, "config.json"));
const ytPages = config.pages.filter((p) => p.accounts && p.accounts.youtube).map((p) => p.id);
const [P1, P2, P3] = ytPages;
const CH = (c) => "UC" + c.repeat(22);

const appSrc = fs.readFileSync(path.join(FX, "app.js"), "utf8");
const salt = /var AUTH_SALT = "([^"]+)"/.exec(appSrc)[1];
const testHash = crypto.createHash("sha256").update(salt + U + "|" + P).digest("hex");
const patchedApp = appSrc.replace(/var AUTH_HASH = "[0-9a-f]+"/, 'var AUTH_HASH = "' + testHash + '"');

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");
const comments = { v: 1, channels: { [P1 + "/youtube"]: { channel_id: CH("A"), fetched_at: iso(NOW - 600e3), threads: [
  { id: "Ugx-old", comment_id: "Ugx-old", video_id: "vid1", video_title: "ویدیوی اول", author: "Old Fan", text: "کامنت قدیمی", likes: 3, published: iso(NOW - 5 * 86400e3), reply_count: 1, can_reply: true,
    replies: [{ id: "Ugx-old.r1", author: "Owner", text: "ممنون", published: iso(NOW - 4 * 86400e3) }] },
  { id: "Ugx-new", comment_id: "Ugx-new", video_id: "vid2", video_title: "ویدیوی دوم", author: "New Fan", text: "<b>عالی</b> بود", likes: 0, published: iso(NOW - 3600e3), reply_count: 0, can_reply: true, replies: [] },
  { id: "Ugx-mid", comment_id: "Ugx-mid", video_id: "vid2", video_title: "ویدیوی دوم", author: "Mid Fan", text: "وسط", likes: 1, published: iso(NOW - 86400e3), reply_count: 0, can_reply: false, replies: [] }] } } };
function store(kind) {
  const ch = {};
  ch[CH("A")] = { page: P1, channel_id: CH("A"), title: "Channel A", handle: "@chana", expected_channel_id: CH("A"), mismatch: false, connected_at: iso(NOW - 7200e3), status: "ok", iv: "AAAA", ct: "BBBB" };
  if (kind !== "one") ch[CH("B")] = { page: P2, channel_id: CH("B"), title: "Wrong Channel", expected_channel_id: CH("C"), mismatch: true, connected_at: iso(NOW - 3600e3), status: "ok", iv: "AAAA", ct: "BBBB" };
  return { v: 1, updated_at: iso(NOW - 3600e3), channels: ch };
}

function serve(dir, override = {}) {
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".jpg": "image/jpeg" };
  return new Promise((res) => {
    const srv = http.createServer((q, s) => {
      const u = decodeURIComponent(q.url.split("?")[0]);
      if (override[u] != null) { const b = typeof override[u] === "function" ? override[u]() : override[u]; s.writeHead(200, { "Content-Type": types[path.extname(u)] || "text/plain" }); return s.end(b); }
      let f = path.join(dir, u); if (f.endsWith("/")) f += "index.html";
      fs.readFile(f, (e, d) => { if (e) { s.writeHead(404); s.end(); } else { s.writeHead(200, { "Content-Type": types[path.extname(f)] || "application/octet-stream" }); s.end(d); } });
    }).listen(0, () => res({ srv, url: "http://127.0.0.1:" + srv.address().port + "/" }));
  });
}

// GitHub API mock: workflows dispatch + runs + contents of config files
async function mockGitHub(ctx, st) {
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "GET,PUT,DELETE,POST" };
  st.dispatches = []; st.runs = st.runs || {};
  await ctx.route(/https:\/\/(api\.github\.com|raw\.githubusercontent\.com)\/.*/, async (route) => {
    const r = route.request(), url = new URL(r.url()), m = r.method();
    if (m === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const json = (code, b) => route.fulfill({ status: code, headers: { ...cors, "Content-Type": "application/json" }, body: b === undefined ? "" : JSON.stringify(b) });
    const auth = r.headers()["authorization"] || "";
    const pth = url.pathname;
    let mm;
    if (pth.endsWith("/config/token.enc.json")) return json(404, { message: "Not Found" });
    if (pth.endsWith("/config/yt_tokens.enc.json")) { st.storeHits = (st.storeHits || 0) + 1; return st.store ? json(200, st.store) : json(404, {}); }
    if (pth.endsWith("/config/yt_replies.json")) return json(200, st.replies || { items: [] });
    if (pth.endsWith("/config/yt_connect_last.json")) { if (auth !== "Bearer " + TOKEN) return json(401, {}); return json(200, st.connectResult ? st.connectResult(st) : {}); }
    if ((mm = /\/actions\/workflows\/([\w.-]+)\/dispatches$/.exec(pth)) && m === "POST") {
      if (auth !== "Bearer " + TOKEN) return json(401, { message: "Bad credentials" });
      const body = JSON.parse(r.postData() || "{}");
      st.dispatches.push({ wf: mm[1], body });
      const id = 1000 + st.dispatches.length;
      st.runs[id] = { id, display_title: (mm[1] === "yt-connect.yml" ? "yt-connect " : "yt-reply ") + body.inputs.page + " " + body.inputs.req, created_at: new Date().toISOString(), status: "queued", polls: 0, wf: mm[1] };
      return json(204);
    }
    if ((mm = /\/actions\/workflows\/([\w.-]+)\/runs$/.exec(pth))) return json(200, { workflow_runs: Object.values(st.runs).filter((x) => x.wf === mm[1]).reverse() });
    if ((mm = /\/actions\/runs\/(\d+)$/.exec(pth))) {
      const run = st.runs[mm[1]]; run.polls++;
      if (run.polls >= 2) { run.status = "completed"; run.conclusion = st.conclusion || "success"; if (st.onComplete) st.onComplete(run); } else run.status = "in_progress";
      return json(200, run);
    }
    if (/^\/repos\/negin1100mohammadi\/social-panel\/?$/.test(pth)) return json(200, { permissions: { push: true } });
    if (/\/actions\/workflows$/.test(pth)) return json(200, { workflows: [] });
    if (/\/contents\/queue/.test(pth)) return json(200, []);
    return json(404, { message: "Not Found" });
  });
  await ctx.route(/^https:\/\/(fonts\.googleapis|fonts\.gstatic)\.com\/.*/, (r) => r.fulfill({ status: 200, body: "" }));
  await ctx.route(/^https:\/\/(yt3|i)\.(ggpht|ytimg|example)\.com\/.*/, (r) => r.fulfill({ status: 404, body: "" }));
  await ctx.route(/^https:\/\/accounts\.google\.com\/.*/, (r) => { st.googleHits = (st.googleHits || 0) + 1; r.fulfill({ status: 200, contentType: "text/html", body: "<p>google</p>" }); });
}
const VPS = { mobile: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, desktop: { viewport: { width: 1280, height: 900 } } };
async function newCtx(browser, vp, init = {}) {
  const ctx = await browser.newContext({ ...VPS[vp], serviceWorkers: "block", locale: "fa-IR", timezoneId: "Asia/Tehran" });
  await ctx.addInitScript(([h, extra]) => {
    if (h) localStorage.setItem("sp_auth", h);
    sessionStorage.setItem("sp_unlock_later", "1");
    for (const [k, v] of Object.entries(extra.ls || {})) if (localStorage.getItem(k) == null) localStorage.setItem(k, v);
    for (const [k, v] of Object.entries(extra.ss || {})) if (sessionStorage.getItem(k) == null) sessionStorage.setItem(k, v);
    window.__spNoNavigate = !!extra.noNav; window.__oauthNoRedirect = !!extra.noRedirect;
  }, [init.noAuth ? null : testHash, { ls: init.ls || {}, ss: init.ss || {}, noNav: init.noNav !== false, noRedirect: !!init.noRedirect }]);
  return ctx;
}
const until = async (fn, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 150)); } return null; };

(async () => {
  const { srv, url: base } = await serve(FX, { "/app.js": patchedApp, "/data/comments.json": JSON.stringify(comments) });
  const browser = await chromium.launch();
  try {
    // ============================================================ 1. channel rows: buttons, statuses, hit-testing
    for (const vp of ["mobile", "desktop"]) {
      const st = { store: store() };
      const ctx = await newCtx(browser, vp, { ls: { sp_gh_token: TOKEN } });
      await mockGitHub(ctx, st);
      const page = await ctx.newPage();
      const open = {}; ytPages.forEach((id) => (open[id] = true));
      await page.addInitScript((o) => sessionStorage.setItem("sp_open", JSON.stringify(o)), open);
      await page.goto(base + "#/channels");
      await page.waitForSelector("#clist");
      await until(() => page.evaluate(() => document.querySelector("button[data-ytc]") && document.querySelector("button[data-ytc]").getAttribute("data-st") !== "unknown"));
      const rows = await page.evaluate(() => Array.from(document.querySelectorAll('.branch[data-pl="youtube"]')).map((b) => {
        const btn = b.querySelector("button[data-ytc]"), ch = b.querySelector(".chartbtn");
        b.scrollIntoView({ block: "center" });
        const r = btn.getBoundingClientRect(), c = ch.getBoundingClientRect(), br = b.getBoundingClientRect();
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        const hit = document.elementFromPoint(cx, cy), hitC = document.elementFromPoint(c.left + c.width / 2, c.top + c.height / 2);
        return { page: btn.getAttribute("data-ytc"), st: btn.getAttribute("data-st"), text: btn.textContent, w: r.width, h: r.height,
          inside: r.left >= br.left - 1 && r.right <= br.right + 1, overlap: !(r.right <= c.left || c.right <= r.left), hitOk: hit === btn || btn.contains(hit),
          chartOk: !!hitC && (hitC === ch || ch.contains(hitC)), vw: innerWidth, right: r.right, left: r.left };
      }));
      ok(rows.length === ytPages.length, `${vp}: one connect button per YouTube row (${rows.length}/${ytPages.length})`);
      for (const r of rows) {
        ok(r.w >= 60 && r.h >= 36, `${vp} ${r.page}: button size ${r.w}x${r.h}`);
        ok(r.inside && !r.overlap && r.left >= 0 && r.right <= r.vw, `${vp} ${r.page}: button inside its row, not over the chart button`);
        ok(r.hitOk, `${vp} ${r.page}: button is the element at its centre`);
        ok(r.chartOk, `${vp} ${r.page}: chart button still hit-testable`);
        const want = r.page === P1 ? ["ok", "متصل ✓"] : r.page === P2 ? ["mismatch", "اتصال دوباره"] : ["none", "اتصال"];
        ok(r.st === want[0] && r.text === want[1], `${vp} ${r.page}: status ${r.st}/${r.text}, want ${want}`);
      }
      // no other platform row got a connect button
      ok(await page.evaluate(() => document.querySelectorAll('.branch:not([data-pl="youtube"]) button[data-ytc]').length === 0), `${vp}: connect only on YouTube rows`);
      // OAuth URL
      await page.click(`.branch[data-pl="youtube"][data-page="${P3}"] button[data-ytc]`);
      const u = await page.evaluate(() => window.__spLastOAuth);
      const saved = JSON.parse(await page.evaluate(() => sessionStorage.getItem("sp_oauth_state")) || "{}");
      ok(!!u, `${vp}: click builds an OAuth URL`);
      if (u) {
        const q = new URL(u);
        ok(q.origin + q.pathname === "https://accounts.google.com/o/oauth2/v2/auth", `${vp}: endpoint ${q.pathname}`);
        const g = (k) => q.searchParams.get(k);
        ok(g("client_id") === config.youtube_oauth.client_id && /\.apps\.googleusercontent\.com$/.test(g("client_id")), `${vp}: client_id`);
        ok(g("redirect_uri") === "https://negin1100mohammadi.github.io/social-panel/oauth.html", `${vp}: redirect_uri`);
        ok(g("response_type") === "code" && g("access_type") === "offline" && g("prompt") === "consent select_account" && g("include_granted_scopes") === "true", `${vp}: flow params`);
        ok(g("scope").split(" ").sort().join(" ") === ["https://www.googleapis.com/auth/youtube.force-ssl", "https://www.googleapis.com/auth/youtube.readonly", "https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/yt-analytics.readonly"].join(" "), `${vp}: scopes ${g("scope")}`);
        ok(g("state") === P3 + "." + saved.nonce && /^[0-9a-f]{32}$/.test(saved.nonce) && saved.page === P3, `${vp}: state = page + nonce from sessionStorage`);
        ok(!/%2B|\+/.test(u.split("prompt=")[1].split("&")[0]) && /prompt=consent%20select_account/.test(u), `${vp}: prompt encoded with %20`);
      }
      // connected channel asks before reconnecting
      let dialogs = 0; page.on("dialog", (d) => { dialogs++; d.dismiss(); });
      await page.evaluate(() => { window.__spLastOAuth = null; });
      await page.click(`.branch[data-pl="youtube"][data-page="${P1}"] button[data-ytc]`);
      ok(dialogs === 1 && !(await page.evaluate(() => window.__spLastOAuth)), `${vp}: connected channel asks before reconnecting (dismiss = no navigation)`);
      await ctx.close();
    }
    // no token: no navigation, sent to settings
    {
      const st = { store: store() };
      const ctx = await newCtx(browser, "mobile");
      await mockGitHub(ctx, st);
      const page = await ctx.newPage();
      await page.addInitScript((p) => sessionStorage.setItem("sp_open", JSON.stringify({ [p]: true })), P3);
      await page.goto(base + "#/channels");
      await page.waitForSelector("button[data-ytc]");
      await page.click("button[data-ytc]");
      await page.waitForTimeout(300);
      ok(!(await page.evaluate(() => window.__spLastOAuth)) && /#\/settings/.test(page.url()), "no GitHub token: no OAuth, goes to settings");
      await ctx.close();
    }
    // real navigation reaches accounts.google.com (mocked) with the same URL
    {
      const st = { store: store() };
      const ctx = await newCtx(browser, "mobile", { ls: { sp_gh_token: TOKEN }, noNav: false });
      await mockGitHub(ctx, st);
      const page = await ctx.newPage();
      await page.addInitScript((p) => sessionStorage.setItem("sp_open", JSON.stringify({ [p]: true })), P3);
      await page.goto(base + "#/channels");
      await page.waitForSelector(`.branch[data-pl="youtube"] button[data-ytc]`);
      await Promise.all([page.waitForURL(/accounts\.google\.com/), page.click(`.branch[data-pl="youtube"] button[data-ytc]`)]);
      ok(/^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?client_id=/.test(page.url()), "button navigates to Google consent");
      await ctx.close();
    }

    // ============================================================ 2. analytics: card + inbox + queued reply
    {
      const st = { store: store(), replies: { items: [] } };
      st.onComplete = (run) => { if (run.wf === "yt-reply.yml") { const b = st.dispatches[st.dispatches.length - 1].body.inputs; st.replies = { items: [{ req: b.req, page: b.page, parent_id: b.parent_id, text: b.text, status: "sent", reply_id: "Ugx-reply-9" }] }; } };
      const ctx = await newCtx(browser, "mobile", { ls: { sp_gh_token: TOKEN } });
      await mockGitHub(ctx, st);
      const page = await ctx.newPage();
      await page.goto(base + "#/a/" + P1 + "/youtube");
      await page.waitForSelector("#yt-conn-card");
      await until(() => page.evaluate(() => document.querySelectorAll("#yt-inbox .cmt").length > 0));
      const card = await page.evaluate(() => ({ pill: document.querySelector("#yt-conn-card .pill").getAttribute("data-yst"), txt: document.getElementById("yt-conn-card").textContent, btn: !!document.querySelector("#yt-conn-card button[data-ytc]") }));
      ok(card.pill === "ok" && /Channel A/.test(card.txt) && card.btn, "analytics card: connected status + channel + connect button");
      const order = await page.evaluate(() => Array.from(document.querySelectorAll("#yt-inbox .cmt")).map((c) => c.getAttribute("data-thread")));
      ok(order.join(",") === "Ugx-new,Ugx-mid,Ugx-old", "inbox newest first: " + order);
      ok(await page.evaluate(() => !document.querySelector('#yt-inbox .cmt[data-thread="Ugx-new"] .ctext b') && /<b>عالی<\/b>/.test(document.querySelector('#yt-inbox .cmt[data-thread="Ugx-new"] .ctext').textContent)), "comment text is escaped");
      ok(await page.evaluate(() => !document.querySelector('.cmt[data-thread="Ugx-mid"] form.rform') && !!document.querySelector('.cmt[data-thread="Ugx-new"] form.rform')), "reply box only where replies are allowed");
      ok(await page.evaluate(() => /ممنون/.test(document.querySelector('.cmt[data-thread="Ugx-old"] .creps').textContent)), "existing replies shown");
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      ok(overflow <= 1, "analytics page has no horizontal overflow: " + overflow);
      await page.fill('.cmt[data-thread="Ugx-new"] textarea', "خیلی ممنون 🌟");
      await page.click('.cmt[data-thread="Ugx-new"] form.rform button');
      await until(() => st.dispatches.length > 0);
      const d = st.dispatches[0];
      ok(d && d.wf === "yt-reply.yml" && d.body.ref === "main" && d.body.inputs.page === P1 && d.body.inputs.parent_id === "Ugx-new" && d.body.inputs.text === "خیلی ممنون 🌟" && /^r[0-9a-z]+$/.test(d.body.inputs.req), "reply dispatch payload " + JSON.stringify(d && d.body));
      ok(await until(() => page.evaluate(() => { const x = document.querySelector('.cmt[data-thread="Ugx-new"] .crep.mine'); return x && x.getAttribute("data-rst") === "queued"; }), 4000), "reply shows as queued");
      ok(await until(() => page.evaluate(() => { const x = document.querySelector('.cmt[data-thread="Ugx-new"] .crep.mine'); return x && x.getAttribute("data-rst") === "sent" && /ارسال شد/.test(x.textContent); }), 20000), "reply shows as sent after the run finished");
      await ctx.close();
    }
    // not connected page: card says so, inbox asks to connect
    {
      const st = { store: store("one") };
      const ctx = await newCtx(browser, "mobile", { ls: { sp_gh_token: TOKEN } });
      await mockGitHub(ctx, st);
      const page = await ctx.newPage();
      await page.goto(base + "#/a/" + P2 + "/youtube");
      await until(() => page.evaluate(() => document.querySelector("#yt-conn-card .pill") && document.querySelector("#yt-conn-card .pill").getAttribute("data-yst") !== "unknown"));
      ok(await page.evaluate(() => document.querySelector("#yt-conn-card .pill").getAttribute("data-yst") === "none" && document.querySelector("#yt-conn-card button[data-ytc]").textContent === "اتصال"), "unconnected page: status none + اتصال");
      ok(await page.evaluate(() => (document.getElementById("inbox-empty") || {}).getAttribute && document.getElementById("inbox-empty").getAttribute("data-why") === "none"), "unconnected inbox asks to connect");
      await ctx.close();
    }
    // revoked (refresh run reported invalid_grant after connecting)
    {
      const st = { store: store("one") };
      const latest = J(path.join(FX, "data/latest.json"));
      latest.pages[P1].platforms.youtube = Object.assign(latest.pages[P1].platforms.youtube || {}, { oauth: { channel_id: CH("A"), status: "revoked", error: "revoked", at: iso(NOW - 60e3) } });
      const { srv: s2, url: b2 } = await serve(FX, { "/app.js": patchedApp, "/data/latest.json": JSON.stringify(latest), "/data/comments.json": JSON.stringify(comments) });
      const ctx = await newCtx(browser, "mobile", { ls: { sp_gh_token: TOKEN } });
      await mockGitHub(ctx, st);
      const page = await ctx.newPage();
      await page.goto(b2 + "#/settings");
      await until(() => page.evaluate(() => document.querySelector('.yacc[data-yst="revoked"]')));
      ok(await page.evaluate((p) => { const r = document.querySelector('.yacc[data-page="' + p + '"]'); return r && r.getAttribute("data-yst") === "revoked" && /اتصال دوباره/.test(r.textContent); }, P1), "revoked token shown in settings with reconnect");
      await ctx.close(); s2.close();
    }

    // ============================================================ 3. settings: connected accounts list
    for (const vp of ["mobile", "desktop"]) {
      const st = { store: store() };
      const ctx = await newCtx(browser, vp, { ls: { sp_gh_token: TOKEN } });
      await mockGitHub(ctx, st);
      const page = await ctx.newPage();
      await page.goto(base + "#/settings");
      await page.waitForSelector("#yt-accounts");
      await until(() => page.evaluate(() => !document.querySelector('.yacc[data-yst="unknown"]')));
      const rows = await page.evaluate(() => Array.from(document.querySelectorAll("#yt-accounts .yacc")).map((r) => ({ p: r.getAttribute("data-page"), s: r.getAttribute("data-yst"), t: r.textContent, btn: !!r.querySelector("button[data-ytc]") })));
      ok(rows.length === ytPages.length, `${vp} settings: one row per YouTube page`);
      ok(rows.every((r) => r.btn), `${vp} settings: every row has a connect button`);
      const r1 = rows.find((r) => r.p === P1), r2 = rows.find((r) => r.p === P2), r3 = rows.find((r) => r.p === P3);
      ok(r1 && r1.s === "ok" && /Channel A/.test(r1.t) && /متصل/.test(r1.t), `${vp} settings: connected row`);
      ok(r2 && r2.s === "mismatch" && /کانال دیگری/.test(r2.t), `${vp} settings: mismatch row`);
      ok(r3 && r3.s === "none" && /متصل نیست/.test(r3.t), `${vp} settings: unconnected row`);
      ok(await page.evaluate(() => /حساب‌های متصل/.test(document.getElementById("yt-accounts").textContent) && document.documentElement.scrollWidth - innerWidth <= 1), `${vp} settings: title, no overflow`);
      ok(await page.evaluate(() => /v7/.test(document.getElementById("app-version").textContent)), `${vp}: version v7`);
      await ctx.close();
    }

    // ============================================================ 4. oauth.html
    async function oauthRun(opts) {
      const st = Object.assign({}, opts.st || {});
      const ctx = await newCtx(browser, "mobile", { noAuth: true, noRedirect: !opts.redirect, ls: opts.noToken ? {} : { sp_gh_token: TOKEN }, ss: opts.saved ? { sp_oauth_state: JSON.stringify(opts.saved) } : {} });
      await mockGitHub(ctx, st);
      const page = await ctx.newPage();
      await page.goto(base + "oauth.html" + opts.qs);
      const urlAfter = page.url();
      await until(() => page.evaluate(() => window.__oauth && window.__oauth.done), opts.wait || 25000);
      const res = await page.evaluate(() => ({ o: window.__oauth, msg: document.getElementById("o-text").textContent, st: document.getElementById("o-msg").getAttribute("data-state"), back: document.getElementById("o-back").getAttribute("href"), ls: localStorage.getItem("sp_oauth_state"), ss: sessionStorage.getItem("sp_oauth_state") }));
      if (opts.redirect) { await page.waitForURL(/index|#\/a\//, { timeout: 8000 }).catch(() => {}); res.final = page.url(); }
      await ctx.close();
      return { res, st, urlAfter };
    }
    const nonce = "0123456789abcdef0123456789abcdef";
    {
      const okResult = (st) => ({ req: st.dispatches[0].body.inputs.req, ok: true, channel_id: CH("A"), title: "Channel A", mismatch: false });
      const { res, st, urlAfter } = await oauthRun({ qs: `?code=4%2F0SECRETCODE&scope=x&state=${P1}.${nonce}`, saved: { nonce, page: P1, at: Date.now() }, st: { connectResult: okResult }, redirect: true });
      const d = st.dispatches[0];
      ok(d && d.wf === "yt-connect.yml" && d.body.ref === "main" && d.body.inputs.code === "4/0SECRETCODE" && d.body.inputs.page === P1 && /^c[0-9a-z]+$/.test(d.body.inputs.req), "oauth.html dispatches yt-connect with code/page/req: " + JSON.stringify(d && d.body.inputs.page));
      ok(res.o.state === "ok" && /Channel A/.test(res.msg) && res.o.page === P1, "oauth.html success message: " + res.msg);
      ok(!/code=|state=/.test(urlAfter.split("#")[0].split("oauth.html")[1] || ""), "code removed from the address bar: " + urlAfter);
      ok(res.ls === null && res.ss === null, "state is single-use (both copies removed)");
      ok(/#\/a\/[\w-]+\/youtube$/.test(res.final || "") && res.final.indexOf(P1) > 0, "returns to the channel's YouTube page: " + res.final);
    }
    {
      const { res, st } = await oauthRun({ qs: `?code=4%2F0X&state=${P1}.ffffffffffffffffffffffffffffffff`, saved: { nonce, page: P1, at: Date.now() } });
      ok(st.dispatches.length === 0 && res.o.state === "error" && /state/.test(res.msg), "wrong nonce: refused, nothing dispatched");
    }
    {
      const { res, st } = await oauthRun({ qs: `?code=4%2F0X&state=${P2}.${nonce}`, saved: { nonce, page: P1, at: Date.now() } });
      ok(st.dispatches.length === 0 && res.o.state === "error", "page swapped in state: refused");
    }
    {
      const { res, st } = await oauthRun({ qs: `?code=4%2F0X&state=${P1}.${nonce}` });
      ok(st.dispatches.length === 0 && res.o.state === "error", "no saved state (other browser / replay): refused");
    }
    {
      const { res, st } = await oauthRun({ qs: `?code=4%2F0X&state=${P1}.${nonce}`, saved: { nonce, page: P1, at: Date.now() - 31 * 60000 } });
      ok(st.dispatches.length === 0 && res.o.state === "error" && /۳۰ دقیقه/.test(res.msg), "stale state (>30 min): refused");
    }
    {
      const { res, st } = await oauthRun({ qs: `?error=access_denied&state=${P1}.${nonce}`, saved: { nonce, page: P1, at: Date.now() } });
      ok(st.dispatches.length === 0 && res.o.state === "warn" && /اجازه/.test(res.msg) && res.ls === null, "Google access_denied: warning, nothing dispatched");
    }
    {
      const { res, st } = await oauthRun({ qs: `?code=4%2F0X&state=${P1}.${nonce}`, saved: { nonce, page: P1, at: Date.now() }, noToken: true });
      ok(st.dispatches.length === 0 && res.o.state === "error" && /گیت‌هاب/.test(res.msg), "no GitHub token on this device: clear error");
    }
    {
      const mm = (st) => ({ req: st.dispatches[0].body.inputs.req, ok: true, channel_id: CH("B"), title: "Wrong Channel", mismatch: true, expected_channel_id: CH("A") });
      const { res } = await oauthRun({ qs: `?code=4%2F0X&state=${P1}.${nonce}`, saved: { nonce, page: P1, at: Date.now() }, st: { connectResult: mm } });
      ok(res.o.state === "warn" && /Wrong Channel/.test(res.msg) && /تعریف‌شده/.test(res.msg), "mismatch result: warning in Persian");
    }
    {
      const bad = (st) => ({ req: st.dispatches[0].body.inputs.req, ok: false, error: "invalid_grant", error_fa: "کد تأیید منقضی یا قبلاً استفاده شده؛ دوباره «اتصال» را بزن." });
      const { res } = await oauthRun({ qs: `?code=4%2F0X&state=${P1}.${nonce}`, saved: { nonce, page: P1, at: Date.now() }, st: { connectResult: bad } });
      ok(res.o.state === "error" && /منقضی/.test(res.msg), "Google refused the code: Persian error shown");
    }
    {
      const { res } = await oauthRun({ qs: `?code=4%2F0X&state=${P1}.${nonce}`, saved: { nonce, page: P1, at: Date.now() }, st: { conclusion: "failure" } });
      ok(res.o.state === "error" && /ناموفق/.test(res.msg), "failed run: error shown");
    }
    {
      const { res } = await oauthRun({ qs: "" });
      ok(res.o.state === "warn", "direct visit: explains the page");
    }

    // ============================================================ 5. static checks
    const sw = fs.readFileSync(path.join(FX, "sw.js"), "utf8");
    ok(/const VERSION = "v7"/.test(sw) && /oauth\.html"\)\) return;/.test(sw), "sw.js v7 and never handles oauth.html");
    ok(/app\.js\?v=7/.test(fs.readFileSync(path.join(FX, "index.html"), "utf8")), "index.html loads app.js?v=7");
    const oh = fs.readFileSync(path.join(FX, "oauth.html"), "utf8");
    ok(/history\.replaceState/.test(oh) && !/console\.log/.test(oh), "oauth.html clears the URL and never logs");
  } catch (e) { fails.push("CRASH " + (e && e.stack || e)); }
  await browser.close(); srv.close();
  console.log(`${checks} checks, ${fails.length} failed`);
  fails.slice(0, 60).forEach((f) => console.log(" ✗ " + f));
  process.exit(fails.length ? 1 : 0);
})();
