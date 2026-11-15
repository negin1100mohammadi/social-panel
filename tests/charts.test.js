// Headless Chromium (iPhone width) test of every analytics box filter.
// usage: node tests/charts.test.js <site_dir_or_url> [--fixture]
//   --fixture : the site was built by tests/make_fixture.py with NOW from env FIXTURE_NOW (ms); the page clock is frozen there
// Requires: npm i playwright && npx playwright install chromium
const { chromium } = require("playwright");
const http = require("http");
const fs = require("fs");
const path = require("path");

const target = process.argv[2];
const FIXTURE = process.argv.includes("--fixture");
const NOW = FIXTURE ? Number(process.env.FIXTURE_NOW) : null;
const HOUR = 3600e3, DAY = 86400e3, OFF = 3.5 * HOUR;
const RANGES = { "3h": [3 * HOUR, 30 * 60e3, "time"], "24h": [24 * HOUR, HOUR, "time"], "30d": [30 * DAY, DAY, "date"], "90d": [90 * DAY, 3 * DAY, "date"] };
const PLATS = ["instagram", "youtube", "aparat", "tiktok"];
const AUTH_HASH = "1b906a20e9fea1a47f58c9c56aa49688acb2dd0ba5fba3188825f252401a3ba8";

// independent parser (not the app's): ISO, or "Sat 2026-11-14 4:24 PM (UTC+03:30)"
function parseT(v) {
  if (v == null) return null;
  const m = /^\w{3} (\d{4})-(\d\d)-(\d\d) (\d{1,2}):(\d\d) (AM|PM) \(UTC\+03:30\)$/.exec(v);
  if (m) { let h = +m[4] % 12; if (m[6] === "PM") h += 12; return Date.UTC(+m[1], m[2] - 1, +m[3], h, +m[5]) - OFF; }
  const t = Date.parse(v); return isNaN(t) ? null : t;
}
const bidx = (t, size) => Math.floor((t + OFF) / size);
function sameBasis(a, b, k) {
  const ba = (a.b || {})[k] || "", bb = (b.b || {})[k] || "";
  return ba === bb && (ba === "t" || a.p === b.p);
}
function expectSeries(raw, k, kind, r, now) {
  const [ms, size] = RANGES[r], from = now - ms;
  const all = (raw || []).map((p) => ({ ...p, t: parseT(p.t) })).filter((p) => p.t != null && p[k] != null && p.t <= now).sort((a, b) => a.t - b.t);
  if (!all.length) return { state: "unavailable" };
  const win = all.filter((p) => p.t >= from), before = all.filter((p) => p.t < from).pop();
  const anchor = before || win[0];
  let idx = new Set(), change = null;
  if (kind === "level") {
    win.forEach((p) => idx.add(bidx(p.t, size)));
    change = win.length ? all[all.length - 1][k] - anchor[k] : null;
  } else {
    const chain = (before ? [before] : []).concat(win);
    let sum = 0;
    for (let i = 1; i < chain.length; i++) if (sameBasis(chain[i - 1], chain[i], k)) { sum += chain[i][k] - chain[i - 1][k]; idx.add(bidx(chain[i].t, size)); }
    change = chain.length >= 2 ? sum : null;
  }
  const n = idx.size, firstI = n ? Math.min(...idx) : null;
  return { state: n >= 2 ? "ok" : "insufficient", n, change, firstStart: firstI == null ? null : Math.max(firstI * size - OFF, from), covFrom: win.length ? win[0].t : null, from };
}
function expectPosts(posts, m, r, now) {
  const from = now - RANGES[r][0];
  const inR = posts.map((p) => ({ t: parseT(p.published), y: p[m] })).filter((x) => x.t != null && x.t >= from && x.t <= now).sort((a, b) => a.t - b.t);
  return { count: inR.length, n: inR.filter((x) => x.y != null).length, first: inR[0] && inR[0].t, unavailable: posts.every((p) => p[m] == null) };
}

function serve(dir) {
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".jpg": "image/jpeg" };
  return new Promise((res) => {
    const srv = http.createServer((q, s) => {
      let f = path.join(dir, decodeURIComponent(q.url.split("?")[0]));
      if (f.endsWith("/")) f += "index.html";
      fs.readFile(f, (e, d) => { if (e) { s.writeHead(404); s.end(); } else { s.writeHead(200, { "Content-Type": types[path.extname(f)] || "application/octet-stream" }); s.end(d); } });
    }).listen(0, () => res({ srv, url: "http://127.0.0.1:" + srv.address().port + "/" }));
  });
}

