// v11 tests: settings «حساب‌های متصل» = every brand (channel order) × every network in config.json, with status chips.
// usage: node tests/v11.test.js            (serves the repo itself: real config.json + data/*; GitHub is mocked)
//   SP_SHOTS=<dir> saves screenshots.   NODE_PATH must contain playwright.
const { chromium } = require("playwright");
const http = require("http"), fs = require("fs"), path = require("path");
const ROOT = path.resolve(__dirname, "..");
let checks = 0; const fails = [];
const ok = (c, m) => { checks++; if (!c) { fails.push(m); console.log("  ✗ " + m); } };
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const appSrc = read("app.js");
const H = /var AUTH_HASH = "([0-9a-f]+)"/.exec(appSrc)[1];
const config = JSON.parse(read("config.json"));
const latest = JSON.parse(read("data/latest.json"));
const ORDER = ["youtube", "instagram", "tiktok", "aparat"];
const now = Date.now(), iso = (t) => new Date(t).toISOString();

// a synthetic world that covers every state
function world() {
  const [A, B, C, D, E] = config.pages.map((p) => p.id);
  const acc = (id) => config.pages.find((p) => p.id === id).accounts;
  const ch = (svc, name, extra) => Object.assign({ id: svc + name, name, displayName: name, service: svc, avatar: "https://buffer-channel-avatars-bucket.s3.amazonaws.com/" + name, isQueuePaused: false }, extra || {});
  const buffer = { updated: iso(now), pages: {
    [A]: { status: "ok", channels: [ch("instagram", "someone.else")] },                                   // mismatch IG
    [B]: { status: "ok", channels: [ch("instagram", acc(B).instagram), ch("tiktok", acc(B).tiktok)] }, // both ok
    [C]: { status: "error", error: "Access token is not valid" },                                       // bad key
    [D]: { status: "ok", channels: [ch("instagram", acc(D).instagram)] },                               // TikTok not in Buffer
    [E]: { status: "no_key" } } };
  const store = { v: 1, channels: {
    UCAAAA: { page: A, channel_id: "UCAAAA", title: "Chan A", handle: "@a", mismatch: false, connected_at: iso(now - 3600e3), status: "ok" },
    UCBBBB: { page: B, channel_id: "UCBBBB", title: "Other", mismatch: true, expected_channel_id: "UCXX", connected_at: iso(now - 3600e3), status: "ok" } } };
  return { A, B, C, D, E, buffer, store };
}
function serve(over) {
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml" };
  return new Promise((res) => {
    const srv = http.createServer((q, s) => {
      const u = decodeURIComponent(q.url.split("?")[0]);
      if (over[u] != null) { s.writeHead(200, { "Content-Type": types[path.extname(u)] || "text/plain" }); return s.end(typeof over[u] === "function" ? over[u]() : over[u]); }
      let f = path.join(ROOT, u); if (f.endsWith("/")) f += "index.html";
      fs.readFile(f, (e, d) => { if (e) { s.writeHead(404); s.end(); } else { s.writeHead(200, { "Content-Type": types[path.extname(f)] || "application/octet-stream" }); s.end(d); } });
    }).listen(0, () => res({ srv, url: "http://127.0.0.1:" + srv.address().port + "/" }));
  });
}
async function device(browser, vp, theme, store) {
  const ctx = await browser.newContext({ viewport: { width: vp, height: 812 }, deviceScaleFactor: 2, isMobile: vp < 500, hasTouch: vp < 500, serviceWorkers: "block", locale: "fa-IR", timezoneId: "Asia/Tehran" });
  await ctx.addInitScript(([h, t]) => { localStorage.setItem("sp_auth", h); localStorage.setItem("sp_theme", t); sessionStorage.setItem("sp_unlock_later", "1"); }, [H, theme]);
  await ctx.route(/^https:\/\/.*/, (r) => {
    const u = r.request().url();
    if (/yt_tokens\.enc\.json/.test(u)) return store ? r.fulfill({ status: 200, headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" }, body: JSON.stringify(store) }) : r.fulfill({ status: 500, body: "" });
    if (/buffer-channel-avatars/.test(u)) return r.fulfill({ status: 200, headers: { "Content-Type": "image/png" }, body: fs.readFileSync(path.join(ROOT, "favicon.png")) });
    if (/(api\.github\.com|raw\.githubusercontent\.com)/.test(u)) return r.fulfill({ status: 404, headers: { "Access-Control-Allow-Origin": "*" }, body: "{}" });
    return r.fulfill({ status: 404, body: "" });
  });
  const page = await ctx.newPage(); const errs = []; page.on("pageerror", (e) => errs.push(e.message));
  return { ctx, page, errs };
}
const rowsOf = (page) => page.evaluate(() => Array.from(document.querySelectorAll("#yt-accounts .accb")).map((b) => ({
  page: b.getAttribute("data-page"), sum: b.querySelector(".accb-sum").textContent, ok: +b.getAttribute("data-ok"), total: +b.getAttribute("data-total"),
  rows: Array.from(b.querySelectorAll(".acc-row")).map((r) => ({ pl: r.getAttribute("data-pl"), st: r.getAttribute("data-acc-st"), chip: r.querySelector(".acc-chip").textContent,
    chipCls: r.querySelector(".acc-chip").className, via: (r.querySelector(".acc-via") || {}).textContent || "", how: (r.querySelector(".acc-how") || {}).textContent || "",
    both: (r.querySelector(".acc-both") || {}).textContent || "", icon: !!r.querySelector(".picon." + r.getAttribute("data-pl")), av: !!r.querySelector(".acc-av"),
    img: (r.querySelector(".acc-av img") || {}).src || "", btn: !!r.querySelector("button[data-ytc]"), yacc: r.classList.contains("yacc"), text: r.textContent })) })));

(async () => {
  const browser = await chromium.launch();
  const W = world();
  const { srv, url } = await serve({ "/data/buffer.json": JSON.stringify(W.buffer) });
  // ---------------- synthetic states, 375 light + dark, 1280
  for (const [vp, theme] of [[375, "light"], [375, "dark"], [1280, "light"]]) {
    const { ctx, page, errs } = await device(browser, vp, theme, W.store);
    await page.goto(url + "#/settings"); await page.waitForSelector("#yt-accounts .accb", { timeout: 20000 });
    await page.waitForFunction(() => !document.querySelector('.acc-row[data-acc-st="unknown"]'), null, { timeout: 15000 }).catch(() => {});
    const B = await rowsOf(page), tag = vp + " " + theme;
    const chOrder = await page.evaluate(() => { location.hash = "#/channels"; return new Promise((r) => setTimeout(() => r(Array.from(document.querySelectorAll("#clist .cgroup")).map((g) => g.getAttribute("data-page"))), 600)); });
    ok(B.length === 5 && JSON.stringify(B.map((b) => b.page)) === JSON.stringify(chOrder), `${tag}: 5 brands in channel order (${B.map((b) => b.page)} vs ${chOrder})`);
    for (const b of B) {
      const cp = config.pages.find((p) => p.id === b.page);
      const want = ORDER.filter((pl) => cp.accounts[pl]);
      ok(JSON.stringify(b.rows.map((r) => r.pl)) === JSON.stringify(want), `${tag} ${b.page}: one row per network in config, ordered`);
      ok(b.rows.every((r) => r.icon && r.av), `${tag} ${b.page}: every row has network icon + avatar circle`);
      ok(b.ok === b.rows.filter((r) => r.st === "ok").length && /از/.test(b.sum) && /متصل/.test(b.sum), `${tag} ${b.page}: summary «x از y متصل» matches (${b.sum})`);
      const yt = b.rows.find((r) => r.pl === "youtube"); ok(yt && yt.btn && yt.yacc, `${tag} ${b.page}: YouTube row keeps the «اتصال» button`);
      const ap = b.rows.find((r) => r.pl === "aparat"); ok(ap && ap.st === "na" && /آپارات API ندارد — فقط لینک/.test(ap.how) && /na/.test(ap.chipCls), `${tag} ${b.page}: Aparat = no API, link only`);
    }
    const get = (p, pl) => B.find((b) => b.page === p).rows.find((r) => r.pl === pl);
    ok(get(W.A, "youtube").st === "ok" && get(W.A, "youtube").chip === "متصل ✓" && /یوتیوب رسمی/.test(get(W.A, "youtube").via) && /good/.test(get(W.A, "youtube").chipCls), `${tag}: YT connected → «متصل ✓» via «یوتیوب رسمی»`);
    ok(get(W.B, "youtube").st === "mismatch" && /کانال دیگری/.test(get(W.B, "youtube").chip), `${tag}: YT wrong channel shown`);
    ok(get(W.C, "youtube").st === "none" && get(W.C, "youtube").chip === "متصل نیست" && /bad/.test(get(W.C, "youtube").chipCls) && /«اتصال»/.test(get(W.C, "youtube").how), `${tag}: YT none → red + how-to`);
    const ia = get(W.A, "instagram"); ok(ia.st === "mismatch" && ia.chip === "هندل فرق دارد" && /warn/.test(ia.chipCls) && /someone\.else/.test(ia.both) && ia.both.includes(config.pages[0].accounts.instagram) && /buffer/.test(ia.img), `${tag}: IG handle mismatch → amber, both handles, Buffer avatar`);
    ok(get(W.B, "instagram").st === "ok" && /بافر/.test(get(W.B, "instagram").via) && get(W.B, "tiktok").st === "ok", `${tag}: Buffer-connected IG/TikTok → «متصل ✓» via «بافر»`);
    ok(get(W.C, "instagram").st === "none" && /BUFFER_KEY_/.test(get(W.C, "instagram").how) && /نامعتبر/.test(get(W.C, "instagram").how), `${tag}: invalid Buffer key → how-to names the secret`);
    ok(get(W.D, "tiktok").st === "none" && /در بافرِ این برند وصل کن/.test(get(W.D, "tiktok").how), `${tag}: Buffer ok but channel missing → connect it in Buffer`);
    ok(get(W.E, "instagram").st === "none" && /BUFFER_KEY_PRETIME_TV|BUFFER_KEY_/.test(get(W.E, "instagram").how), `${tag}: no Buffer key → add key how-to`);
    const sumB = B.find((b) => b.page === W.B); ok(sumB.ok === 2 && /۲ از ۴ متصل/.test(sumB.sum), `${tag}: summary text Persian digits (${sumB.sum})`);
    await page.evaluate(() => { location.hash = "#/settings"; }); await page.waitForSelector("#yt-accounts .accb");
    const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, wide: Array.from(document.querySelectorAll("#yt-accounts *")).filter((e) => { const r = e.getBoundingClientRect(); return r.width && (r.right > innerWidth + 1 || r.left < -1); }).length }));
    ok(o.sw <= vp + 1 && !o.wide, `${tag}: no horizontal overflow (${o.sw}, ${o.wide} wide)`);
    if (process.env.SP_SHOTS) { fs.mkdirSync(process.env.SP_SHOTS, { recursive: true }); await (await page.$("#yt-accounts")).screenshot({ path: path.join(process.env.SP_SHOTS, `v11-settings-${vp}-${theme}.png`) }); }
    // the YT connect button still starts the existing flow (click handler on button[data-ytc])
    const clicked = await page.evaluate((p) => { const b = document.querySelector('.acc-row[data-page="' + p + '"][data-pl="youtube"] button[data-ytc]'); return !!b && b.getAttribute("data-ytc") === p; }, W.C);
    ok(clicked, `${tag}: «اتصال» button wired with data-ytc`);
    // data refresh: a new buffer.json is picked up on load without leaving settings
    await page.evaluate(() => window.__spDebug.load(true));
    ok(await page.evaluate(() => !!document.querySelector("#yt-accounts-list .accb")), `${tag}: list survives a data reload`);
    ok(!errs.length, `${tag}: no page errors (${errs.join(" | ")})`);
    await ctx.close();
  }
  // ---------------- buffer.json reloaded on every load
  {
    let cur = JSON.parse(JSON.stringify(W.buffer));
    const { srv: s2, url: u2 } = await serve({ "/data/buffer.json": () => JSON.stringify(cur) });
    const { ctx, page } = await device(browser, 375, "light", W.store);
    await page.goto(u2 + "#/settings"); await page.waitForSelector("#yt-accounts .accb");
    const st0 = await page.evaluate((p) => document.querySelector('.acc-row[data-page="' + p + '"][data-pl="tiktok"]').getAttribute("data-acc-st"), W.D);
    cur.pages[W.D].channels.push({ id: "x", name: config.pages.find((p) => p.id === W.D).accounts.tiktok, service: "tiktok" });
    await page.evaluate(() => window.__spDebug.load(true)); await page.waitForTimeout(300);
    const st1 = await page.evaluate((p) => document.querySelector('.acc-row[data-page="' + p + '"][data-pl="tiktok"]').getAttribute("data-acc-st"), W.D);
    ok(st0 === "none" && st1 === "ok", `buffer.json re-read on load updates the list in place (${st0} → ${st1})`);
    await ctx.close(); s2.close();
  }
  srv.close(); await browser.close();
  console.log(`v11: ${checks} checks, ${fails.length} failed`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
