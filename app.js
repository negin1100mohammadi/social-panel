/* Social pages dashboard — vanilla JS, hash routing, no framework. */
(function () {
  "use strict";

  var VAULT_URL = "https://vault.vaultwarden.com/";
  var TZ = "Asia/Tehran";
  var HOUR = 3600000, DAY = 86400000;
  var PLATFORMS = ["instagram", "youtube", "aparat", "tiktok"];
  var PNAME = { instagram: "اینستاگرام", youtube: "یوتیوب", aparat: "آپارات", tiktok: "تیک‌تاک" };
  var FOLLOW_LABEL = { instagram: "دنبال‌کننده", youtube: "مشترک", aparat: "دنبال‌کننده", tiktok: "دنبال‌کننده" };
  var POSTS_LABEL = { instagram: "پست", youtube: "ویدیو", aparat: "ویدیو", tiktok: "ویدیو" };

  var AUTH_SALT = "sp-panel-v1|";
  var AUTH_HASH = "1b906a20e9fea1a47f58c9c56aa49688acb2dd0ba5fba3188825f252401a3ba8";
  var AUTH_KEY = "sp_auth";
  var THEME_KEY = "sp_theme";

  // GitHub repo this site is built from. The token never leaves this browser (localStorage only).
  var GH_OWNER = "negin1100mohammadi", GH_REPO = "social-panel", GH_BRANCH = "main";
  var TOKEN_KEY = "sp_gh_token";
  var MEDIA_BRANCH = "media-upload";
  var MAX_UPLOAD = 70 * 1024 * 1024; // GitHub blob API limit is 100 MB after base64

  var state = { config: null, latest: null, history: null, error: null, busy: false, progress: "" };
  var app = document.getElementById("app");

  // ---------------------------------------------------------------- utils
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function fa(n, opts) {
    if (n == null || isNaN(n)) return "—";
    return Number(n).toLocaleString("fa-IR", opts || {});
  }
  function compact(n) {
    if (n == null) return "—";
    if (Math.abs(n) >= 10000) {
      try { return Number(n).toLocaleString("fa-IR", { notation: "compact", maximumFractionDigits: 1 }); } catch (e) { /* old Safari */ }
    }
    return fa(n, { maximumFractionDigits: 1 });
  }
  function pct(x) { return x == null ? "—" : fa(x, { maximumFractionDigits: 2 }) + "٪"; }
  function signed(n) {
    if (n == null) return "—";
    if (n === 0) return "۰";
    return (n > 0 ? "+" : "−") + fa(Math.abs(n));
  }
  function fmtFmt(iso, o) {
    if (!iso) return "—";
    try { o.timeZone = TZ; return new Intl.DateTimeFormat("fa-IR", o).format(new Date(iso)); } catch (e) { return String(iso); }
  }
  function fmtDateTime(iso) { return fmtFmt(iso, { year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" }); }
  function fmtShort(iso) { return fmtFmt(iso, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); }
  function fmtDayOnly(iso) { return fmtFmt(iso, { month: "short", day: "numeric" }); }
  function fmtTime(iso) { return fmtFmt(iso, { hour: "2-digit", minute: "2-digit" }); }
  function ago(iso) {
    if (!iso) return "—";
    var ms = Date.now() - new Date(iso).getTime();
    if (ms < 0) ms = 0;
    var m = Math.floor(ms / 60000);
    if (m < 60) return m <= 1 ? "همین حالا" : fa(m) + " دقیقه پیش";
    var h = Math.floor(m / 60);
    if (h < 24) return fa(h) + " ساعت پیش";
    var d = Math.floor(h / 24);
    if (d < 30) return fa(d) + " روز پیش";
    var mo = Math.floor(d / 30);
    if (mo < 12) return fa(mo) + " ماه پیش";
    return fa(Math.floor(d / 365)) + " سال پیش";
  }
  function tehranParts(dt) {
    var p = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(dt);
    var o = {}; p.forEach(function (x) { o[x.type] = x.value; });
    return o;
  }
  function tsOf(v) { var t = v ? new Date(v).getTime() : NaN; return isNaN(t) ? null : t; }

  // ------------------------------------------------------------ platform info
  var LOGIN_URL = {
    instagram: "https://www.instagram.com/accounts/login/",
    youtube: "https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fstudio.youtube.com%2F",
    aparat: "https://www.aparat.com/signin",
    tiktok: "https://www.tiktok.com/login"
  };
  var NO_ACCESS = "فقط با دسترسی به خود اکانت";
  var PICON = {
    instagram: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#fff" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="5"/><circle cx="12" cy="12" r="3.6"/><circle cx="16.9" cy="7.1" r="1" fill="#fff" stroke="none"/></svg>',
    youtube: '<svg viewBox="0 0 24 24" width="20" height="20"><path d="M10 8.5v7l6-3.5z" fill="#fff"/></svg>',
    aparat: '<svg viewBox="0 0 24 24" width="20" height="20" fill="#fff"><circle cx="8.5" cy="8.5" r="2.3"/><circle cx="15.5" cy="8.5" r="2.3"/><circle cx="8.5" cy="15.5" r="2.3"/><circle cx="15.5" cy="15.5" r="2.3"/></svg>',
    tiktok: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round"><path d="M13 4v10.5a3 3 0 1 1-3-3"/><path d="M13 4c.5 2.6 2.4 4.2 5 4.4"/></svg>'
  };
  function picon(pl) { return '<span class="picon ' + pl + '">' + PICON[pl] + "</span>"; }

  var ICON_LOCK = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="10.5" width="16" height="10" rx="2.5"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/><circle cx="12" cy="15.5" r="1.3"/></svg>';
  var ICON_REFRESH = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg>';
  var ICON_SUN = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
  var ICON_MOON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>';
  var ICON_CLOCK = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';
  var ICON_CHANNELS = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="13" rx="2.5"/><path d="M8 21h8M12 17v4"/><path d="M10 8.5v5l4-2.5z" fill="currentColor"/></svg>';
  var ICON_BELL = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/></svg>';
  var ICON_CHART = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M5 20V12M10 20V6M15 20v-9M20 20V4"/></svg>';
  var ICON_LOGIN = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4"/><path d="M10 16l4-4-4-4M14 12H4"/></svg>';
  var ICON_EYE = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  var ICON_EYE_OFF = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 5.1A10.7 10.7 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';
  var ICON_SEND = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 16V4"/><path d="M7 9l5-5 5 5"/><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/></svg>';
  var ICON_SEND_SM = ICON_SEND.replace(/width="22" height="22"/, 'width="17" height="17"');
  var ICON_GEAR = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>';

  // ------------------------------------------------------------ channel helpers
  function pageData(cp) { return (state.latest && state.latest.pages[cp.id]) || { id: cp.id, name: cp.name, platforms: {} }; }
  function cpById(id) { return state.config.pages.filter(function (p) { return p.id === id; })[0]; }
  function hasData(r) { return !!(r && (r.ok || r.stale)); }
  function seriesOf(pid, pl) {
    var s = (((state.history && state.history.series) || {})[pid + "/" + pl] || []).map(function (p) {
      var t = p.t ? tsOf(p.t) : (p.d ? tsOf(p.d + "T12:00:00+03:30") : null);
      return { t: t, f: p.f, p: p.p, v: p.v, l: p.l, c: p.c };
    }).filter(function (p) { return p.t != null; });
    s.sort(function (a, b) { return a.t - b.t; });
    return s;
  }
  // when did the post count last change? (fallback for platforms that give counts but no dates)
  function histChange(pid, pl) {
    var s = seriesOf(pid, pl).filter(function (p) { return p.p != null; });
    if (!s.length) return null;
    var cur = s[s.length - 1].p; if (!cur) return null;
    var when = null;
    for (var i = 0; i < s.length; i++) {
      if (s[i].p === cur) { if (when == null) when = s[i].t; } else when = null;
    }
    return when;
  }
  function platformActivity(pid, pl, r) {
    if (!hasData(r)) return null;
    var best = tsOf(r.last_post_at);
    (r.recent || []).forEach(function (p) { var t = tsOf(p.published); if (t && (!best || t > best)) best = t; });
    if (best) return { t: best, dated: true };
    if ((r.posts || 0) > 0) {
      var t2 = tsOf(r.last_change_at) || histChange(pid, pl);
      if (t2) return { t: t2, dated: false };
    }
    return null;
  }
  function lastActivity(cp, page) {
    var best = null;
    PLATFORMS.forEach(function (pl) {
      var a = platformActivity(cp.id, pl, page.platforms[pl]);
      if (a && (!best || a.t > best.t)) best = { t: a.t, dated: a.dated, pl: pl };
    });
    return best;
  }
  function avatarURL(r) {
    if (!r || !r.avatar) return null;
    if (/^https?:/i.test(r.avatar)) return r.avatar; // remote signed URLs must not be modified
    var v = (state.latest && state.latest.updated_at) || r.avatar_hash || "";
    return r.avatar + "?v=" + encodeURIComponent(v);
  }
  function avatarOf(cp, page, only) {
    if (only) return avatarURL(page.platforms[only]);
    if (cp.logo) return cp.logo;
    var order = ["instagram", "youtube", "tiktok", "aparat"];
    for (var i = 0; i < order.length; i++) { var u = avatarURL(page.platforms[order[i]]); if (u) return u; }
    return null;
  }
  function logoHTML(cp, page, cls, only) {
    var a = avatarOf(cp, page, only);
    if (!a) return '<span class="clogo empty ' + (cls || "") + '"></span>';
    return '<span class="clogo ' + (cls || "") + '"><img alt="" referrerpolicy="no-referrer" src="' + esc(a) + '" onerror="this.parentNode.classList.add(\'empty\');this.remove()"></span>';
  }
  // likes + comments across every platform: grows when someone likes or comments
  function interactions(page) {
    var n = 0;
    PLATFORMS.forEach(function (pl) {
      var r = page.platforms[pl]; if (!hasData(r)) return;
      if (pl === "tiktok") n += r.total_likes || 0;
      (r.recent || []).forEach(function (p) { n += (p.likes || 0) + (p.comments || 0); });
    });
    return n;
  }
  function lsGet(k, d) { try { var v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function seenMap() { return lsGet("sp_seen", {}); }
  function saveSeen(m) { lsSet("sp_seen", m); }
  function newCount(cp, page) {
    var seen = seenMap(), cur = interactions(page);
    if (seen[cp.id] == null) { seen[cp.id] = cur; saveSeen(seen); return 0; }
    return Math.max(0, cur - seen[cp.id]);
  }
  function markSeen(cp, page) { var seen = seenMap(); seen[cp.id] = interactions(page); saveSeen(seen); }
  function openSet() { try { return JSON.parse(sessionStorage.getItem("sp_open") || "{}"); } catch (e) { return {}; } }
  function saveOpen(o) { try { sessionStorage.setItem("sp_open", JSON.stringify(o)); } catch (e) {} }

  // ------------------------------------------------------------ GitHub API (token stays in this browser)
  function getToken() { try { return (localStorage.getItem(TOKEN_KEY) || "").trim(); } catch (e) { return ""; } }
  function setToken(t) { try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch (e) {} }
  function ghHeaders(extra) {
    var h = { "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "Authorization": "Bearer " + getToken() };
    for (var k in (extra || {})) h[k] = extra[k];
    return h;
  }
  function gh(path, opts) {
    opts = opts || {};
    var url = /^https:/.test(path) ? path : "https://api.github.com/repos/" + GH_OWNER + "/" + GH_REPO + path;
    var init = { method: opts.method || "GET", headers: ghHeaders(opts.headers), cache: "no-store" };
    if (opts.body !== undefined) { init.body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body); init.headers["Content-Type"] = "application/json"; }
    return fetch(url, init).then(function (r) {
      if (r.status === 204) return null;
      return r.text().then(function (txt) {
        var data = null; try { data = txt ? JSON.parse(txt) : null; } catch (e) { data = txt; }
        if (!r.ok) { var err = new Error((data && data.message) || ("HTTP " + r.status)); err.status = r.status; throw err; }
        return data;
      });
    });
  }
  function ghErrorFa(e) {
    if (!e) return "خطای نامشخص";
    if (e.status === 401) return "توکن نامعتبر یا منقضی است. در «تنظیمات» توکن تازه بگذار.";
    if (e.status === 403) return "توکن اجازه‌ی این کار را ندارد (دسترسی Actions و Contents باید Read and write باشد).";
    if (e.status === 404) return "مخزن یا فایل پیدا نشد؛ مطمئن شو توکن به مخزن social-panel دسترسی دارد.";
    if (e.status === 422) return "گیت‌هاب درخواست را نپذیرفت: " + e.message;
    if (!e.status && /fetch|network|load/i.test(e.message || "")) return "اتصال به گیت‌هاب برقرار نشد؛ اینترنت را بررسی کن.";
    return e.message || String(e);
  }
  function b64utf8(s) { return btoa(unescape(encodeURIComponent(s))); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // -------------------------------------------------------------- shell
  function currentTheme() { return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light"; }
  function setTheme(t) {
    document.documentElement.setAttribute("data-theme", t);
    try { localStorage.setItem(THEME_KEY, t); } catch (e) {}
    var mc = document.querySelector('meta[name="theme-color"]');
    if (mc) mc.setAttribute("content", t === "dark" ? "#120e1c" : "#f7f5fc");
  }
  function topbar(title) {
    var L = state.latest;
    var dark = currentTheme() === "dark";
    return '<header class="topbar" id="topbar" data-title="' + esc(title) + '">' +
      '<button class="refresh-btn' + (state.busy ? " spin" : "") + '" id="refresh" aria-label="به‌روزرسانی همه‌ی کانال‌ها" title="به‌روزرسانی همه‌ی کانال‌ها">' + ICON_REFRESH + "</button>" +
      '<div class="brand"><b>' + esc(title) + "</b></div>" +
      '<div class="tbox" title="آخرین به‌روزرسانی پنل">' + ICON_CLOCK + '<span class="ul"><b>' + esc(fmtShort(L && L.updated_at)) + "</b><span>" + esc(ago(L && L.updated_at)) + "</span></span></div>" +
      '<button class="tbox" id="theme" aria-label="تغییر تم">' + (dark ? ICON_SUN : ICON_MOON) + '<span class="tlabel">' + (dark ? "لایت" : "دارک") + "</span></button>" +
      "</header>" +
      '<div class="progress' + (state.busy ? " on" : "") + '" id="prog" role="status"><span class="bar"></span><span class="pt" id="progtext">' + esc(state.progress || "در حال به‌روزرسانی…") + "</span></div>";
  }
  function bindTopbar() {
    var rb = document.getElementById("refresh");
    if (rb) rb.onclick = refreshAll;
    var tb = document.getElementById("theme");
    if (tb) tb.onclick = function () { setTheme(currentTheme() === "dark" ? "light" : "dark"); rerenderSafe(); };
  }
  // redraw only the top bar (keeps a half-filled form on the publish page intact)
  function redrawTopbar() {
    var tb = document.getElementById("topbar"), pg = document.getElementById("prog");
    if (!tb) return;
    var tmp = document.createElement("div"); tmp.innerHTML = topbar(tb.getAttribute("data-title"));
    tb.parentNode.replaceChild(tmp.firstChild, tb);
    if (pg) pg.parentNode.replaceChild(tmp.firstChild, pg);
    bindTopbar();
  }
  function onFormPage() { return /^#\/(publish|settings)/.test(location.hash); }
  function rerenderSafe() { if (onFormPage() && document.getElementById("topbar") && authed()) redrawTopbar(); else render(); }
  function setProgress(msg) {
    state.progress = msg;
    var el = document.getElementById("progtext"); if (el) el.textContent = msg;
  }
  function toast(msg, ms) {
    var t = document.createElement("div"); t.className = "toast"; t.textContent = msg;
    document.body.appendChild(t); setTimeout(function () { t.remove(); }, ms || 3200);
  }

  // Refresh: with a token, run the GitHub Action (re-reads every account + profile photo),
  // wait for it to finish deploying, then reload the data. Without a token, just reload.
  function refreshAll() {
    if (state.busy) return;
    state.busy = true; state.progress = "در حال به‌روزرسانی…"; rerenderSafe();
    var before = state.latest && state.latest.updated_at;
    var job = getToken() ? runRefreshWorkflow() : Promise.resolve({ ran: false });
    job.then(function (res) {
      setProgress("در حال دریافت داده‌های تازه…");
      return load(true, true).then(function () { return res; });
    }).then(function (res) {
      state.busy = false; state.progress = ""; rerenderSafe();
      var now = state.latest && state.latest.updated_at;
      if (res.error) toast(res.error, 5000);
      else if (res.ran) toast(now && now !== before ? "همه‌ی کانال‌ها و عکس‌های پروفایل به‌روز شد" : "اجرا تمام شد؛ تغییری در داده‌ها نبود");
      else toast(now && now !== before ? "داده‌های تازه بارگذاری شد" : "داده‌ها به‌روز هستند · آخرین بررسی " + ago(now) + " · برای بررسی فوری، توکن را در تنظیمات بگذار");
    });
  }
  function runRefreshWorkflow() {
    var started = Date.now() - 20000;
    setProgress("در حال به‌روزرسانی… درخواست اجرا به گیت‌هاب");
    return gh("/actions/workflows/refresh.yml/dispatches", { method: "POST", body: { ref: GH_BRANCH } }).then(function () {
      var deadline = Date.now() + 15 * 60000, runId = null;
      function poll() {
        if (Date.now() > deadline) return { ran: true, error: "به‌روزرسانی بیش از حد طول کشید؛ بعداً دوباره صفحه را باز کن." };
        return sleep(runId ? 6000 : 4000).then(function () {
          var q = runId ? gh("/actions/runs/" + runId) :
            gh("/actions/workflows/refresh.yml/runs?event=workflow_dispatch&per_page=5").then(function (d) {
              var run = (d.workflow_runs || []).filter(function (x) { return tsOf(x.created_at) >= started; }).pop();
              return run || null;
            });
          return q.then(function (run) {
            var sec = Math.round((Date.now() - started - 20000) / 1000);
            var el = " (" + fa(Math.floor(sec / 60)) + ":" + ("0" + (sec % 60)).slice(-2).replace(/\d/g, function (d) { return "۰۱۲۳۴۵۶۷۸۹"[d]; }) + ")";
            if (!run) { setProgress("در حال به‌روزرسانی… منتظر شروع اجرا" + el); return poll(); }
            runId = run.id;
            if (run.status === "completed") {
              if (run.conclusion === "success") return { ran: true };
              return { ran: true, error: "اجرای به‌روزرسانی ناموفق بود (" + run.conclusion + ")" };
            }
            setProgress((run.status === "queued" || run.status === "waiting" || run.status === "pending" ? "در صف اجرا…" : "در حال به‌روزرسانی… خواندن آمار و عکس‌های پروفایل و انتشار سایت") + el);
            return poll();
          });
        });
      }
      return poll();
    }).catch(function (e) { return { ran: false, error: "اجرای به‌روزرسانی ممکن نشد: " + ghErrorFa(e) }; });
  }

  // -------------------------------------------------------------- home
  function homeView() {
    var html = topbar("پنل پیج‌ها");
    var total = 0;
    state.config.pages.forEach(function (cp) { total += newCount(cp, pageData(cp)); });
    html += '<div class="boxes">';
    html += '<a class="vault" href="' + VAULT_URL + '" rel="noopener">' +
      '<span class="vi">' + ICON_LOCK + '</span><span><div class="vt">پسوورد منیجر</div>' +
      '<div class="vs">باز کردن Vaultwarden</div></span><span class="arrow">↗</span></a>';
    html += '<a class="chbox" href="#/channels">' +
      '<span class="vi">' + ICON_CHANNELS + '</span><span><div class="vt">کانال‌ها</div>' +
      '<div class="vs">' + fa(state.config.pages.length) + " کانال</div></span>" +
      (total ? '<span class="bell on">' + ICON_BELL + '<i>' + esc(compact(total)) + "</i></span>" : "") +
      '<span class="arrow">←</span></a>';
    html += '<a class="pubbox" href="#/publish" id="pubbox">' +
      '<span class="vi">' + ICON_SEND + '</span><span><div class="vt">انتشار محتوا</div>' +
      '<div class="vs">' + (getToken() ? "آپلود ویدیو یا عکس، انتشار و زمان‌بندی" : "اول توکن گیت‌هاب را در تنظیمات بگذار") + "</div></span>" +
      '<span class="arrow">←</span></a>';
    html += "</div>";
    html += '<a class="setrow" href="#/settings">' + ICON_GEAR + "<span>تنظیمات</span><em>" + (getToken() ? "توکن ثبت شده" : "توکن ثبت نشده") + "</em></a>";
    html += '<button class="logout" id="logout">خروج از پنل</button>';
    app.innerHTML = html;
    bindTopbar();
    document.getElementById("logout").onclick = function () { try { localStorage.removeItem(AUTH_KEY); } catch (e) {} render(); };
  }

  // -------------------------------------------------------------- channels (tree)
  function channelsView() {
    var html = topbar("کانال‌ها");
    html += '<button class="back" id="back">→ صفحه‌ی اصلی</button>';
    var opened = openSet();
    var list = state.config.pages.map(function (cp, i) { var pg = pageData(cp); return { cp: cp, page: pg, last: lastActivity(cp, pg), i: i }; });
    list.sort(function (a, b) {
      if (a.last && b.last) return b.last.t - a.last.t;
      if (a.last) return -1; if (b.last) return 1; return a.i - b.i;
    });
    html += '<div class="clist">';
    list.forEach(function (x) {
      var cp = x.cp, page = x.page, open = !!opened[cp.id];
      var nc = newCount(cp, page);
      var sub = x.last ? (x.last.dated ? "آخرین انتشار " : "تغییر تعداد محتوا ") + ago(new Date(x.last.t).toISOString()) + " · " + PNAME[x.last.pl] : "محتوایی شناسایی نشد";
      html += '<div class="cgroup' + (open ? " open" : "") + '" data-page="' + esc(cp.id) + '">';
      html += '<div class="chead"><button class="cbox" data-id="' + esc(cp.id) + '" aria-expanded="' + open + '">' +
        logoHTML(cp, page) +
        '<span class="cn"><span class="cname">' + esc(cp.name) + '</span><span class="csub">' + esc(sub) + "</span></span>" +
        '<span class="bell' + (nc ? " on" : "") + '" title="' + (nc ? "لایک یا کامنت جدید" : "چیز جدیدی نیست") + '">' + ICON_BELL + (nc ? "<i>" + esc(compact(nc)) + "</i>" : "") + "</span>" +
        '<span class="pm">' + (open ? "−" : "+") + "</span></button>" +
        '<a class="pubmini" href="#/publish/' + esc(cp.id) + '" title="انتشار در ' + esc(cp.name) + '" aria-label="انتشار در ' + esc(cp.name) + '">' + ICON_SEND_SM + "</a></div>";
      if (open) {
        html += '<div class="branches">';
        PLATFORMS.forEach(function (pl) {
          var r = page.platforms[pl];
          var handle = (cp.accounts || {})[pl]; if (!handle) return;
          var url = (r && r.url) || "#";
          var shown = pl === "tiktok" ? "@" + String(handle).replace(/^@/, "") : handle;
          html += '<div class="branch" data-pl="' + pl + '">' +
            '<a class="bnet" href="' + esc(url) + '" target="_blank" rel="noopener">' + picon(pl) +
            '<span class="bt"><b>' + PNAME[pl] + '</b><span class="bh">' + esc(shown) + "</span></span></a>" +
            '<a class="bbtn" href="' + esc(LOGIN_URL[pl]) + '" target="_blank" rel="noopener" title="ورود به ' + PNAME[pl] + '">' + ICON_LOGIN + "<span>ورود</span></a>" +
            '<a class="bbtn chartbtn" data-route="a/' + esc(cp.id) + "/" + pl + '" href="#/a/' + esc(cp.id) + "/" + pl + '" title="آمار ' + PNAME[pl] + " " + esc(cp.name) + '" aria-label="آمار ' + PNAME[pl] + '">' + ICON_CHART + "</a>" +
            "</div>";
        });
        html += "</div>";
      }
      html += "</div>";
    });
    html += "</div>";
    html += '<p class="footnote">ترتیب کانال‌ها بر اساس جدیدترین انتشار در هر چهار شبکه است. زنگوله یعنی از آخرین باری که این کانال را باز کردی، لایک یا کامنت تازه آمده.</p>';
    app.innerHTML = html;
    bindTopbar();
    document.getElementById("back").onclick = function () { location.hash = "#/"; };
    Array.prototype.forEach.call(document.querySelectorAll(".cbox"), function (b) {
      b.onclick = function () {
        var id = b.getAttribute("data-id"), o = openSet();
        o[id] = !o[id]; saveOpen(o);
        if (o[id]) { var cp = cpById(id); markSeen(cp, pageData(cp)); }
        var y = window.scrollY; channelsView(); window.scrollTo(0, y);
      };
    });
  }

  // -------------------------------------------------------------- charts (vanilla SVG)
  var RANGES = [
    { id: "3h", label: "۳ ساعت اخیر", ms: 3 * HOUR, bucket: 15 * 60000 },
    { id: "24h", label: "۲۴ ساعت اخیر", ms: 24 * HOUR, bucket: HOUR },
    { id: "30d", label: "۳۰ روز اخیر", ms: 30 * DAY, bucket: DAY },
    { id: "90d", label: "۹۰ روز اخیر", ms: 90 * DAY, bucket: 3 * DAY }
  ];
  function rangeById(id) { return RANGES.filter(function (r) { return r.id === id; })[0] || RANGES[2]; }
  function bucketLabel(t, rg) { return rg.bucket < DAY ? fmtTime(new Date(t).toISOString()) : fmtDayOnly(new Date(t).toISOString()); }

  // items: [{label, y (number|null), tip}]; oldest on the left
  function svgChart(items, type, fmt, opts) {
    opts = opts || {};
    var vals = items.map(function (d) { return d.y; }).filter(function (v) { return v != null && !isNaN(v); });
    if (!vals.length) return '<div class="chart"><div class="empty">' + esc(opts.empty || "برای این بازه داده‌ای نیست") + "</div></div>";
    var W = 320, H = 150, T = 16, B = 8, n = items.length;
    var max = Math.max.apply(null, vals), min = Math.min.apply(null, vals);
    if (type === "bar" || opts.zero) { min = Math.min(0, min); max = Math.max(0, max); }
    if (max === min) { max = max + 1; if (type !== "bar" && !opts.zero) min = Math.max(0, min - 1); }
    var y = function (v) { return T + (H - T - B) * (1 - (v - min) / (max - min)); };
    var slot = W / n;
    var x = function (i) { return slot * (i + 0.5); };
    var s = '<svg viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="' + esc(opts.label || "") + '">';
    s += '<line x1="0" y1="' + y(Math.max(min, 0)).toFixed(1) + '" x2="' + W + '" y2="' + y(Math.max(min, 0)).toFixed(1) + '" stroke="currentColor" stroke-opacity=".15"/>';
    if (type === "bar") {
      var bw = Math.max(2, Math.min(26, slot * 0.68));
      items.forEach(function (d, i) {
        if (d.y == null) return;
        var y0 = y(0), y1 = y(d.y), top = Math.min(y0, y1), h = Math.max(1.5, Math.abs(y0 - y1));
        s += '<rect class="bar" x="' + (x(i) - bw / 2).toFixed(1) + '" y="' + top.toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + h.toFixed(1) + '" rx="' + Math.min(4, bw / 3).toFixed(1) + '"><title>' + esc((d.tip || d.label) + ": " + fmt(d.y)) + "</title></rect>";
        if (n <= 12) s += '<text x="' + x(i).toFixed(1) + '" y="' + (top - 4).toFixed(1) + '" text-anchor="middle" font-size="9" class="lbl">' + esc(fmt(d.y)) + "</text>";
      });
    } else {
      var pts = [];
      items.forEach(function (d, i) { if (d.y != null) pts.push([x(i), y(d.y), d]); });
      if (pts.length === 1) pts.unshift([0, pts[0][1], pts[0][2]]);
      var line = pts.map(function (q) { return q[0].toFixed(1) + "," + q[1].toFixed(1); }).join(" ");
      var base = y(Math.max(min, 0)).toFixed(1);
      s += '<polygon class="area" points="' + pts[0][0].toFixed(1) + "," + base + " " + line + " " + pts[pts.length - 1][0].toFixed(1) + "," + base + '"/>';
      s += '<polyline class="ln" points="' + line + '" fill="none" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>';
      if (pts.length <= 40) pts.forEach(function (q) { s += '<circle class="dot" cx="' + q[0].toFixed(1) + '" cy="' + q[1].toFixed(1) + '" r="2.8"><title>' + esc((q[2].tip || q[2].label) + ": " + fmt(q[2].y)) + "</title></circle>"; });
    }
    s += '<text x="2" y="10" font-size="9" class="lbl">' + esc(fmt(max)) + "</text>";
    s += "</svg>";
    var first = items[0], last = items[n - 1];
    return '<div class="chart" dir="ltr">' + s + '<div class="axis"><span>' + esc(first.label) + "</span><span>" + esc(last.label) + "</span></div></div>";
  }

  // value of a cumulative series at time t (last known point at or before t)
  function levelAt(s, k, t) {
    var v = null;
    for (var i = 0; i < s.length && s[i].t <= t; i++) if (s[i][k] != null) v = s[i][k];
    return v;
  }
  function firstAfter(s, k, t) {
    for (var i = 0; i < s.length; i++) if (s[i].t >= t && s[i][k] != null) return s[i];
    return null;
  }
  function buckets(rg, now) {
    var out = [], n = Math.round(rg.ms / rg.bucket), start = now - n * rg.bucket;
    for (var i = 0; i < n; i++) out.push({ a: start + i * rg.bucket, b: start + (i + 1) * rg.bucket });
    return out;
  }

  // -------------------------------------------------------------- analytics
  function sumOf(posts, k) {
    var have = posts.filter(function (p) { return p[k] != null; });
    if (!have.length) return null;
    return have.reduce(function (s, p) { return s + p[k]; }, 0);
  }
  function kpi(label, value, sub, note) {
    return '<div class="kpi"><div class="k">' + esc(label) + '</div><div class="v">' + esc(value) + "</div>" +
      (sub ? '<div class="pct">' + esc(sub) + "</div>" : "") + (note ? '<div class="n">' + esc(note) + "</div>" : "") + "</div>";
  }
  var BOX_KEY = "sp_box";
  function boxPref(key, def) { var all = lsGet(BOX_KEY, {}); var p = all[key] || {}; return { r: p.r || def.r, type: p.type || def.type, m: p.m || def.m }; }
  function saveBoxPref(key, p) { var all = lsGet(BOX_KEY, {}); all[key] = p; lsSet(BOX_KEY, all); }

  function metricUnavailable(pl, k) {
    if (k === "v" && pl === "instagram") return "اینستاگرام بازدید را بدون توکن Graph API نمی‌دهد";
    if (k === "v" && pl === "tiktok") return "تیک‌تاک بازدید را بدون دسترسی به اکانت نمی‌دهد";
    if (k === "l" && pl === "aparat") return "آپارات لایک را عمومی نمی‌دهد";
    if (k === "c" && pl === "youtube") return "تعداد کامنت یوتیوب با کلید YouTube API خوانده می‌شود";
    if (k === "c" && (pl === "aparat" || pl === "tiktok")) return PNAME[pl] + " کامنت را عمومی نمی‌دهد";
    return "این عدد از " + PNAME[pl] + " در دسترس نیست";
  }

  function boxBody(ctx, def, pref) {
    var rg = rangeById(pref.r), now = Date.now(), from = now - rg.ms;
    var s = ctx.series, pl = ctx.pl, html = "";
    if (def.kind === "level" || def.kind === "delta") {
      var k = def.key;
      if (!s.some(function (p) { return p[k] != null; })) return '<div class="chart"><div class="empty">' + esc(metricUnavailable(pl, k)) + "</div></div>";
      var bs = buckets(rg, now);
      var nowV = levelAt(s, k, now);
      var anchor = levelAt(s, k, from), anchorNote = "";
      if (anchor == null) { var fa1 = firstAfter(s, k, from); anchor = fa1 ? fa1[k] : null; anchorNote = fa1 ? " (از اولین ثبت: " + fmtShort(new Date(fa1.t).toISOString()) + ")" : ""; }
      var change = nowV != null && anchor != null ? nowV - anchor : null;
      var firstT = (s.filter(function (p) { return p[k] != null; })[0] || {}).t;
      var items = bs.map(function (b) {
        var lb = bucketLabel(b.b, rg), y;
        if (def.kind === "level") y = firstT != null && b.b >= firstT ? levelAt(s, k, b.b) : null;
        else {
          var e = levelAt(s, k, b.b), st = levelAt(s, k, b.a);
          y = e != null && st != null ? e - st : null;
        }
        return { label: lb, y: y, tip: lb };
      });
      var pointsIn = s.filter(function (p) { return p.t >= from && p[k] != null; }).length;
      if (def.kind === "level") html += '<div class="bhead"><b>' + esc(fa(nowV)) + "</b><span>" + esc(change == null ? "" : signed(change) + " در " + rg.label + anchorNote) + "</span></div>";
      else html += '<div class="bhead"><b>' + esc(change == null ? "—" : signed(change)) + "</b><span>" + esc("در " + rg.label + anchorNote) + "</span></div>";
      html += svgChart(items, pref.type, function (v) { return compact(v); }, {
        label: def.title, zero: def.kind === "delta",
        empty: pointsIn ? "برای این بازه هنوز داده‌ی کافی ثبت نشده" : "در این بازه هنوز اندازه‌گیری ثبت نشده (اندازه‌گیری هر ۳۰ دقیقه انجام می‌شود)"
      });
      return html;
    }
    // per-post metrics, filtered by post date
    var mk = pref.m || "views";
    var dated = ctx.posts.filter(function (p) { return p.published; });
    if (!ctx.posts.length) return '<div class="chart"><div class="empty">' + esc(pl === "tiktok" ? "تیک‌تاک فهرست و تاریخ ویدیوها را بدون دسترسی به اکانت نمی‌دهد" : "هنوز " + POSTS_LABEL[pl] + "ی شناسایی نشده") + "</div></div>";
    if (!dated.length) return '<div class="chart"><div class="empty">تاریخ انتشار ' + esc(POSTS_LABEL[pl]) + "‌ها در دسترس نیست</div></div>";
    var inR = dated.filter(function (p) { return tsOf(p.published) >= from; }).sort(function (a, b) { return tsOf(a.published) - tsOf(b.published); });
    var sum = sumOf(inR, mk);
    var mlabel = { views: "بازدید", likes: "لایک", comments: "کامنت" }[mk];
    html += '<div class="seg small" role="group">' + ["views", "likes", "comments"].map(function (m) {
      return '<button data-m="' + m + '" class="' + (m === mk ? "on" : "") + '">' + { views: "بازدید", likes: "لایک", comments: "کامنت" }[m] + "</button>";
    }).join("") + "</div>";
    html += '<div class="bhead"><b>' + esc(fa(inR.length)) + " " + esc(POSTS_LABEL[pl]) + "</b><span>" + esc("در " + rg.label + (inR.length ? " · مجموع " + mlabel + " " + (sum == null ? "—" : fa(sum)) : "")) + "</span></div>";
    var unavailable = ctx.posts.every(function (p) { return p[mk] == null; });
    if (unavailable) return html + '<div class="chart"><div class="empty">' + esc(metricUnavailable(pl, { views: "v", likes: "l", comments: "c" }[mk])) + "</div></div>";
    var items2 = inR.map(function (p) { var d = rg.ms <= DAY ? fmtTime(p.published) : fmtDayOnly(p.published); return { label: d, y: p[mk], tip: (p.title || "").slice(0, 40) + " · " + d }; });
    html += svgChart(items2, pref.type, function (v) { return compact(v); }, { label: mlabel, zero: true, empty: "در " + rg.label + " " + POSTS_LABEL[pl] + "ی منتشر نشده" });
    return html;
  }
  function boxHTML(ctx, def) {
    var key = ctx.pid + "/" + ctx.pl + "/" + def.id;
    var pref = boxPref(key, { r: "30d", type: def.kind === "level" ? "line" : "bar", m: "views" });
    return '<section class="abox" data-box="' + esc(def.id) + '" data-key="' + esc(key) + '">' +
      '<div class="abh"><h3>' + esc(def.title) + "</h3>" +
      '<div class="seg type" role="group" aria-label="نوع نمودار"><button data-type="line" class="' + (pref.type === "line" ? "on" : "") + '">خطی</button><button data-type="bar" class="' + (pref.type === "bar" ? "on" : "") + '">میله‌ای</button></div></div>' +
      '<div class="seg range" role="group" aria-label="بازه‌ی زمانی">' + RANGES.map(function (r) {
        return '<button data-r="' + r.id + '" class="' + (r.id === pref.r ? "on" : "") + '">' + r.label + "</button>";
      }).join("") + "</div>" +
      '<div class="abody">' + boxBody(ctx, def, pref) + "</div></section>";
  }
  function bindBoxes(ctx, defs) {
    Array.prototype.forEach.call(document.querySelectorAll(".abox"), function (el) {
      var def = defs.filter(function (d) { return d.id === el.getAttribute("data-box"); })[0];
      var key = el.getAttribute("data-key");
      el.onclick = function (e) {
        var b = e.target.closest ? e.target.closest("button") : null; if (!b || !el.contains(b)) return;
        var pref = boxPref(key, { r: "30d", type: def.kind === "level" ? "line" : "bar", m: "views" });
        if (b.hasAttribute("data-r")) pref.r = b.getAttribute("data-r");
        else if (b.hasAttribute("data-type")) pref.type = b.getAttribute("data-type");
        else if (b.hasAttribute("data-m")) pref.m = b.getAttribute("data-m");
        else return;
        saveBoxPref(key, pref);
        var tmp = document.createElement("div"); tmp.innerHTML = boxHTML(ctx, def);
        el.parentNode.replaceChild(tmp.firstChild, el);
        bindBoxes(ctx, defs);
      };
    });
  }

  function analyticsView(pid, pl) {
    var cp = cpById(pid);
    if (!cp || PLATFORMS.indexOf(pl) < 0) { location.hash = "#/channels"; return; }
    var page = pageData(cp), r = page.platforms[pl] || {};
    var ok = hasData(r);
    var posts = ok ? (r.recent || []).slice().sort(function (a, b) { return (b.published || "") > (a.published || "") ? 1 : -1; }) : [];
    var html = topbar(cp.name);
    html += '<button class="back" id="back">→ کانال‌ها</button>';
    html += '<div class="ahead" data-page="' + esc(pid) + '" data-platform="' + pl + '">' + logoHTML(cp, page, "big", pl) + '<div class="at"><h1>' + esc(cp.name) + "</h1>" +
      '<div class="asub">' + picon(pl) + "<span><b>" + PNAME[pl] + '</b> · <span class="ah" dir="ltr">' + esc(r.handle || (cp.accounts || {})[pl] || "") + '</span></span><a href="' + esc(r.url || "#") + '" target="_blank" rel="noopener">باز کردن ↗</a></div></div></div>';

    if (!ok) {
      var why = pl === "instagram" ? "داده اینستاگرام هنوز در دسترس نیست (نیاز به توکن)"
        : /not found/i.test(r.error || "") ? "این آیدی در " + PNAME[pl] + " پیدا نشد؛ آیدی را در config.json بررسی کن."
        : "داده‌ای از " + PNAME[pl] + " برای این کانال دریافت نشد.";
      html += '<div class="nodata" id="nodata"><div class="nd-ic">' + picon(pl) + "</div><b>" + esc(why) + "</b>" +
        (pl === "instagram" ? "<p>اینستاگرام از سرور گیت‌هاب گاهی مسدود است. برای آمار کامل، توکن Instagram Graph API را به‌عنوان Secret مخزن (IG_ACCESS_TOKEN و IG_USER_ID) اضافه کن.</p>" : "") +
        (r.error ? '<p class="err" dir="ltr">' + esc(r.error) + "</p>" : "") + "</div>";
      app.innerHTML = html;
      window.scrollTo(0, 0); bindTopbar();
      document.getElementById("back").onclick = function () { location.hash = "#/channels"; };
      return;
    }
    if (r.stale) html += '<div class="alert">آخرین تلاش ناموفق بود؛ عددها مربوط به ' + esc(fmtDateTime(r.fetched_at)) + " هستند.</div>";

    html += '<div class="kpis three">' +
      kpi(FOLLOW_LABEL[pl], fa(r.followers)) +
      kpi("کل " + POSTS_LABEL[pl] + "‌ها", fa(r.posts)) +
      kpi(pl === "tiktok" ? "کل لایک‌ها" : "کل بازدیدها", fa(pl === "tiktok" ? r.total_likes : r.total_views), "", (pl === "tiktok" ? r.total_likes : r.total_views) == null ? NO_ACCESS : "") +
      "</div>";
    var act = platformActivity(pid, pl, r);
    html += '<p class="lastpost">' + esc(act ? (act.dated ? "آخرین انتشار: " : "آخرین تغییر تعداد محتوا: ") + fmtDateTime(new Date(act.t).toISOString()) + " (" + ago(new Date(act.t).toISOString()) + ")" : "هنوز انتشاری شناسایی نشده") + "</p>";

    var ctx = { pid: pid, pl: pl, series: seriesOf(pid, pl), posts: posts };
    var defs = [
      { id: "followers", title: "روند " + FOLLOW_LABEL[pl] + "‌ها", kind: "level", key: "f" },
      { id: "views", title: "بازدید تازه", kind: "delta", key: "v" },
      { id: "likes", title: "لایک تازه", kind: "delta", key: "l" },
      { id: "comments", title: "کامنت تازه", kind: "delta", key: "c" },
      { id: "posts", title: "عملکرد هر " + POSTS_LABEL[pl] + " (بر اساس تاریخ انتشار)", kind: "posts" }
    ];
    html += '<div class="aboxes">' + defs.map(function (d) { return boxHTML(ctx, d); }).join("") + "</div>";

    html += "<h3>محتوا به ترتیب آخرین انتشار</h3>";
    if (!posts.length) {
      html += '<div class="muted-note">' + esc(r.posts === 0 ? "هنوز " + POSTS_LABEL[pl] + "ی منتشر نشده" :
        pl === "tiktok" ? "تیک‌تاک آمار تک‌ویدیو را بدون دسترسی به اکانت نمی‌دهد" : "فهرست در دسترس نیست") + "</div>";
    } else {
      html += '<div class="posts">' + posts.map(function (p, i) {
        var m = [];
        m.push("بازدید " + fa(p.views));
        m.push("لایک " + fa(p.likes) + (p.likes != null && p.views ? " (" + pct((p.likes / p.views) * 100) + ")" : ""));
        m.push("کامنت " + fa(p.comments));
        if (p.shares != null) m.push("اشتراک " + fa(p.shares));
        if (p.saves != null) m.push("ذخیره " + fa(p.saves));
        return '<a class="post" href="' + esc(p.url) + '" target="_blank" rel="noopener">' +
          '<span class="pn">' + fa(i + 1) + "</span>" +
          (p.thumb ? '<img loading="lazy" referrerpolicy="no-referrer" alt="" src="' + esc(p.thumb) + '" onerror="this.remove()">' : "") +
          '<div class="body"><div class="pt">' + esc(p.title || "(بدون عنوان)") + '</div><div class="pm2">' + esc(p.published ? fmtShort(p.published) + " · " + ago(p.published) : "تاریخ نامشخص") + "</div>" +
          '<div class="pm">' + m.map(function (x) { return "<span>" + esc(x) + "</span>"; }).join("") + "</div></div></a>";
      }).join("") + "</div>";
    }
    html += '<p class="footnote">هر جعبه فیلتر زمانی و نوع نمودار خودش را دارد. عددهای «تازه» تفاوت بین اندازه‌گیری‌های ثبت‌شده است (هر ۳۰ دقیقه، تا ۹۰ روز). «—» یعنی عدد در دسترس نبود؛ هیچ عددی حدس زده نمی‌شود.</p>';
    app.innerHTML = html;
    window.scrollTo(0, 0);
    bindTopbar();
    bindBoxes(ctx, defs);
    document.getElementById("back").onclick = function () { location.hash = "#/channels"; };
  }

  // ------------------------------------------------------------- settings
  function settingsView() {
    var tok = getToken();
    var html = topbar("تنظیمات");
    html += '<button class="back" id="back">→ صفحه‌ی اصلی</button>';
    html += '<section class="card form">' +
      "<h2>توکن گیت‌هاب</h2>" +
      '<p class="help">با این توکن، دکمه‌ی به‌روزرسانی بالای صفحه همان لحظه آمار و <b>عکس‌های پروفایل</b> همه‌ی کانال‌ها را از نو می‌خواند، و بخش «انتشار محتوا» فایل‌ها را در صف انتشار می‌گذارد. توکن <b>فقط در مرورگر همین گوشی</b> (localStorage) ذخیره می‌شود و هرگز داخل مخزن یا سایت قرار نمی‌گیرد.</p>' +
      '<ol class="steps"><li>در گیت‌هاب به <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">Fine-grained personal access token ↗</a> برو.</li>' +
      "<li>یک نام و تاریخ انقضا بگذار. در <b>Repository access</b> گزینه‌ی <b>Only select repositories</b> و فقط <b dir=\"ltr\">social-panel</b> را انتخاب کن.</li>" +
      "<li>در <b>Permissions → Repository permissions</b>: <b dir=\"ltr\">Actions: Read and write</b> و <b dir=\"ltr\">Contents: Read and write</b> (Metadata خودکار Read می‌شود).</li>" +
      "<li>توکن ساخته‌شده (با <span dir=\"ltr\">github_pat_</span> شروع می‌شود) را کپی کن و این‌جا بچسبان.</li></ol>" +
      '<label for="tok">توکن</label><div class="pw"><input id="tok" type="password" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="github_pat_…" value="' + esc(tok) + '">' +
      '<button type="button" class="show" id="showtok">' + ICON_EYE + "<span>نمایش</span></button></div>" +
      '<div class="row-btns"><button class="go" id="savetok">ذخیره</button><button class="ghost" id="testtok"' + (tok ? "" : " disabled") + '>آزمایش توکن</button>' +
      (tok ? '<button class="ghost danger" id="deltok">حذف توکن</button>' : "") + "</div>" +
      '<div class="msg" id="tokmsg">' + (tok ? "توکن روی این دستگاه ثبت شده است." : "توکنی ثبت نشده؛ دکمه‌ی به‌روزرسانی فقط آخرین داده‌های ذخیره‌شده را دوباره بارگذاری می‌کند.") + "</div></section>";
    app.innerHTML = html;
    bindTopbar();
    document.getElementById("back").onclick = function () { location.hash = "#/"; };
    var ti = document.getElementById("tok"), sb = document.getElementById("showtok"), msg = document.getElementById("tokmsg");
    sb.onclick = function () { var s = ti.type === "text"; ti.type = s ? "password" : "text"; sb.innerHTML = (s ? ICON_EYE : ICON_EYE_OFF) + "<span>" + (s ? "نمایش" : "پنهان") + "</span>"; };
    document.getElementById("savetok").onclick = function () {
      var v = ti.value.trim();
      if (!v) { msg.textContent = "اول توکن را بچسبان."; return; }
      if (!/^(github_pat_|ghp_|gho_)/.test(v)) { msg.textContent = "این شبیه توکن گیت‌هاب نیست (باید با github_pat_ شروع شود)."; return; }
      setToken(v); settingsView(); testToken();
    };
    var tt = document.getElementById("testtok"); if (tt) tt.onclick = testToken;
    var dt = document.getElementById("deltok"); if (dt) dt.onclick = function () { setToken(""); settingsView(); toast("توکن از این دستگاه حذف شد"); };
  }
  function testToken() {
    var msg = document.getElementById("tokmsg"); if (msg) msg.textContent = "در حال آزمایش…";
    Promise.all([gh(""), gh("/actions/workflows").catch(function (e) { return { _err: e }; })]).then(function (res) {
      var repo = res[0], wf = res[1], parts = [];
      parts.push(repo.permissions && repo.permissions.push ? "✓ دسترسی Contents (نوشتن) دارد" : "✗ دسترسی نوشتن Contents ندارد");
      parts.push(wf && !wf._err ? "✓ دسترسی Actions دارد" : "✗ دسترسی Actions ندارد");
      if (msg) msg.textContent = parts.join(" · ");
    }).catch(function (e) { if (msg) msg.textContent = "✗ " + ghErrorFa(e); });
  }

  // ------------------------------------------------------------- publish
  function allTargets() {
    var t = [];
    state.config.pages.forEach(function (cp) { PLATFORMS.forEach(function (pl) { if ((cp.accounts || {})[pl]) t.push({ page: cp.id, platform: pl }); }); });
    return t;
  }
  function targetsFor(sel) {
    if (sel === "all") return allTargets();
    var p = sel.split("|"), cp = cpById(p[0]); if (!cp) return [];
    if (p[1] === "*") return PLATFORMS.filter(function (pl) { return (cp.accounts || {})[pl]; }).map(function (pl) { return { page: cp.id, platform: pl }; });
    return [{ page: cp.id, platform: p[1] }];
  }
  function targetName(t) { var cp = cpById(t.page); return (cp ? cp.name : t.page) + " · " + (PNAME[t.platform] || t.platform); }
  var ST_FA = { pending: "در انتظار", scheduled: "زمان‌بندی‌شده", processing: "در حال انتشار", published: "منتشر شد", partial: "بخشی منتشر شد", failed: "ناموفق", needs_setup: "نیاز به راه‌اندازی", cancelled: "لغو شد", skipped: "رد شد" };
  var ST_CLS = { published: "good", partial: "warn", failed: "bad", needs_setup: "warn", cancelled: "", pending: "accent", scheduled: "accent", processing: "accent", skipped: "" };
  function stPill(st) { return '<span class="pill ' + (ST_CLS[st] || "") + '">' + esc(ST_FA[st] || st) + "</span>"; }

  function nowTehranInput(offsetMin) {
    var o = tehranParts(new Date(Date.now() + (offsetMin || 0) * 60000));
    return o.year + "-" + o.month + "-" + o.day + "T" + o.hour + ":" + o.minute;
  }

  function publishView(preId, prePl) {
    var tok = getToken();
    var html = topbar("انتشار محتوا");
    html += '<button class="back" id="back">→ صفحه‌ی اصلی</button>';
    if (!tok) {
      html += '<section class="card lilac-note"><div class="vi">' + ICON_SEND + "</div><h2>اول توکن گیت‌هاب را اضافه کن</h2>" +
        "<p>انتشار از داخل این پنل با یک توکن گیت‌هاب انجام می‌شود (فایل در صف انتشار گذاشته می‌شود و GitHub Action آن را منتشر می‌کند). توکن فقط در مرورگر همین گوشی می‌ماند.</p>" +
        '<a class="go" href="#/settings">رفتن به تنظیمات</a></section>';
      app.innerHTML = html; bindTopbar();
      document.getElementById("back").onclick = function () { location.hash = "#/"; };
      return;
    }
    var sel = preId ? preId + "|" + (prePl || "*") : "all";
    var opts = '<option value="all"' + (sel === "all" ? " selected" : "") + ">همه‌ی کانال‌ها (همه‌ی شبکه‌ها)</option>";
    state.config.pages.forEach(function (cp) {
      opts += '<optgroup label="' + esc(cp.name) + '"><option value="' + esc(cp.id) + '|*"' + (sel === cp.id + "|*" ? " selected" : "") + ">" + esc(cp.name) + " · همه‌ی شبکه‌ها</option>";
      PLATFORMS.forEach(function (pl) { if ((cp.accounts || {})[pl]) { var v = cp.id + "|" + pl; opts += '<option value="' + esc(v) + '"' + (sel === v ? " selected" : "") + ">" + esc(cp.name) + " · " + PNAME[pl] + "</option>"; } });
      opts += "</optgroup>";
    });
    html += '<section class="card form pubform" id="pubform">' +
      '<label for="pf">فایل (ویدیو یا عکس)</label><input id="pf" type="file" accept="video/*,image/*">' +
      '<div class="fileinfo" id="fileinfo"></div>' +
      '<label for="pt">عنوان</label><input id="pt" type="text" maxlength="100" placeholder="عنوان (برای یوتیوب و آپارات)">' +
      '<label for="pc">کپشن / توضیحات</label><textarea id="pc" rows="4" maxlength="2200" placeholder="متن پست…"></textarea>' +
      '<label for="ps">مقصد</label><select id="ps">' + opts + "</select>" +
      '<div class="pub-btns"><button class="go" id="btnOne">انتشار در این کانال</button><button class="go alt" id="btnAll">انتشار در همه کانال‌ها</button><button class="ghost" id="btnSched">زمان‌بندی</button></div>' +
      '<div class="sched" id="schedbox" hidden><label for="pd">زمان انتشار (به وقت تهران)</label><input id="pd" type="datetime-local" min="' + nowTehranInput(5) + '" value="' + nowTehranInput(60) + '">' +
      '<button class="go" id="btnSchedOk">ثبت زمان‌بندی برای مقصد انتخاب‌شده</button></div>' +
      '<div class="msg" id="pubmsg"></div></section>';
    html += '<div class="jobs-h"><h3>صف انتشار</h3><button class="ghost sm" id="reloadjobs">به‌روزرسانی فهرست</button></div><div id="jobs" class="jobs"><div class="muted-note">در حال بارگذاری…</div></div>';
    html += '<p class="footnote">فایل در گیت‌هاب ذخیره و در صف گذاشته می‌شود؛ GitHub Action حداکثر هر ۱۵ دقیقه صف را بررسی و منتشر می‌کند. برای هر شبکه، تا وقتی کلید دسترسی‌اش در Secrets مخزن نباشد، وضعیت «نیاز به راه‌اندازی» نشان داده می‌شود.</p>';
    app.innerHTML = html;
    bindTopbar();
    document.getElementById("back").onclick = function () { location.hash = "#/"; };
    var fileIn = document.getElementById("pf"), msg = document.getElementById("pubmsg");
    fileIn.onchange = function () {
      var f = fileIn.files[0], fi = document.getElementById("fileinfo");
      if (!f) { fi.textContent = ""; return; }
      fi.textContent = f.name + " · " + fa(Math.round(f.size / 1024 / 1024 * 10) / 10) + " مگابایت" + (f.size > MAX_UPLOAD ? " — بزرگ‌تر از حد مجاز ۷۰ مگابایت" : "");
      fi.className = "fileinfo" + (f.size > MAX_UPLOAD ? " bad" : "");
    };
    function go(targets, when) {
      var f = fileIn.files[0];
      var title = document.getElementById("pt").value.trim(), caption = document.getElementById("pc").value.trim();
      if (!f) { msg.textContent = "اول یک فایل انتخاب کن."; return; }
      if (!/^(video|image)\//.test(f.type)) { msg.textContent = "فقط ویدیو یا عکس پذیرفته می‌شود."; return; }
      if (f.size > MAX_UPLOAD) { msg.textContent = "حجم فایل بیشتر از ۷۰ مگابایت است."; return; }
      if (!targets.length) { msg.textContent = "مقصدی انتخاب نشده."; return; }
      var whenTxt = when ? "در " + fmtDateTime(when) : "همین حالا";
      if (!window.confirm("این محتوا " + whenTxt + " در " + fa(targets.length) + " مقصد منتشر شود؟\n\n" + targets.map(targetName).join("\n"))) return;
      setPubBusy(true);
      submitJob(f, title, caption, targets, when, function (t) { msg.textContent = t; }).then(function (job) {
        msg.textContent = "✓ در صف انتشار قرار گرفت (" + job.id + ").";
        fileIn.value = ""; document.getElementById("fileinfo").textContent = "";
        document.getElementById("schedbox").hidden = true;
        setPubBusy(false); loadJobs();
      }).catch(function (e) { msg.textContent = "✗ " + ghErrorFa(e); setPubBusy(false); });
    }
    document.getElementById("btnOne").onclick = function () {
      var s = document.getElementById("ps").value;
      if (s === "all") { msg.textContent = "برای «انتشار در این کانال» از فهرست مقصد یک کانال انتخاب کن، یا «انتشار در همه کانال‌ها» را بزن."; return; }
      go(targetsFor(s), null);
    };
    document.getElementById("btnAll").onclick = function () { go(allTargets(), null); };
    document.getElementById("btnSched").onclick = function () { var b = document.getElementById("schedbox"); b.hidden = !b.hidden; };
    document.getElementById("btnSchedOk").onclick = function () {
      var v = document.getElementById("pd").value;
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v)) { msg.textContent = "تاریخ و ساعت را کامل انتخاب کن."; return; }
      var iso = v + ":00+03:30"; // Iran has no daylight saving: always UTC+03:30
      if (tsOf(iso) < Date.now() + 60000) { msg.textContent = "زمان انتخاب‌شده گذشته است."; return; }
      go(targetsFor(document.getElementById("ps").value), iso);
    };
    document.getElementById("reloadjobs").onclick = loadJobs;
    loadJobs();
  }
  function setPubBusy(b) {
    Array.prototype.forEach.call(document.querySelectorAll("#pubform button, #pubform input, #pubform select, #pubform textarea"), function (el) { el.disabled = b; });
  }
  function readBase64(file) {
    return new Promise(function (res, rej) {
      var fr = new FileReader();
      fr.onload = function () { var s = String(fr.result); res(s.slice(s.indexOf(",") + 1)); };
      fr.onerror = function () { rej(new Error("خواندن فایل ممکن نشد")); };
      fr.readAsDataURL(file);
    });
  }
  function uploadBlob(b64, onPct) {
    return new Promise(function (res, rej) {
      var x = new XMLHttpRequest();
      x.open("POST", "https://api.github.com/repos/" + GH_OWNER + "/" + GH_REPO + "/git/blobs");
      var h = ghHeaders({ "Content-Type": "application/json" }); for (var k in h) x.setRequestHeader(k, h[k]);
      x.upload.onprogress = function (e) { if (e.lengthComputable) onPct(Math.round(e.loaded / e.total * 100)); };
      x.onload = function () {
        var d = null; try { d = JSON.parse(x.responseText); } catch (e) {}
        if (x.status >= 200 && x.status < 300 && d && d.sha) res(d.sha);
        else { var err = new Error((d && d.message) || "HTTP " + x.status); err.status = x.status; rej(err); }
      };
      x.onerror = function () { rej(new Error("اتصال قطع شد")); };
      x.send(JSON.stringify({ content: b64, encoding: "base64" }));
    });
  }
  // put the uploaded blob on the media-upload branch (the workflow moves it to the
  // "media-queue" release and clears the branch); retried once if the branch moved
  function stageOnBranch(path, sha, attempt) {
    return gh("/git/ref/heads/" + MEDIA_BRANCH).catch(function (e) { if (e.status === 404) return null; throw e; }).then(function (ref) {
      var parent = ref && ref.object && ref.object.sha;
      var base = parent ? gh("/git/commits/" + parent).then(function (c) { return c.tree.sha; }) : Promise.resolve(null);
      return base.then(function (baseTree) {
        var body = { tree: [{ path: path, mode: "100644", type: "blob", sha: sha }] };
        if (baseTree) body.base_tree = baseTree;
        return gh("/git/trees", { method: "POST", body: body });
      }).then(function (tree) {
        return gh("/git/commits", { method: "POST", body: { message: "media: " + path, tree: tree.sha, parents: parent ? [parent] : [] } });
      }).then(function (commit) {
        if (parent) return gh("/git/refs/heads/" + MEDIA_BRANCH, { method: "PATCH", body: { sha: commit.sha, force: false } });
        return gh("/git/refs", { method: "POST", body: { ref: "refs/heads/" + MEDIA_BRANCH, sha: commit.sha } });
      });
    }).catch(function (e) {
      if (!attempt && (e.status === 422 || e.status === 409)) return sleep(1500).then(function () { return stageOnBranch(path, sha, 1); });
      throw e;
    });
  }
  function submitJob(file, title, caption, targets, when, say) {
    var o = tehranParts(new Date());
    var id = o.year + o.month + o.day + "-" + o.hour + o.minute + o.second + "-" + Math.random().toString(36).slice(2, 6);
    var ext = (file.name.match(/\.([A-Za-z0-9]{1,5})$/) || [, file.type.split("/")[1] || "bin"])[1].toLowerCase();
    var path = "media/" + id + "." + ext;
    say("در حال آماده‌سازی فایل…");
    return readBase64(file).then(function (b64) {
      say("در حال آپلود فایل… ۰٪");
      return uploadBlob(b64, function (p) { say("در حال آپلود فایل… " + fa(p) + "٪"); });
    }).then(function (sha) {
      say("در حال ثبت فایل…");
      return stageOnBranch(path, sha).then(function () { return sha; });
    }).then(function (sha) {
      var nowIso = o.year + "-" + o.month + "-" + o.day + "T" + o.hour + ":" + o.minute + ":" + o.second + "+03:30";
      var job = {
        id: id, created_at: nowIso, publish_at: when || nowIso,
        targets: targets, title: title || caption.split("\n")[0].slice(0, 90) || file.name, caption: caption,
        media: { branch: MEDIA_BRANCH, path: path, blob_sha: sha, name: file.name, type: file.type, size: file.size },
        asset_url: null, status: "pending", results: {}
      };
      say("در حال افزودن به صف انتشار…");
      return gh("/contents/queue/" + id + ".json", { method: "PUT", body: { message: "queue: " + id + (when ? " (scheduled)" : ""), content: b64utf8(JSON.stringify(job, null, 1) + "\n"), branch: GH_BRANCH } }).then(function () { return job; });
    });
  }
  function loadJobs() {
    var box = document.getElementById("jobs"); if (!box) return;
    gh("/contents/queue?ref=" + GH_BRANCH).catch(function (e) { if (e.status === 404) return []; throw e; }).then(function (files) {
      files = (files || []).filter(function (f) { return /\.json$/.test(f.name); }).sort(function (a, b) { return a.name < b.name ? 1 : -1; }).slice(0, 25);
      return Promise.all(files.map(function (f) {
        return gh("/contents/queue/" + f.name + "?ref=" + GH_BRANCH, { headers: { Accept: "application/vnd.github.raw+json" } }).then(function (j) {
          if (typeof j === "string") j = JSON.parse(j);
          j._sha = f.sha; j._name = f.name; return j;
        }).catch(function () { return null; });
      }));
    }).then(function (jobs) {
      jobs = jobs.filter(Boolean);
      if (!document.getElementById("jobs")) return;
      if (!jobs.length) { box.innerHTML = '<div class="muted-note">هنوز چیزی در صف نیست.</div>'; return; }
      box.innerHTML = jobs.map(function (j) {
        var st = j.status === "pending" && tsOf(j.publish_at) > Date.now() + 60000 ? "scheduled" : j.status;
        var res = j.results || {};
        return '<div class="job" data-id="' + esc(j.id) + '"><div class="jh">' + stPill(st) + '<b class="jt">' + esc(j.title || "(بدون عنوان)") + "</b></div>" +
          '<div class="jm">' + esc((st === "scheduled" ? "زمان انتشار: " : "ثبت: ") + fmtDateTime(st === "scheduled" ? j.publish_at : j.created_at)) + (j.media ? " · " + esc(j.media.name || "") : "") + "</div>" +
          '<ul class="jtargets">' + (j.targets || []).map(function (t) {
            var r = res[t.page + "/" + t.platform] || {};
            var tst = r.status || (j.status === "cancelled" ? "cancelled" : "pending");
            return "<li>" + picon(t.platform) + '<span class="tn">' + esc(targetName(t)) + "</span>" + stPill(tst) +
              (r.reason ? '<div class="tr">' + esc(r.reason) + "</div>" : "") + (r.url ? '<a class="tr" href="' + esc(r.url) + '" target="_blank" rel="noopener">مشاهده ↗</a>' : "") + "</li>";
          }).join("") + "</ul>" +
          (j.status === "pending" ? '<button class="ghost danger sm cancel" data-name="' + esc(j._name) + '" data-sha="' + esc(j._sha) + '">لغو این انتشار</button>' : "") + "</div>";
      }).join("");
      Array.prototype.forEach.call(box.querySelectorAll(".cancel"), function (b) {
        b.onclick = function () {
          if (!window.confirm("این انتشار لغو شود؟")) return;
          b.disabled = true;
          var name = b.getAttribute("data-name");
          var job = jobs.filter(function (j) { return j._name === name; })[0];
          var copy = {}; for (var k in job) if (k.charAt(0) !== "_") copy[k] = job[k];
          copy.status = "cancelled"; copy.cancelled_at = new Date().toISOString();
          gh("/contents/queue/" + name, { method: "PUT", body: { message: "queue: cancel " + job.id, content: b64utf8(JSON.stringify(copy, null, 1) + "\n"), sha: b.getAttribute("data-sha"), branch: GH_BRANCH } })
            .then(function () { toast("انتشار لغو شد"); loadJobs(); })
            .catch(function (e) { toast("لغو ممکن نشد: " + ghErrorFa(e), 5000); b.disabled = false; });
        };
      });
    }).catch(function (e) { if (document.getElementById("jobs")) box.innerHTML = '<div class="muted-note">' + esc("خواندن صف ممکن نشد: " + ghErrorFa(e)) + "</div>"; });
  }

  // ------------------------------------------------------------- login
  function sha256hex(s) {
    return crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)).then(function (b) {
      return Array.prototype.map.call(new Uint8Array(b), function (x) { return ("0" + x.toString(16)).slice(-2); }).join("");
    });
  }
  function authed() { try { return localStorage.getItem(AUTH_KEY) === AUTH_HASH; } catch (e) { return false; } }
  function loginView() {
    app.innerHTML = '<div class="login-wrap"><form class="login" id="lf" autocomplete="on">' +
      '<div class="logo">' + ICON_LOCK + "</div>" +
      '<h1>ورود به پنل</h1><p class="s">این پنل محرمانه است</p>' +
      '<label for="u">نام کاربری</label><input id="u" name="username" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" required>' +
      '<label for="p">رمز عبور</label><div class="pw"><input id="p" name="password" type="password" autocomplete="current-password" required>' +
      '<button type="button" class="show" id="show" aria-label="نمایش رمز">' + ICON_EYE + "<span>نمایش</span></button></div>" +
      '<button class="go" type="submit">ورود</button><div class="err" id="err"></div></form></div>';
    var pi = document.getElementById("p"), sb = document.getElementById("show");
    sb.onclick = function () {
      var showing = pi.type === "text";
      pi.type = showing ? "password" : "text";
      sb.innerHTML = (showing ? ICON_EYE : ICON_EYE_OFF) + "<span>" + (showing ? "نمایش" : "پنهان") + "</span>";
      sb.setAttribute("aria-label", showing ? "نمایش رمز" : "پنهان کردن رمز");
    };
    document.getElementById("lf").onsubmit = function (e) {
      e.preventDefault();
      var u = document.getElementById("u").value.trim(), p = pi.value;
      sha256hex(AUTH_SALT + u + "|" + p).then(function (h) {
        if (h === AUTH_HASH) { try { localStorage.setItem(AUTH_KEY, h); } catch (e2) {} render(); }
        else { document.getElementById("err").textContent = "نام کاربری یا رمز عبور اشتباه است"; }
      });
    };
  }

  // ------------------------------------------------------------- router
  function render() {
    if (!authed()) { if (!document.getElementById("lf")) loginView(); return; }
    if (state.error && !state.config) { app.innerHTML = '<div class="loading">بارگذاری داده‌ها ناموفق بود. اتصال را بررسی کنید.</div>'; return; }
    if (!state.config) return;
    var h = location.hash || "#/";
    var a = h.match(/^#\/a\/([\w-]+)\/(\w+)/), pb = h.match(/^#\/publish(?:\/([\w-]+))?(?:\/(\w+))?/);
    if (a) analyticsView(a[1], a[2]);
    else if (pb) publishView(pb[1], pb[2]);
    else if (/^#\/settings/.test(h)) settingsView();
    else if (/^#\/(channels|p\/)/.test(h)) channelsView();
    else homeView();
  }
  function getJSON(url, fresh) {
    return fetch(url + (fresh ? "?t=" + Date.now() : ""), { cache: "no-store" }).then(function (r) {
      if (!r.ok) throw new Error(url + " " + r.status);
      return r.json();
    });
  }
  function load(fresh, quiet) {
    return Promise.all([
      getJSON("config.json", fresh),
      getJSON("data/latest.json", true).catch(function () { return null; }),
      getJSON("data/history.json", true).catch(function () { return { series: {} }; })
    ]).then(function (res) {
      state.config = res[0]; state.latest = res[1]; state.history = res[2]; state.error = null;
      if (!quiet) rerenderSafe();
    }).catch(function (e) { state.error = e; if (!quiet) render(); });
  }

  window.addEventListener("hashchange", render);
  if (!authed()) loginView();
  load(false);

  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    window.addEventListener("load", function () { navigator.serviceWorker.register("sw.js").catch(function () {}); });
    var reloaded = false, hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener("controllerchange", function () {
      if (!hadController || reloaded || onFormPage()) return; reloaded = true; location.reload();
    });
  }
})();