(async () => {
  let base = target, srv = null, dir = null;
  if (!/^https?:/.test(target)) { dir = target; const s = await serve(dir); srv = s.srv; base = s.url; }
  const getJSON = async (p) => dir ? JSON.parse(fs.readFileSync(path.join(dir, p), "utf8")) : (await fetch(base + p + "?t=" + Date.now())).json();
  const config = await getJSON("config.json"), latest = await getJSON("data/latest.json"), history = await getJSON("data/history.json");

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, serviceWorkers: "block", locale: "fa-IR", timezoneId: "America/New_York" });
  await ctx.addInitScript((h) => { if (!localStorage.getItem("sp_auth")) localStorage.setItem("sp_auth", h); }, AUTH_HASH);
  const page = await ctx.newPage();
  if (NOW) await page.clock.setFixedTime(NOW);
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|api\.github\.com|raw\.githubusercontent/.test(m.text())) errors.push(m.text()); });

  const fmt = (t, axis) => page.evaluate(([t, axis]) => new Intl.DateTimeFormat("fa-IR", axis === "time" ? { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Tehran" } : { month: "short", day: "numeric", timeZone: "Asia/Tehran" }).format(new Date(t)), [t, axis]);
  let checks = 0, fails = [];
  const ok = (cond, msg) => { checks++; if (!cond) fails.push(msg); };

  await page.goto(base + "#/");
  await page.waitForSelector(".chbox, .boxes", { timeout: 15000 });
  const variety = {};
  const only = process.env.PAGES ? process.env.PAGES.split(",") : null;
  for (const cp of config.pages.filter((c) => !only || only.includes(c.id))) {
    for (const pl of PLATS) {
      const r = (latest.pages[cp.id] || { platforms: {} }).platforms[pl] || {};
      await page.evaluate((h) => { location.hash = h; }, `#/a/${cp.id}/${pl}`);
      await page.waitForSelector(".ahead[data-platform='" + pl + "'][data-page='" + cp.id + "']", { timeout: 10000 });
      if (!(r.ok || r.stale)) { ok(await page.$("#nodata"), `${cp.id}/${pl}: expected no-data panel`); continue; }
      const raw = history.series[cp.id + "/" + pl] || [];
      const posts = r.recent || [];
      for (const box of ["followers", "views", "likes", "comments", "posts"]) {
        const sel = `.abox[data-box="${box}"]`;
        const tag = `${cp.id}/${pl}/${box}`;
        for (const type of ["line", "bar"]) {
          await page.click(`${sel} button[data-type="${type}"]`);
          for (const rg of Object.keys(RANGES)) {
            await page.click(`${sel} button[data-r="${rg}"]`);
            const now = NOW || await page.evaluate(() => Date.now());
            const info = await page.$eval(sel, (el) => {
              const ch = el.querySelector(".chart"), rn = el.querySelector(".range-note"), cg = el.querySelector(".chg");
              return { r: el.getAttribute("data-r"), type: el.getAttribute("data-type"), on: (el.querySelector(".seg.range button.on") || {}).getAttribute && el.querySelector(".seg.range button.on").getAttribute("data-r"),
                state: ch && ch.getAttribute("data-state"), n: ch && +ch.getAttribute("data-n"), first: ch && ch.getAttribute("data-first"), last: ch && ch.getAttribute("data-last"),
                covFrom: rn && rn.getAttribute("data-from"), change: cg && cg.getAttribute("data-change"), html: el.innerHTML, text: el.innerText,
                bars: el.querySelectorAll("rect.bar").length, dots: el.querySelectorAll("circle.dot").length, lines: el.querySelectorAll("polyline.ln").length, empty: (el.querySelector(".empty") || {}).textContent || "" };
            });
            const t2 = `${tag} [${rg},${type}]`;
            ok(info.r === rg && info.on === rg && info.type === type, `${t2}: filter state not applied (${info.r}/${info.on}/${info.type})`);
            ok(!/NaN|undefined|Infinity/.test(info.text) && !/NaN/.test(info.html), `${t2}: NaN/undefined in output`);
            if (box !== "posts") {
              const k = { followers: "f", views: "v", likes: "l", comments: "c" }[box];
              const e = expectSeries(raw, k, box === "followers" ? "level" : "delta", rg, now);
              ok(info.state === e.state, `${t2}: state ${info.state} != expected ${e.state}`);
              if (e.state === "unavailable") continue;
              ok(info.n === e.n, `${t2}: points ${info.n} != expected ${e.n}`);
              ok(String(info.change) === (e.change == null ? "" : String(e.change)), `${t2}: change ${info.change} != expected ${e.change}`);
              ok((info.covFrom || null) === (e.covFrom == null ? null : new Date(e.covFrom).toISOString()), `${t2}: coverage from ${info.covFrom} != ${e.covFrom && new Date(e.covFrom).toISOString()}`);
              if (e.state === "ok") {
                const want = await fmt(e.firstStart, RANGES[rg][2]);
                ok(info.first === want, `${t2}: first label ${info.first} != ${want}`);
                ok(RANGES[rg][2] === "time" ? /:/.test(info.first + info.last) : !/:/.test(info.first + info.last), `${t2}: label format ${info.first}..${info.last}`);
                if (type === "bar") ok(info.bars === e.n, `${t2}: bars ${info.bars} != ${e.n}`);
                else ok(info.lines === 1 && (e.n > 48 || info.dots === e.n), `${t2}: line/dots ${info.lines}/${info.dots} for n=${e.n}`);
              } else {
                ok(/هنوز داده کافی برای این بازه نیست — از /.test(info.empty), `${t2}: missing insufficient-data message (${info.empty})`);
              }
              (variety[tag] = variety[tag] || new Set()).add(info.n + "|" + info.change);
            } else {
              for (const m of ["views", "likes", "comments"]) {
                if (!posts.length) break;
                await page.click(`${sel} button[data-m="${m}"]`);
                const e = expectPosts(posts, m, rg, now);
                const pi = await page.$eval(sel, (el) => { const ch = el.querySelector(".chart"), cg = el.querySelector(".chg"); return { state: ch && ch.getAttribute("data-state"), n: ch && +ch.getAttribute("data-n"), count: cg && cg.getAttribute("data-change"), bars: el.querySelectorAll("rect.bar").length, text: el.innerText }; });
                const t3 = `${t2}[${m}]`;
                ok(!/NaN|undefined/.test(pi.text), `${t3}: NaN in output`);
                if (e.unavailable) { ok(pi.state === "unavailable", `${t3}: expected unavailable, got ${pi.state}`); continue; }
                ok(String(pi.count) === String(e.count), `${t3}: post count ${pi.count} != ${e.count}`);
                ok(e.n ? pi.n === e.n && pi.state === "ok" : pi.state === "empty", `${t3}: n ${pi.n}/${pi.state} != ${e.n}`);
                if (type === "bar" && e.n) ok(pi.bars === e.n, `${t3}: bars ${pi.bars} != ${e.n}`);
              }
            }
          }
        }
      }
      // persistence + independence: give each box a different setting, reload, verify
      const combos = { followers: ["3h", "bar"], views: ["24h", "line"], likes: ["90d", "bar"], comments: ["30d", "line"], posts: ["90d", "line"] };
      for (const [box, [rg, type]] of Object.entries(combos)) { await page.click(`.abox[data-box="${box}"] button[data-r="${rg}"]`); await page.click(`.abox[data-box="${box}"] button[data-type="${type}"]`); }
      const before = await page.$$eval(".abox", (els) => els.map((e) => e.getAttribute("data-box") + ":" + e.getAttribute("data-r") + ":" + e.getAttribute("data-type")));
      await page.reload(); await page.waitForSelector(".abox");
      const after = await page.$$eval(".abox", (els) => els.map((e) => e.getAttribute("data-box") + ":" + e.getAttribute("data-r") + ":" + e.getAttribute("data-type")));
      ok(JSON.stringify(before) === JSON.stringify(after) && after.join() === Object.entries(combos).map(([b, [r, t]]) => b + ":" + r + ":" + t).join(), `${cp.id}/${pl}: prefs not persisted/independent ${after}`);
      // route change and back: a single click must change exactly one box once (no stale/duplicate handlers)
      await page.evaluate(() => { location.hash = "#/channels"; }); await page.waitForSelector(".cbox, #back");
      await page.evaluate((h) => { location.hash = h; }, `#/a/${cp.id}/${pl}`); await page.waitForSelector(".abox");
      await page.click('.abox[data-box="followers"] button[data-r="24h"]');
      const after2 = await page.$$eval(".abox", (els) => els.map((e) => e.getAttribute("data-r")));
      ok(after2.join() === "24h,24h,90d,30d,90d", `${cp.id}/${pl}: click after route change affected wrong boxes ${after2}`);
    }
  }
  if (FIXTURE) {
    const k = Object.keys(variety).filter((t) => /\/followers$/.test(t) && variety[t].size >= 3);
    ok(k.length >= (only ? 1 : 5), `filters should give different results on the 90-day fixture (only ${k.length} follower boxes vary)`);
  }
  ok(!errors.length, "page errors: " + errors.slice(0, 5).join(" | "));
  await browser.close(); if (srv) srv.close();
  console.log(`${checks} checks, ${fails.length} failed`);
  fails.slice(0, 60).forEach((f) => console.log("FAIL " + f));
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
