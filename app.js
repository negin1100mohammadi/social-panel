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

  var SP_VERSION = "v7";
  window.SP_VERSION = SP_VERSION;
  var state = { config: null, latest: null, history: null, postsHist: null, error: null, busy: false, progress: "", syncAvailable: false, encCreated: null, chOrder: null };
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
    var t = tsOf(iso); if (t == null) return "—";
    try { o.timeZone = TZ; return new Intl.DateTimeFormat("fa-IR", o).format(new Date(t)); } catch (e) { return String(iso); }
  }
  function fmtDateTime(iso) { return fmtFmt(iso, { year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" }); }
  function fmtShort(iso) { return fmtFmt(iso, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); }
  function fmtDayOnly(iso) { return fmtFmt(iso, { month: "short", day: "numeric" }); }
  function fmtTime(iso) { return fmtFmt(iso, { hour: "2-digit", minute: "2-digit" }); }
  function ago(iso) {
    var t0 = tsOf(iso); if (t0 == null) return "—";
    var ms = Date.now() - t0;
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
  // Timestamps: ISO 8601 (with Z or offset) is the data format. Also accepts epoch ms, "YYYY-MM-DD HH:MM[:SS]"
  // (no zone = Tehran) and display strings like "Sat 2026-11-14 4:24 PM (UTC+03:30)" (older/hand-made data).
  // Never relies on the engine's lenient Date parsing (Safari returns NaN for most non-ISO strings).
  var TS_RE = /^(?:[A-Za-z]{3},?\s+)?(\d{4})-(\d{2})-(\d{2})(?:[T\s]+(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?\s*([AaPp][Mm])?)?\s*(?:\(?\s*(?:UTC|GMT)?\s*(Z|[+-]\d{2}:?\d{2})?\s*\)?)?$/;
  function tsOf(v) {
    if (v == null || v === "") return null;
    if (typeof v === "number") return isFinite(v) ? v : null;
    if (v instanceof Date) { var dv = v.getTime(); return isNaN(dv) ? null : dv; }
    var m = TS_RE.exec(String(v).trim());
    if (!m) { var t0 = Date.parse(v); return isNaN(t0) ? null : t0; }
    var h = +(m[4] || 0), mi = +(m[5] || 0), se = +(m[6] || 0), ms = m[7] ? +(m[7] + "00").slice(0, 3) : 0;
    if (m[8]) { var pm = /p/i.test(m[8]); if (h === 12) h = pm ? 12 : 0; else if (pm) h += 12; }
    var off = 3.5 * 60; // minutes; no zone given -> Tehran
    if (m[9]) off = m[9] === "Z" ? 0 : (m[9][0] === "-" ? -1 : 1) * (+m[9].replace(/[^\d]/g, "").slice(0, 2) * 60 + +m[9].replace(/[^\d]/g, "").slice(2, 4));
    if (!m[4] && !m[9]) { h = 12; } // bare date: noon Tehran
    var t = Date.UTC(+m[1], +m[2] - 1, +m[3], h, mi, se, ms) - off * 60000;
    return isNaN(t) ? null : t;
  }

  // ------------------------------------------------------------ platform info
  // "ورود" opens the account's owner/admin area (sign-in first when needed), not the public page
  function adminLinks(cp, pl, r) {
    if (pl === "instagram") return [
      { label: "ورود", long: "داشبورد حرفه‌ای اینستاگرام", url: "https://www.instagram.com/accounts/login/?next=%2Faccounts%2Fprofessional_dashboard%2F" },
      { label: "Meta", long: "Meta Business Suite", url: "https://business.facebook.com/latest/home" }];
    if (pl === "youtube") {
      var cid = r && /^UC[\w-]{22}$/.test(r.channel_id || "") ? r.channel_id : "";
      var studio = "https://studio.youtube.com/" + (cid ? "channel/" + cid : "");
      return [{ label: "ورود", long: "YouTube Studio", url: "https://accounts.google.com/ServiceLogin?service=youtube&continue=" + encodeURIComponent(studio) }];
    }
    if (pl === "aparat") return [{ label: "ورود", long: "داشبورد آپارات", url: "https://www.aparat.com/dashboard" }];
    if (pl === "tiktok") return [{ label: "ورود", long: "TikTok Studio", url: "https://www.tiktok.com/tiktokstudio" }];
    return [];
  }
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
  var ICON_TOOLS = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l1.8 4.2L18 9l-4.2 1.8L12 15l-1.8-4.2L6 9l4.2-1.8z"/><path d="M18.5 14.5l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z"/><path d="M5.5 15.5l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z"/></svg>';
  var ICON_GEAR = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>';

  // ------------------------------------------------------------ channel helpers
  function pageData(cp) { return (state.latest && state.latest.pages[cp.id]) || { id: cp.id, name: cp.name, platforms: {} }; }
  function cpById(id) { return state.config.pages.filter(function (p) { return p.id === id; })[0]; }
  function hasData(r) { return !!(r && (r.ok || r.stale)); }
  function num(v) { if (v == null || v === "") return null; var n = Number(v); return isFinite(n) ? n : null; }
  function seriesOf(pid, pl) {
    var s = (((state.history && state.history.series) || {})[pid + "/" + pl] || []).map(function (p) {
      var t = p.t ? tsOf(p.t) : (p.d ? tsOf(p.d) : null);
      return { t: t, f: num(p.f), p: num(p.p), v: num(p.v), l: num(p.l), c: num(p.c), b: p.b || null };
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
    var job = tokenState().has ? runRefreshWorkflow() : Promise.resolve({ ran: false });
    job.then(function (res) {
      setProgress("در حال دریافت داده‌های تازه…");
      return load(true, true).then(function () { state.chOrder = null; return res; });
    }).then(function (res) {
      state.busy = false; state.progress = ""; rerenderSafe();
      var now = state.latest && state.latest.updated_at;
      if (res.error) toast(res.error, 5000);
      else if (res.ran) toast(now && now !== before ? "همه‌ی کانال‌ها و عکس‌های پروفایل به‌روز شد" : "اجرا تمام شد؛ تغییری در داده‌ها نبود");
      else toast(now && now !== before ? "داده‌های تازه بارگذاری شد" : "داده‌ها به‌روز هستند · آخرین بررسی " + ago(now) + (tokenState().locked ? " · برای بررسی فوری، رمز پنل را یک بار وارد کن" : " · برای بررسی فوری، توکن را در تنظیمات بگذار"));
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
    var total = 0, ts = tokenState();
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
      '<div class="vs">' + esc(ts.has ? "آپلود ویدیو یا عکس، انتشار و زمان‌بندی" : ts.locked ? "برای فعال‌سازی اتصال، رمز پنل را یک بار وارد کن" : "اول توکن گیت‌هاب را در تنظیمات بگذار") + "</div></span>" +
      '<span class="arrow">←</span></a>';
    html += '<a class="toolbox" href="#/tools" id="toolbox">' +
      '<span class="vi">' + ICON_TOOLS + '</span><span><div class="vt">ابزارها</div>' +
      '<div class="vs">هوش‌های مصنوعی برای نگین و امیرحسین</div></span>' +
      '<span class="arrow">←</span></a>';
    html += "</div>";
    html += '<a class="setrow" href="#/settings">' + ICON_GEAR + "<span>تنظیمات</span><em id=\"tok-pill\" data-state=\"" + ts.state + "\">" + esc(ts.label) + "</em></a>";
    html += '<button class="logout" id="logout">خروج از پنل</button>';
    app.innerHTML = html;
    bindTopbar();
    document.getElementById("logout").onclick = function () { try { localStorage.removeItem(AUTH_KEY); } catch (e) {} setSessPw("", ""); closeUnlock(); render(); };
  }

  // -------------------------------------------------------------- channels (tree)
  // The order is computed once (newest activity first) and then kept for the whole visit: nothing that loads
  // in the background (data, token sync, avatars, fonts) may move a row while the user is about to tap it.
  function channelOrder() {
    if (state.chOrder && state.chOrder.length === state.config.pages.length) return state.chOrder;
    var list = state.config.pages.map(function (cp, i) { var pg = pageData(cp); return { id: cp.id, last: lastActivity(cp, pg), i: i }; });
    list.sort(function (a, b) {
      if (a.last && b.last && b.last.t !== a.last.t) return b.last.t - a.last.t;
      if (a.last && !b.last) return -1; if (b.last && !a.last) return 1; return a.i - b.i;
    });
    state.chOrder = list.map(function (x) { return x.id; });
    return state.chOrder;
  }
  function channelsView() {
    var html = topbar("کانال‌ها");
    html += '<button class="back" id="back">→ صفحه‌ی اصلی</button>';
    var opened = openSet();
    html += '<div class="clist" id="clist">';
    channelOrder().forEach(function (id) {
      var cp = cpById(id); if (!cp) return;
      var page = pageData(cp), last = lastActivity(cp, page), open = !!opened[cp.id];
      var nc = newCount(cp, page);
      var sub = last ? (last.dated ? "آخرین انتشار " : "تغییر تعداد محتوا ") + ago(new Date(last.t).toISOString()) + " · " + PNAME[last.pl] : "محتوایی شناسایی نشد";
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
          var route = "#/a/" + cp.id + "/" + pl;
          html += '<div class="branch" data-pl="' + pl + '" data-page="' + esc(cp.id) + '">' +
            '<a class="bnet" href="' + esc(url) + '" target="_blank" rel="noopener" title="صفحه‌ی عمومی ' + PNAME[pl] + '">' + picon(pl) +
            '<span class="bt"><b>' + PNAME[pl] + '</b><span class="bh">' + esc(shown) + "</span></span></a>" +
            adminLinks(cp, pl, r).map(function (x, i) {
              return '<a class="bbtn adm' + (i ? " alt" : "") + '" data-admin="' + pl + '" href="' + esc(x.url) + '" target="_blank" rel="noopener" title="' + esc(x.long) + '">' + (i ? "" : ICON_LOGIN) + "<span>" + esc(x.label) + "</span></a>";
            }).join("") +
            (pl === "youtube" ? ytBtnHTML(cp.id) : "") +
            '<a class="bbtn chartbtn" data-route="' + esc(route.slice(2)) + '" href="' + esc(route) + '" title="آمار ' + PNAME[pl] + " " + esc(cp.name) + '" aria-label="آمار ' + PNAME[pl] + " " + esc(cp.name) + '">' + ICON_CHART + "</a>" +
            "</div>";
        });
        html += '<p class="adm-note">«ورود» بخش مدیریت همان اکانت را باز می‌کند. اگر در آن مرورگر چند اکانت وارد شده‌اند، بعد از باز شدن از منوی همان سایت اکانت درست را انتخاب کن.</p>';
        html += "</div>";
      }
      html += "</div>";
    });
    html += "</div>";
    html += '<p class="footnote">ترتیب کانال‌ها بر اساس جدیدترین انتشار در هر چهار شبکه است (در طول این بازدید ثابت می‌ماند). زنگوله یعنی از آخرین باری که این کانال را باز کردی، لایک یا کامنت تازه آمده.</p>';
    app.innerHTML = html;
    bindTopbar();
    document.getElementById("back").onclick = function () { location.hash = "#/"; };
    loadYt();
    Array.prototype.forEach.call(document.querySelectorAll(".cbox"), function (b) {
      b.onclick = function () {
        var id = b.getAttribute("data-id"), o = openSet();
        o[id] = !o[id]; saveOpen(o);
        if (o[id]) { var cp = cpById(id); markSeen(cp, pageData(cp)); }
        var y = window.scrollY; channelsView(); window.scrollTo(0, y);
      };
    });
  }

  // -------------------------------------------------------------- tools (AI apps)
  // Each AI opens its normal page; Negin and Amirhossein sign in there themselves (one button each, same link).
  var TOOL_DEFAULTS = {
    accounts: [{ id: "negin", name: "نگین" }, { id: "amirhossein", name: "امیرحسین" }],
    items: [
      { id: "hark", name: "Hark", url: "https://hark.com" },
      { id: "muse", name: "Muse", url: "", editable: true },
      { id: "gemini", name: "Gemini", url: "https://gemini.google.com/app" },
      { id: "chatgpt", name: "ChatGPT", url: "https://chatgpt.com" },
      { id: "claude", name: "Claude", url: "https://claude.ai" },
      { id: "aistudio", name: "Google AI Studio", url: "https://aistudio.google.com" },
      { id: "flow", name: "Google Flow", url: "https://labs.google/fx/tools/flow" }
    ]
  };
  var TOOL_COLORS = { hark: "#7c3aed", muse: "#0f766e", gemini: "#1a73e8", chatgpt: "#10a37f", claude: "#d97757", aistudio: "#4285f4", flow: "#ea4335" };
  var TOOL_URL_KEY = "sp_tool_url"; // { <tool id>: url } typed on this device (e.g. Muse)
  function toolsConf() {
    var t = (state.config && state.config.tools) || {};
    return { accounts: t.accounts && t.accounts.length ? t.accounts : TOOL_DEFAULTS.accounts, items: t.items && t.items.length ? t.items : TOOL_DEFAULTS.items };
  }
  function toolURL(it) {
    var own = (lsGet(TOOL_URL_KEY, {}) || {})[it.id];
    return (it.editable && own) ? own : (it.url || "");
  }
  function hostOf(u) { return String(u || "").replace(/^https?:\/\//, "").replace(/\/.*$/, ""); }
  function toolsView() {
    var T = toolsConf(), opened = lsGet("sp_tool_open", "");
    var html = topbar("ابزارها");
    html += '<button class="back" id="back">→ صفحه‌ی اصلی</button>';
    html += '<div class="tlist" id="tlist">' + T.items.map(function (it) {
      var open = opened === it.id, url = toolURL(it);
      var badge = '<span class="tbadge" style="background:' + (TOOL_COLORS[it.id] || "#64748b") + '">' + esc((it.name || "?").replace(/^Google\s+/, "").charAt(0).toUpperCase()) + "</span>";
      var h = '<div class="tool' + (open ? " open" : "") + '" data-tool="' + esc(it.id) + '"><button type="button" class="thead" aria-expanded="' + open + '">' + badge +
        '<span class="tn"><b>' + esc(it.name) + "</b><small>" + esc(url ? hostOf(url) : "لینک تنظیم نشده") + "</small></span>" +
        '<span class="pm">' + (open ? "−" : "+") + "</span></button>";
      if (open) {
        h += '<div class="taccs">';
        if (!url) h += '<div class="muted-note tmissing">لینک تنظیم نشده — آدرس را پایین وارد کن.</div>';
        else T.accounts.forEach(function (acc) {
          h += '<a class="tacc" data-acc="' + esc(acc.id) + '" href="' + esc(url) + '" target="_blank" rel="noopener"><b>' + esc(acc.name) + "</b></a>";
        });
        h += "</div>";
        if (it.editable) h += '<form class="turl" data-tool="' + esc(it.id) + '" onsubmit="return false"><label for="turl-' + esc(it.id) + '">لینک ' + esc(it.name) + '</label><div class="turl-row"><input id="turl-' + esc(it.id) + '" type="text" dir="ltr" inputmode="url" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="https://…" value="' + esc(url) + '"><button type="submit" class="go sm">ذخیره</button></div></form>';
      }
      return h + "</div>";
    }).join("") + "</div>";
    app.innerHTML = html;
    bindTopbar();
    document.getElementById("back").onclick = function () { location.hash = "#/"; };
    var tl = document.getElementById("tlist");
    tl.onclick = function (e) {
      var hd = e.target.closest ? e.target.closest(".thead") : null; if (!hd) return;
      var id = hd.parentNode.getAttribute("data-tool");
      lsSet("sp_tool_open", lsGet("sp_tool_open", "") === id ? "" : id);
      var y = window.scrollY; toolsView(); window.scrollTo(0, y);
    };
    Array.prototype.forEach.call(tl.querySelectorAll(".turl"), function (f) {
      f.onsubmit = function (e) {
        if (e) e.preventDefault();
        var id = f.getAttribute("data-tool"), v = f.querySelector("input").value.trim();
        if (v && !/^https?:\/\//i.test(v)) v = "https://" + v;
        if (v && !/^https?:\/\/[^\s/]+\.[^\s]+/i.test(v)) { toast("این شبیه یک لینک نیست"); return false; }
        var all = lsGet(TOOL_URL_KEY, {}) || {}; if (v) all[id] = v; else delete all[id]; lsSet(TOOL_URL_KEY, all);
        toast(v ? "لینک ذخیره شد" : "لینک پاک شد"); toolsView();
        return false;
      };
    });
  }

  // -------------------------------------------------------------- charts (vanilla SVG)
  // Every box has its own window. A window is [now - ms, now], measured on real timestamps.
  // Buckets are aligned to the Tehran clock (Iran has no DST: fixed +03:30) and clipped to the window.
  var TEH_OFF = 3.5 * HOUR;
  var RANGES = [
    { id: "3h", short: "۳ ساعت", label: "۳ ساعت اخیر", ms: 3 * HOUR, bucket: 30 * 60000, axis: "time" },
    { id: "24h", short: "۲۴ ساعت", label: "۲۴ ساعت اخیر", ms: 24 * HOUR, bucket: HOUR, axis: "time" },
    { id: "30d", short: "۳۰ روز", label: "۳۰ روز اخیر", ms: 30 * DAY, bucket: DAY, axis: "date" },
    { id: "90d", short: "۹۰ روز", label: "۹۰ روز اخیر", ms: 90 * DAY, bucket: 3 * DAY, axis: "date" }
  ];
  function rangeById(id) { return RANGES.filter(function (r) { return r.id === id; })[0] || RANGES[2]; }
  function tLabel(t, rg) { return rg.axis === "time" ? fmtTime(t) : fmtDayOnly(t); }
  function tFull(t, rg) { return rg.axis === "time" ? fmtShort(t) : fmtFmt(t, { month: "short", day: "numeric" }); }
  function gridStart(t, size) { return Math.floor((t + TEH_OFF) / size) * size - TEH_OFF; }
  function buckets(rg, now) {
    var from = now - rg.ms, out = [];
    for (var g = gridStart(from, rg.bucket); g <= now; g += rg.bucket) {
      out.push({ a: Math.max(g, from), b: Math.min(g + rg.bucket, now), last: g + rg.bucket > now });
    }
    return out;
  }
  function inBucket(t, bk) { return t >= bk.a && (bk.last ? t <= bk.b : t < bk.b); }

  // value of a series at time t (last known point at or before t)
  function pointAt(s, k, t) {
    var hit = null;
    for (var i = 0; i < s.length && s[i].t <= t; i++) if (s[i][k] != null) hit = s[i];
    return hit;
  }
  // two snapshots are comparable for a "new views/likes/comments" increment when they measure the same thing:
  // same basis (channel total vs. sum of the recent posts list) and, for a recent-list sum, the same post count
  function comparable(a, b, k) {
    if (a[k] == null || b[k] == null) return false;
    var ba = (a.b || {})[k] || "", bb = (b.b || {})[k] || "";
    if (ba !== bb) return false;
    if (ba === "t") return true;
    return a.p === b.p;
  }

  // Pure computation for one box: items to plot + header numbers + coverage. Exposed for tests.
  function computeLevelDelta(s, k, kind, rg, now) {
    var from = now - rg.ms;
    var all = s.filter(function (p) { return p[k] != null && p.t <= now; });
    var res = { from: from, to: now, kind: kind, items: [], value: null, change: null, anchorFirst: null, coverage: null, n: 0, firstEver: all.length ? all[0].t : null, count: 0 };
    if (!all.length) { res.state = "unavailable"; return res; }
    var inWin = all.filter(function (p) { return p.t >= from; });
    var before = pointAt(all, k, from - 1); // last point strictly before the window
    res.count = inWin.length;
    var last = all[all.length - 1];
    res.value = last[k]; res.lastEver = last.t;
    var anchor = before || inWin[0] || null;
    if (!before && inWin.length) res.anchorFirst = inWin[0].t;
    if (inWin.length) res.coverage = { a: inWin[0].t, b: inWin[inWin.length - 1].t };
    var bs = buckets(rg, now);
    if (kind === "level") {
      res.change = anchor && inWin.length ? last[k] - anchor[k] : null;
      res.items = bs.map(function (bk) {
        var hit = null;
        inWin.forEach(function (p) { if (inBucket(p.t, bk)) hit = p; });
        return { t: bk.a, y: hit ? hit[k] : null, at: hit ? hit.t : null };
      });
    } else {
      // chain of consecutive snapshots: anchor (before window, if any) + every snapshot in the window
      var chain = (before ? [before] : []).concat(inWin);
      var steps = [];
      for (var i = 1; i < chain.length; i++) {
        if (comparable(chain[i - 1], chain[i], k)) steps.push({ t: chain[i].t, d: chain[i][k] - chain[i - 1][k] });
      }
      res.change = chain.length >= 2 ? steps.reduce(function (a, x) { return a + x.d; }, 0) : null;
      res.items = bs.map(function (bk) {
        var sum = null;
        steps.forEach(function (x) { if (inBucket(x.t, bk)) sum = (sum || 0) + x.d; });
        return { t: bk.a, y: sum, at: bk.b };
      });
    }
    // the plotted range starts at the first bucket that has data (no fake empty lead-in)
    var firstIdx = -1;
    for (var j = 0; j < res.items.length; j++) if (res.items[j].y != null) { firstIdx = j; break; }
    res.items = firstIdx < 0 ? [] : res.items.slice(firstIdx);
    res.n = res.items.filter(function (d) { return d.y != null; }).length;
    res.state = res.n >= 2 ? "ok" : "insufficient";
    return res;
  }
  // items: [{label, y (number|null), tip}]; oldest on the left
  function svgChart(items, type, fmt, opts) {
    opts = opts || {};
    var vals = items.map(function (d) { return d.y; }).filter(function (v) { return v != null && isFinite(v); });
    var n = items.length;
    if (!vals.length) return '<div class="chart" data-state="empty" data-n="0"><div class="empty">' + esc(opts.empty || "برای این بازه داده‌ای نیست") + "</div></div>";
    var W = 320, H = 150, T = 18, B = 10, L = 4, R = 4;
    var max = Math.max.apply(null, vals), min = Math.min.apply(null, vals), flat = max === min;
    if (opts.zero) { min = Math.min(0, min); max = Math.max(0, max); }
    else if (type === "bar") { var pad = flat ? Math.max(1, Math.abs(max) * 0.1) : (max - min) * 0.25; min = min - pad; } // level bars: baseline under the lowest value, so differences stay visible
    var span = max - min;
    var y = function (v) { return span === 0 ? T + (H - T - B) / 2 : T + (H - T - B) * (1 - (v - min) / span); };
    var slot = (W - L - R) / n;
    var x = function (i) { return L + slot * (i + 0.5); };
    var s = '<svg viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="' + esc(opts.label || "") + '">';
    var zeroY = span === 0 ? H - B : y(Math.max(min, Math.min(0, max)));
    if (type === "bar") zeroY = span === 0 ? H - B : y(opts.zero ? 0 : min);
    s += '<line x1="0" y1="' + zeroY.toFixed(1) + '" x2="' + W + '" y2="' + zeroY.toFixed(1) + '" stroke="currentColor" stroke-opacity=".15"/>';
    if (type === "bar") {
      var bw = Math.max(2, Math.min(26, slot * 0.68));
      items.forEach(function (d, i) {
        if (d.y == null || !isFinite(d.y)) return;
        var y1 = span === 0 ? (d.y === 0 ? zeroY : T) : y(d.y);
        var top = Math.min(zeroY, y1), h = Math.max(1.5, Math.abs(zeroY - y1));
        s += '<rect class="bar" data-v="' + d.y + '" x="' + (x(i) - bw / 2).toFixed(1) + '" y="' + top.toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + h.toFixed(1) + '" rx="' + Math.min(4, bw / 3).toFixed(1) + '"><title>' + esc((d.tip || d.label) + ": " + fmt(d.y)) + "</title></rect>";
        if (n <= 12) s += '<text x="' + x(i).toFixed(1) + '" y="' + Math.max(9, top - 4).toFixed(1) + '" text-anchor="middle" font-size="9" class="lbl">' + esc(fmt(d.y)) + "</text>";
      });
    } else {
      var pts = [];
      items.forEach(function (d, i) { if (d.y != null && isFinite(d.y)) pts.push([x(i), y(d.y), d]); });
      var line = pts.map(function (q) { return q[0].toFixed(1) + "," + q[1].toFixed(1); }).join(" ");
      if (pts.length > 1) {
        var base = (span === 0 ? H - B : y(min)).toFixed(1);
        s += '<polygon class="area" points="' + pts[0][0].toFixed(1) + "," + base + " " + line + " " + pts[pts.length - 1][0].toFixed(1) + "," + base + '"/>';
        s += '<polyline class="ln" points="' + line + '" fill="none" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>';
      }
      if (pts.length <= 48) pts.forEach(function (q) { s += '<circle class="dot" data-v="' + q[2].y + '" cx="' + q[0].toFixed(1) + '" cy="' + q[1].toFixed(1) + '" r="2.8"><title>' + esc((q[2].tip || q[2].label) + ": " + fmt(q[2].y)) + "</title></circle>"; });
    }
    var yfmt = function (v) { return Math.abs(v) < 1e6 ? fa(v, { maximumFractionDigits: 1 }) : fmt(v); }; // exact on the axis: 10,007 vs 10,019 must not both read "10K"
    if (flat) s += '<text x="' + (W / 2) + '" y="10" text-anchor="middle" font-size="10" class="lbl flat">' + esc("بدون تغییر: " + yfmt(vals[0])) + "</text>";
    else if (!(type === "bar" && n <= 12)) { // bars with their own value labels need no axis numbers
      s += '<text x="2" y="10" font-size="9" class="lbl ymax">' + esc(yfmt(Math.max.apply(null, vals))) + "</text>";
      s += '<text x="2" y="' + (H - 1) + '" font-size="9" class="lbl ymin">' + esc(yfmt(Math.min.apply(null, vals))) + "</text>";
    }
    s += "</svg>";
    var first = items[0], last = items[n - 1], mid = items[Math.floor((n - 1) / 2)];
    var ax = '<span class="ax0">' + esc(first.label) + "</span>" + (n >= 5 ? '<span class="ax1">' + esc(mid.label) + "</span>" : "") + '<span class="ax2">' + esc(n > 1 ? last.label : "") + "</span>";
    return '<div class="chart" dir="ltr" data-state="ok" data-n="' + vals.length + '" data-slots="' + n + '" data-first="' + esc(first.label) + '" data-last="' + esc(last.label) + '">' + s + '<div class="axis">' + ax + "</div></div>";
  }

  // -------------------------------------------------------------- analytics (v6: per-post, one page-level filter)
  // data/posts_history.json keeps, for every account, the time of every successful read ("runs") and for every
  // listed post its views/likes/comments at each read (a point is stored when a number changed).
  // Gain of a post in [a, b] = value at b − value at a. A post published inside the selected window counts from 0.
  // A post published before the window but first seen inside it counts from its first reading (labelled).
  var K3 = ["v", "l", "c"];
  var KNAME = { v: "بازدید", l: "لایک", c: "کامنت" };
  var MKEY = { views: "v", likes: "l", comments: "c" };
  var VIEW_KEY = "sp_view";
  function viewPref() {
    var p = lsGet(VIEW_KEY, {}) || {};
    return { r: rangeById(p.r || "24h").id, m: /^(views|likes|comments)$/.test(p.m || "") ? p.m : "views", type: p.type === "line" ? "line" : "bar" };
  }
  function saveViewPref(p) { lsSet(VIEW_KEY, { r: p.r, m: p.m, type: p.type }); }

  function loadPH(pid, pl) {
    var c = (((state.postsHist || {}).channels) || {})[pid + "/" + pl];
    if (!c) return null;
    var runs = (c.runs || []).map(tsOf).filter(function (t) { return t != null; }).sort(function (a, b) { return a - b; });
    var posts = Object.keys(c.posts || {}).map(function (id) {
      var e = c.posts[id] || {};
      var pts = (e.s || []).map(function (q) { return { t: tsOf(q[0]), v: num(q[1]), l: num(q[2]), c: num(q[3]) }; })
        .filter(function (q) { return q.t != null; }).sort(function (a, b) { return a.t - b.t; });
      return { id: id, title: e.title || "", url: e.url || "", thumb: e.thumb || "", published: tsOf(e.published),
        first: pts.length ? pts[0].t : null, last: tsOf(e.last) || (pts.length ? pts[pts.length - 1].t : null), pts: pts };
    }).filter(function (p) { return p.pts.length; });
    return { runs: runs, posts: posts };
  }
  // value of metric k at time T (undefined before the first reading; may be null when the platform did not give it)
  function valAt(p, k, T) {
    if (p.first == null || T < p.first) return undefined;
    var v;
    for (var i = 0; i < p.pts.length && p.pts[i].t <= T; i++) v = p.pts[i][k];
    return v;
  }
  function firstWith(p, k, a, b) {
    for (var i = 0; i < p.pts.length; i++) { var q = p.pts[i]; if (q.t > b) break; if (q.t > a && q[k] != null) return q; }
    return null;
  }
  // gain of one post in [a, b]; winFrom = start of the selected window (decides "published in the window -> from 0")
  function postGain(p, k, a, b, winFrom) {
    if (p.first == null || p.first > b) return null; // not read yet at b
    var end = valAt(p, k, b);
    var fresh = p.published != null && p.published >= winFrom;
    if (end == null) return { g: null, fresh: fresh };
    var base = p.first <= a ? valAt(p, k, a) : null, since = null;
    if (base == null) {
      var f = firstWith(p, k, p.first <= a ? a : p.first - 1, b);
      if (!f) return { g: null, fresh: fresh };
      if (fresh) base = 0; else { base = f[k]; since = f.t; }
    }
    return { g: end - base, fresh: fresh, since: since, end: end };
  }
  function computeWindow(ph, rg, now) {
    var from = now - rg.ms;
    var res = { from: from, to: now, runsIn: 0, firstRun: null, lastRun: null, posts: [], totals: {}, avail: {}, sortKey: "v" };
    if (!ph) { res.none = true; return res; }
    var runs = ph.runs.filter(function (t) { return t <= now; });
    res.firstRun = runs.length ? runs[0] : null;
    res.lastRun = runs.length ? runs[runs.length - 1] : null;
    res.runsIn = runs.filter(function (t) { return t >= from; }).length;
    K3.forEach(function (k) { res.avail[k] = ph.posts.some(function (p) { return p.pts.some(function (q) { return q[k] != null; }); }); });
    res.sortKey = res.avail.v ? "v" : res.avail.l ? "l" : "c";
    ph.posts.forEach(function (p) {
      if (p.first == null || p.first > now) return;
      if (p.last != null && p.last < from) return; // left the platform's list before this window: unknown
      var row = { p: p, g: {}, cur: {}, fresh: p.published != null && p.published >= from && p.published <= now, since: null };
      K3.forEach(function (k) {
        var r = postGain(p, k, from, now, from);
        row.g[k] = r ? r.g : null;
        var cv = valAt(p, k, now); row.cur[k] = cv == null ? null : cv;
        if (r && r.since != null && (row.since == null || r.since < row.since)) row.since = r.since;
      });
      res.posts.push(row);
    });
    K3.forEach(function (k) {
      var have = res.posts.filter(function (r) { return r.g[k] != null; });
      res.totals[k] = have.length ? have.reduce(function (s, r) { return s + r.g[k]; }, 0) : null;
    });
    var sk = res.sortKey;
    res.posts.sort(function (a, b) {
      var ga = a.g[sk] == null ? -Infinity : a.g[sk], gb = b.g[sk] == null ? -Infinity : b.g[sk];
      if (gb !== ga) return gb - ga;
      return (b.p.published || 0) - (a.p.published || 0);
    });
    return res;
  }
  // window gains over time: one value per Tehran-aligned bucket (null = no reading in that bucket)
  function computeTimeline(ph, k, rg, now) {
    var from = now - rg.ms, bs = buckets(rg, now);
    var runs = ph ? ph.runs : [];
    var items = bs.map(function (bk, i) {
      var has = runs.some(function (t) { return (i === 0 ? t >= bk.a : t > bk.a) && t <= bk.b; });
      if (!has) return { t: bk.a, b: bk.b, y: null };
      var sum = 0;
      ph.posts.forEach(function (p) { var r = postGain(p, k, bk.a, bk.b, from); if (r && r.g != null) sum += r.g; });
      return { t: bk.a, b: bk.b, y: sum };
    });
    var fi = -1;
    for (var j = 0; j < items.length; j++) if (items[j].y != null) { fi = j; break; }
    items = fi < 0 ? [] : items.slice(fi);
    var acc = 0;
    items.forEach(function (d) { if (d.y != null) { acc += d.y; d.cum = acc; } else d.cum = null; });
    return { items: items, n: items.filter(function (d) { return d.y != null; }).length, total: acc };
  }

  function sumOf(posts, k) {
    var have = posts.filter(function (p) { return p[k] != null; });
    if (!have.length) return null;
    return have.reduce(function (s, p) { return s + p[k]; }, 0);
  }
  function kpi(label, value, sub, note) {
    return '<div class="kpi"><div class="k">' + esc(label) + '</div><div class="v">' + esc(value) + "</div>" +
      (sub ? '<div class="pct">' + esc(sub) + "</div>" : "") + (note ? '<div class="n">' + esc(note) + "</div>" : "") + "</div>";
  }
  function metricUnavailable(pl, k) {
    if (k === "f") return "تعداد " + FOLLOW_LABEL[pl] + " از " + PNAME[pl] + " در دسترس نیست";
    if (k === "v" && pl === "instagram") return "اینستاگرام تعداد بازدید را بدون اتصال رسمی (توکن) نمی‌دهد";
    if (k === "v" && pl === "tiktok") return "تیک‌تاک بازدید را بدون دسترسی به اکانت نمی‌دهد";
    if (k === "l" && pl === "aparat") return "آپارات تعداد لایک را عمومی نمی‌دهد";
    if (k === "c" && pl === "youtube") return "یوتیوب تعداد کامنت را بدون کلید API نمی‌دهد";
    if (k === "c" && (pl === "aparat" || pl === "tiktok")) return PNAME[pl] + " تعداد کامنت را عمومی نمی‌دهد";
    return "این عدد از " + PNAME[pl] + " در دسترس نیست";
  }
  var NO_POSTS_MSG = { tiktok: "تیک‌تاک آمار تک‌تک ویدیوها را بدون دسترسی به اکانت نمی‌دهد؛ فقط مجموع لایک‌ها و تعداد دنبال‌کننده‌ها خوانده می‌شود." };
  var BUCKET_FA = { "3h": "نیم ساعت", "24h": "ساعت", "30d": "روز", "90d": "۳ روز" };
  function fmtWhen(t) { return fmtFmt(t, { month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" }); }
  function gainTxt(g) { return g == null ? "—" : g > 0 ? "+" + fa(g) : g === 0 ? "۰" : "−" + fa(Math.abs(g)); }
  function dataAttr(v) { return v == null ? "" : String(v); }

  function rangeNote(a, b, rg, extra) {
    return '<div class="range-note" data-from="' + (a == null ? "" : new Date(a).toISOString()) + '" data-to="' + (b == null ? "" : new Date(b).toISOString()) + '">' +
      esc(a == null ? "در این بازه داده‌ای ثبت نشده" : "داده‌ی نمودار: " + tFull(a, rg) + (b != null && b !== a ? " تا " + tFull(b, rg) : "") + (extra || "")) + "</div>";
  }

  // ---- page parts (pure HTML builders; `now` injectable for tests)
  function summaryHTML(A, pl, rg, W, chan) {
    var h = '<section class="sumbox" id="summary" data-r="' + rg.id + '" data-from="' + new Date(W.from).toISOString() + '" data-to="' + new Date(W.to).toISOString() + '"' +
      ' data-gv="' + dataAttr(W.totals.v) + '" data-gl="' + dataAttr(W.totals.l) + '" data-gc="' + dataAttr(W.totals.c) + '" data-runs="' + W.runsIn + '" data-nposts="' + W.posts.length + '">';
    h += '<div class="sum-h"><b>' + esc(rg.label) + '</b><span class="win" id="win">' + esc("از " + fmtWhen(W.from) + " تا " + fmtWhen(W.to)) + " <small>(به وقت تهران)</small></span></div>";
    if (A.noPosts) {
      h += '<div class="sum-msg">' + esc(A.noPosts) + "</div>";
    } else {
      h += '<div class="sum3">' + K3.map(function (k) {
        var av = W.avail[k], t = W.totals[k];
        return '<div class="s1" data-k="' + k + '"><div class="sv">' + esc(av ? gainTxt(t == null ? 0 : t) : "—") + '</div><div class="sk">' + KNAME[k] + " تازه</div>" +
          (av ? "" : '<div class="sn">' + esc(metricUnavailable(pl, k)) + "</div>") + "</div>";
      }).join("") + "</div>";
      h += '<div class="sum-sub">' + esc("جمع " + fa(W.posts.length) + " " + POSTS_LABEL[pl] + "ی که در این بازه زیر نظر بوده‌اند") + "</div>";
    }
    // coverage, stated exactly
    var cov;
    if (W.firstRun == null) cov = "هنوز اندازه‌گیری‌ای برای این اکانت ثبت نشده.";
    else {
      cov = "اندازه‌گیری در این بازه: " + fa(W.runsIn) + " بار" + (W.lastRun ? " · آخرین: " + fmtWhen(W.lastRun) + " (" + ago(new Date(W.lastRun).toISOString()) + ")" : "");
      if (W.firstRun > W.from) cov += " · داده از " + fmtWhen(W.firstRun) + " موجود است؛ قبل از آن عددی ثبت نشده و افزایش‌ها از همان زمان حساب شده‌اند.";
      if (!W.runsIn) cov += " · در این بازه اندازه‌گیری تازه‌ای انجام نشده، پس افزایشی دیده نمی‌شود.";
    }
    h += '<div class="cov" id="coverage" data-first="' + (W.firstRun == null ? "" : new Date(W.firstRun).toISOString()) + '">' + esc(cov) + "</div>";
    if (chan) h += chan;
    return h + "</section>";
  }
  // channel-wide totals (all videos, not only the listed ones) from data/history.json, when the platform gives them
  function channelTotalHTML(series, pl, r, rg, now) {
    var parts = [];
    [["v", "بازدید"], ["l", "لایک"]].forEach(function (x) {
      var k = x[0], last = null;
      for (var i = series.length - 1; i >= 0; i--) if (series[i][k] != null) { last = series[i]; break; }
      if (!last || ((last.b || {})[k] || "") !== "t") return;
      var R = computeLevelDelta(series, k, "delta", rg, now);
      if (R.change == null) return;
      parts.push('<span data-k="' + k + '" data-change="' + R.change + '">' + esc(gainTxt(R.change) + " " + x[1]) + "</span>");
    });
    if (!parts.length) return "";
    return '<div class="chan-total" id="chan-total">کل کانال (همه‌ی ' + esc(POSTS_LABEL[pl]) + "‌ها، طبق آمار خود " + esc(PNAME[pl]) + "): " + parts.join(" · ") + "</div>";
  }
  function trendHTML(A, pl, rg, pref, now) {
    var k = MKEY[pref.m];
    if (!A.noPosts && !A.W.avail[k] && A.W.avail[A.W.sortKey]) k = A.W.sortKey; // e.g. Instagram has no views: show likes
    var em = { v: "views", l: "likes", c: "comments" }[k];
    var h = '<section class="abox" id="trend" data-m="' + em + '" data-type="' + pref.type + '">';
    h += '<div class="abh"><h3>روند ' + KNAME[k] + " تازه</h3>" +
      '<div class="seg type" role="group" aria-label="نوع نمودار"><button type="button" data-type="bar" class="' + (pref.type === "bar" ? "on" : "") + '">میله‌ای</button><button type="button" data-type="line" class="' + (pref.type === "line" ? "on" : "") + '">خطی</button></div></div>';
    h += '<div class="seg small mseg" role="group" aria-label="کدام عدد">' + ["views", "likes", "comments"].map(function (m) {
      var na = !A.noPosts && !A.W.avail[MKEY[m]];
      return '<button type="button" data-m="' + m + '" class="' + (m === em ? "on" : "") + (na ? " na" : "") + '"' + (na ? ' disabled title="' + esc(metricUnavailable(pl, MKEY[m])) + '"' : "") + ">" + KNAME[MKEY[m]] + "</button>";
    }).join("") + "</div>";
    if (A.noPosts) return h + '<div class="chart" data-state="unavailable" data-n="0"><div class="empty">' + esc(A.noPosts) + "</div></div></section>";
    if (!A.W.avail[k]) return h + '<div class="chart" data-state="unavailable" data-n="0"><div class="empty">' + esc(metricUnavailable(pl, k)) + "</div></div></section>";
    var T = computeTimeline(A.ph, k, rg, now);
    h += '<p class="chart-cap">' + esc(pref.type === "bar" ? KNAME[k] + " تازه در هر " + BUCKET_FA[rg.id] + " (جمع همه‌ی " + POSTS_LABEL[pl] + "‌ها)" : "جمع " + KNAME[k] + " تازه از ابتدای بازه") + "</p>";
    if (T.n < 1) {
      h += '<div class="chart" data-state="insufficient" data-n="0"><div class="empty">' + esc("در این بازه اندازه‌گیری‌ای نیست" + (A.W.firstRun ? " — داده از " + fmtWhen(A.W.firstRun) + " جمع‌آوری شده" : "")) + "</div></div>";
    } else {
      var items = T.items.map(function (d) { return { label: tLabel(d.t, rg), y: pref.type === "bar" ? d.y : d.cum, tip: tFull(d.t, rg) + " تا " + fmtTime(d.b) }; });
      h += svgChart(items, pref.type, function (v) { return gainTxt(v); }, { label: KNAME[k], zero: true });
      h += '<div class="tl-meta" data-total="' + T.total + '" data-n="' + T.n + '"></div>';
    }
    return h + "</section>";
  }
  function followersHTML(series, pl, rg, pref, now) {
    var R = computeLevelDelta(series, "f", "level", rg, now);
    var h = '<section class="abox" id="followers"><div class="abh"><h3>' + esc(FOLLOW_LABEL[pl]) + "‌ها</h3></div>";
    if (R.state === "unavailable") return h + '<div class="chart" data-state="unavailable" data-n="0"><div class="empty">' + esc(metricUnavailable(pl, "f")) + "</div></div></section>";
    h += '<div class="bhead"><b>' + esc(fa(R.value)) + '</b><span class="chg" data-change="' + dataAttr(R.change) + '">' + esc(R.change == null ? "در این بازه اندازه‌گیری نشده" : (R.change === 0 ? "بدون تغییر" : signed(R.change)) + " در " + rangeById(pref.r).label + (R.anchorFirst != null ? " (از اولین ثبت: " + fmtShort(R.anchorFirst) + ")" : "")) + "</span></div>";
    if (R.state === "insufficient") h += '<div class="chart" data-state="insufficient" data-n="' + R.n + '"><div class="empty">' + esc("برای رسم نمودار هنوز اندازه‌گیری کافی در این بازه نیست — از " + fmtShort(R.firstEver) + " جمع‌آوری شده") + "</div></div>";
    else {
      var fitems = R.items.map(function (d) { var lb = tLabel(d.t, rg); return { label: lb, y: d.y, tip: d.at != null ? fmtShort(d.at) : lb }; });
      // the change is measured from the start value; if the first bucket only shows a later value, show the start too
      var startV = R.change == null ? null : R.value - R.change, startT = R.anchorFirst != null ? R.anchorFirst : R.from;
      if (startV != null && fitems.length && fitems[0].y !== startV) fitems.unshift({ label: tLabel(startT, rg), y: startV, tip: "شروع: " + fmtShort(startT) });
      h += svgChart(fitems, pref.type === "bar" ? "bar" : "line", function (v) { return fa(v); }, { label: FOLLOW_LABEL[pl] });
    }
    h += rangeNote(R.coverage && R.coverage.a, R.coverage && R.coverage.b, rg, R.count ? " · " + fa(R.count) + " اندازه‌گیری" : "");
    return h + "</section>";
  }
  function postsHTML(A, pl) {
    var W = A.W;
    if (A.noPosts) return '<div class="muted-note" id="plist-empty">' + esc(A.noPosts) + "</div>";
    if (!W.posts.length) return '<div class="muted-note" id="plist-empty">' + esc(A.ph && A.ph.runs.length ? "در این بازه " + POSTS_LABEL[pl] + "ی زیر نظر نبوده (هنوز " + POSTS_LABEL[pl] + "ی منتشر نشده یا فهرستش در دسترس نیست)." : "هنوز داده‌ی " + POSTS_LABEL[pl] + "‌ها ثبت نشده.") + "</div>";
    return '<div class="plist" id="plist">' + W.posts.map(function (row, i) {
      var p = row.p;
      var gains = K3.map(function (k) {
        var av = W.avail[k];
        return '<span class="g g' + k + (av && row.g[k] > 0 ? " up" : "") + '"' + (av ? "" : ' title="' + esc(metricUnavailable(pl, k)) + '"') + "><b>" + esc(av ? gainTxt(row.g[k]) : "—") + "</b> " + KNAME[k] + "</span>";
      }).join("");
      var tot = K3.map(function (k) { return (W.avail[k] && row.cur[k] != null ? fa(row.cur[k]) : "—") + " " + KNAME[k]; }).join(" · ");
      var notes = [];
      if (row.fresh) notes.push('<span class="tag new">منتشرشده در همین بازه — از صفر حساب شده</span>');
      else if (row.since != null) notes.push('<span class="tag">از اولین ثبت (' + esc(fmtWhen(row.since)) + ") حساب شده</span>");
      var quiet = !K3.some(function (k) { return row.g[k]; });
      return '<a class="prow' + (quiet ? " quiet" : "") + '" href="' + esc(p.url || "#") + '" target="_blank" rel="noopener" data-id="' + esc(p.id) + '" data-gv="' + dataAttr(row.g.v) + '" data-gl="' + dataAttr(row.g.l) + '" data-gc="' + dataAttr(row.g.c) + '" data-fresh="' + (row.fresh ? 1 : 0) + '">' +
        '<span class="pn">' + fa(i + 1) + "</span>" +
        '<span class="pthumb">' + (p.thumb ? '<img loading="lazy" referrerpolicy="no-referrer" alt="" src="' + esc(p.thumb) + '" onerror="this.remove()">' : "") + "</span>" +
        '<span class="pbody"><span class="pt">' + esc(p.title || "(بدون عنوان)") + "</span>" +
        '<span class="pd">' + esc(p.published != null ? "انتشار: " + fmtWhen(p.published) : "تاریخ انتشار نامشخص") + "</span>" +
        '<span class="pg">' + gains + "</span>" +
        '<span class="ptot">' + esc("الان در مجموع: " + tot) + "</span>" + notes.join("") + "</span></a>";
    }).join("") + "</div>";
  }
  window.__spChart = { tsOf: function (v) { return tsOf(v); }, computeLevelDelta: computeLevelDelta, buckets: buckets, RANGES: RANGES, comparable: comparable,
    loadPH: loadPH, valAt: valAt, postGain: postGain, computeWindow: computeWindow, computeTimeline: computeTimeline };

  function analyticsView(pid, pl, nowArg) {
    var cp = cpById(pid);
    if (!cp || PLATFORMS.indexOf(pl) < 0) { location.hash = "#/channels"; return; }
    var page = pageData(cp), r = page.platforms[pl] || {};
    var ok = hasData(r);
    var handle = r.handle || (cp.accounts || {})[pl] || "";
    var html = topbar(cp.name);
    html += '<button class="back" id="back">→ کانال‌ها</button>';
    html += '<div class="ahead" data-page="' + esc(pid) + '" data-platform="' + pl + '">' +
      '<span class="aplat">' + picon(pl) + "</span>" + logoHTML(cp, page, "big", pl) +
      '<div class="at"><h1 id="a-title">' + esc(cp.name) + '</h1><div class="asub"><b class="pname" id="a-platform">' + PNAME[pl] + '</b><span class="ah" dir="ltr">' + esc(pl === "tiktok" ? "@" + String(handle).replace(/^@/, "") : handle) + "</span></div>" +
      '<div class="alinks"><a href="' + esc(r.url || "#") + '" target="_blank" rel="noopener">صفحه‌ی عمومی ↗</a>' +
      adminLinks(cp, pl, r).map(function (x) { return '<a class="admin" href="' + esc(x.url) + '" target="_blank" rel="noopener">' + esc(x.long) + " ↗</a>"; }).join("") + "</div></div></div>";
    var isYt = pl === "youtube";
    if (isYt) html += '<section class="card ytcard" id="yt-conn-card" data-page="' + esc(pid) + '">' + ytConnCardHTML(pid) + "</section>";

    if (!ok) {
      var why = pl === "instagram" ? "داده اینستاگرام هنوز در دسترس نیست (نیاز به توکن)"
        : /not found/i.test(r.error || "") ? "این آیدی در " + PNAME[pl] + " پیدا نشد؛ آیدی را در config.json بررسی کن."
        : "داده‌ای از " + PNAME[pl] + " برای این کانال دریافت نشد.";
      html += '<div class="nodata" id="nodata"><div class="nd-ic">' + picon(pl) + "</div><b>" + esc(why) + "</b>" +
        (pl === "instagram" ? "<p>اینستاگرام از سرور گیت‌هاب گاهی مسدود است. برای آمار کامل، توکن Instagram Graph API را به‌عنوان Secret مخزن (IG_ACCESS_TOKEN و IG_USER_ID) اضافه کن.</p>" : "") +
        (r.error ? '<p class="err" dir="ltr">' + esc(r.error) + "</p>" : "") + "</div>";
      if (isYt) html += '<section class="card ytinbox" id="yt-inbox" data-page="' + esc(pid) + '"></section>';
      app.innerHTML = html;
      window.scrollTo(0, 0); bindTopbar();
      document.getElementById("back").onclick = function () { location.hash = "#/channels"; };
      if (isYt) { renderInbox(pid); bindInbox(pid); loadYt(); }
      return;
    }
    var pref = viewPref();
    html += '<div class="gfilter" id="gfilter"><span class="gl">بازه‌ی زمانی همه‌ی این صفحه:</span><div class="seg range" role="group" aria-label="بازه‌ی زمانی">' + RANGES.map(function (x) {
      return '<button type="button" data-r="' + x.id + '" class="' + (x.id === pref.r ? "on" : "") + '" aria-pressed="' + (x.id === pref.r) + '">' + x.short + "</button>";
    }).join("") + "</div></div>";
    if (r.stale) html += '<div class="alert">آخرین تلاش برای خواندن ' + esc(PNAME[pl]) + " ناموفق بود؛ عددهای فعلی مربوط به " + esc(fmtDateTime(r.fetched_at)) + " هستند.</div>";
    html += '<div id="abody"></div>';
    if (isYt) html += '<section class="card ytinbox" id="yt-inbox" data-page="' + esc(pid) + '"></section>';
    html += '<p class="footnote">همه‌ی عددهای «تازه» از مقایسه‌ی اندازه‌گیری‌های واقعیِ ثبت‌شده به دست می‌آیند (حدود هر ۳۰ تا ۶۰ دقیقه، تا ۹۰ روز) و حدس زده نمی‌شوند. «—» یعنی آن عدد را خود پلتفرم نمی‌دهد. عدد منفی یعنی خود پلتفرم شمارش را اصلاح کرده. ساعت‌ها به وقت تهران است.</p>';
    app.innerHTML = html;
    window.scrollTo(0, 0);
    bindTopbar();
    document.getElementById("back").onclick = function () { location.hash = "#/channels"; };

    var ph = loadPH(pid, pl);
    var hasPostLists = ph && ph.posts.length;
    var A = { ph: ph, noPosts: null };
    if (!hasPostLists && r.posts === 0 && pl !== "tiktok") A.noPosts = "هنوز " + POSTS_LABEL[pl] + "ی در این کانال منتشر نشده.";
    else if (!hasPostLists && (pl === "tiktok" || !(r.recent || []).length && r.posts > 0)) A.noPosts = NO_POSTS_MSG[pl] || ("فهرست " + POSTS_LABEL[pl] + "‌های " + PNAME[pl] + " در دسترس نیست؛ آمار تک‌تک " + POSTS_LABEL[pl] + "‌ها نداریم.");
    var series = seriesOf(pid, pl);
    function draw() {
      var now = nowArg || Date.now(), rg = rangeById(pref.r);
      A.W = computeWindow(ph, rg, now);
      var b = '<div class="kpis three">' +
        kpi(FOLLOW_LABEL[pl], fa(r.followers)) +
        kpi("کل " + POSTS_LABEL[pl] + "‌ها", fa(r.posts)) +
        kpi(pl === "tiktok" ? "کل لایک‌ها" : "کل بازدیدها", fa(pl === "tiktok" ? r.total_likes : r.total_views), "", (pl === "tiktok" ? r.total_likes : r.total_views) == null ? NO_ACCESS : "") + "</div>";
      b += summaryHTML(A, pl, rg, A.W, channelTotalHTML(series, pl, r, rg, now));
      if (!A.noPosts) { // without per-post data the summary already says so; no empty chart/list boxes
        b += trendHTML(A, pl, rg, pref, now);
        b += "<h3 id=\"plist-h\">" + esc(POSTS_LABEL[pl] + "‌ها در " + rg.label + " — به ترتیب " + KNAME[A.W.sortKey] + " تازه") + "</h3>";
        b += postsHTML(A, pl);
      }
      b += followersHTML(series, pl, rg, pref, now);
      document.getElementById("abody").innerHTML = b;
      var gf = document.getElementById("gfilter");
      Array.prototype.forEach.call(gf.querySelectorAll("button[data-r]"), function (x) { var on = x.getAttribute("data-r") === pref.r; x.className = on ? "on" : ""; x.setAttribute("aria-pressed", on); });
    }
    draw();
    if (isYt) { renderInbox(pid); bindInbox(pid); loadYt(); }
    document.getElementById("gfilter").onclick = function (e) {
      var bt = e.target.closest ? e.target.closest("button[data-r]") : null; if (!bt) return;
      pref.r = bt.getAttribute("data-r"); saveViewPref(pref); draw();
    };
    document.getElementById("abody").onclick = function (e) {
      var bt = e.target.closest ? e.target.closest("button") : null; if (!bt) return;
      if (bt.hasAttribute("data-type")) pref.type = bt.getAttribute("data-type");
      else if (bt.hasAttribute("data-m")) pref.m = bt.getAttribute("data-m");
      else return;
      saveViewPref(pref); draw();
    };
  }

  // ------------------------------------------------------------- encrypted token sync
  // The token is encrypted in this browser (PBKDF2-SHA256 310k -> AES-GCM-256) with the panel login password
  // and committed as ciphertext to config/token.enc.json. The password itself lives only in memory/sessionStorage.
  var ENC_PATH = "config/token.enc.json", PW_KEY = "sp_pw", USER_KEY = "sp_user", TOKSRC_KEY = "sp_tok_src";
  var KDF_ITER = 310000;
  var memPw = "";
  function sessPw() { if (memPw) return memPw; try { return sessionStorage.getItem(PW_KEY) || ""; } catch (e) { return ""; } }
  function setSessPw(u, p) {
    memPw = p || "";
    try {
      if (p) { sessionStorage.setItem(PW_KEY, p); sessionStorage.setItem(USER_KEY, u || ""); }
      else { sessionStorage.removeItem(PW_KEY); sessionStorage.removeItem(USER_KEY); }
    } catch (e) {}
  }
  function tokSrc() { try { return localStorage.getItem(TOKSRC_KEY) || ""; } catch (e) { return ""; } }
  function setTokSrc(v) { try { if (v) localStorage.setItem(TOKSRC_KEY, v); else localStorage.removeItem(TOKSRC_KEY); } catch (e) {} }
  function u8b64(u8) { var s = ""; for (var i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return btoa(s); }
  function b64u8(s) { var b = atob(s), u = new Uint8Array(b.length); for (var i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; }
  function deriveKey(pw, salt) {
    return crypto.subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveKey"]).then(function (base) {
      return crypto.subtle.deriveKey({ name: "PBKDF2", salt: salt, iterations: KDF_ITER, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    });
  }
  function encryptToken(tok, pw) {
    var salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
    return deriveKey(pw, salt).then(function (key) {
      return crypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, key, new TextEncoder().encode(tok));
    }).then(function (ct) {
      return { v: 1, salt: u8b64(salt), iv: u8b64(iv), ct: u8b64(new Uint8Array(ct)), created_at: new Date().toISOString() };
    });
  }
  function decryptToken(obj, pw) {
    if (!obj || obj.v !== 1) return Promise.reject(new Error("unsupported"));
    return deriveKey(pw, b64u8(obj.salt)).then(function (key) {
      return crypto.subtle.decrypt({ name: "AES-GCM", iv: b64u8(obj.iv) }, key, b64u8(obj.ct));
    }).then(function (pt) { return new TextDecoder().decode(pt); });
  }
  // the encrypted file, read without a token (public repo). Resolves null when it does not exist.
  function fetchEnc() {
    var api = "https://api.github.com/repos/" + GH_OWNER + "/" + GH_REPO + "/contents/" + ENC_PATH + "?ref=" + GH_BRANCH + "&t=" + Date.now();
    var raw = "https://raw.githubusercontent.com/" + GH_OWNER + "/" + GH_REPO + "/" + GH_BRANCH + "/" + ENC_PATH + "?t=" + Date.now();
    function get(url, hdr) {
      return fetch(url, { cache: "no-store", headers: hdr || {} }).then(function (r) {
        if (r.status === 404) return null;
        if (!r.ok) { var e = new Error("HTTP " + r.status); e.status = r.status; throw e; }
        return r.json();
      });
    }
    return get(api, { Accept: "application/vnd.github.raw+json" }).catch(function () { return get(raw); });
  }
  // pull the synced token into this device (no-op when one is already here and is the current synced copy)
  function pullToken(pw, opts) {
    opts = opts || {};
    return fetchEnc().then(function (obj) {
      state.syncAvailable = !!obj; state.encCreated = obj ? obj.created_at : null;
      if (!obj) return { pulled: false, exists: false };
      if (getToken() && !(opts.force || (tokSrc() && tokSrc() !== obj.created_at))) return { pulled: false, exists: true };
      if (!pw) return { pulled: false, exists: true, needPw: true };
      return decryptToken(obj, pw).then(function (tok) {
        if (!/^(github_pat_|ghp_|gho_)/.test(tok)) throw new Error("bad");
        setToken(tok); setTokSrc(obj.created_at);
        try { sessionStorage.removeItem(UNLOCK_LATER); } catch (e) {}
        return { pulled: true, exists: true };
      }, function () { return { pulled: false, exists: true, badPw: true }; });
    });
  }
  // ONE place that says whether this device can talk to GitHub. Every page reads it from here.
  //  connected : a token is stored on this device
  //  locked    : no token here, but an encrypted copy is synced in the repo -> ask for the panel password once
  //  none      : nothing anywhere
  function tokenState() {
    var t = getToken();
    if (t) return { state: "connected", has: true, locked: false, label: "توکن ثبت شده" };
    if (state.syncAvailable) return { state: "locked", has: false, locked: true, label: "اتصال منتظر رمز پنل" };
    return { state: "none", has: false, locked: false, label: "توکن ثبت نشده" };
  }
  // decrypt the synced copy with the panel password; resolves {ok} or {ok:false, msg}
  function unlockWith(pw) {
    if (!pw) return Promise.resolve({ ok: false, msg: "رمز پنل را وارد کن." });
    return pullToken(pw, { force: true }).then(function (r) {
      if (r.pulled) { setSessPw(sessUser(), pw); return { ok: true }; }
      if (r.badPw) return { ok: false, msg: "این رمز درست نیست (همان رمزی که با آن وارد پنل می‌شوی)." };
      if (!r.exists) return { ok: false, msg: "نسخه‌ی همگام‌شده‌ی توکن در مخزن پیدا نشد؛ توکن را در تنظیمات بگذار." };
      return { ok: false, msg: "باز کردن توکن ممکن نشد." };
    }, function (e) { return { ok: false, msg: "اتصال به گیت‌هاب برقرار نشد (" + ((e && e.message) || "خطا") + "). اینترنت را بررسی کن و دوباره بزن." }; });
  }
  function sessUser() { try { return sessionStorage.getItem(USER_KEY) || ""; } catch (e) { return ""; } }
  function unlockFormHTML(pfx) {
    return '<form class="unlock-form" id="' + pfx + '-form" autocomplete="on" onsubmit="return false">' +
      '<input type="text" name="username" autocomplete="username" value="" hidden aria-hidden="true">' +
      '<label for="' + pfx + '-pw">رمز پنل</label><div class="pw"><input id="' + pfx + '-pw" name="password" type="password" autocomplete="current-password" required></div>' +
      '<button type="submit" class="go" id="' + pfx + '-go">فعال‌سازی اتصال</button>' +
      '<div class="msg" id="' + pfx + '-msg" data-state="idle"></div></form>';
  }
  function bindUnlockForm(pfx, done) {
    var f = document.getElementById(pfx + "-form"); if (!f) return;
    var busy = false;
    f.onsubmit = function (e) {
      if (e) e.preventDefault();
      if (busy) return false;
      var pwI = document.getElementById(pfx + "-pw"), m = document.getElementById(pfx + "-msg"), go = document.getElementById(pfx + "-go");
      busy = true; go.disabled = true; m.textContent = "در حال باز کردن…"; m.setAttribute("data-state", "busy");
      unlockWith(pwI.value).then(function (res) {
        busy = false; go.disabled = false;
        if (res.ok) { m.textContent = "✓ اتصال فعال شد"; m.setAttribute("data-state", "ok"); done(); }
        else { m.textContent = "✗ " + res.msg; m.setAttribute("data-state", "error"); pwI.select && pwI.select(); }
      });
      return false;
    };
  }
  var UNLOCK_LATER = "sp_unlock_later";
  function closeUnlock() { var m = document.getElementById("unlock-modal"); if (m) m.remove(); document.documentElement.classList.remove("modal-open"); }
  // shown over ANY page while a synced token waits for the password (inline on #/publish and #/settings instead)
  function ensureUnlockUI() {
    var ts = tokenState(), inline = onFormPage();
    var later = false; try { later = sessionStorage.getItem(UNLOCK_LATER) === "1"; } catch (e) {}
    if (!authed() || !ts.locked || inline || later) { closeUnlock(); return; }
    if (document.getElementById("unlock-modal")) return;
    var d = document.createElement("div");
    d.id = "unlock-modal"; d.className = "modal"; d.setAttribute("role", "dialog"); d.setAttribute("aria-modal", "true"); d.setAttribute("aria-labelledby", "unlock-title");
    d.innerHTML = '<div class="modal-card"><div class="vi">' + ICON_LOCK + '</div><h2 id="unlock-title">اتصال به گیت‌هاب</h2>' +
      "<p>برای فعال‌سازی اتصال، رمز پنل را یک بار وارد کن. توکنی که روی دستگاه دیگری همگام شده با همین رمز باز می‌شود و روی این دستگاه می‌ماند.</p>" +
      unlockFormHTML("unlock") + '<button type="button" class="ghost later" id="unlock-later">بعداً</button></div>';
    document.body.appendChild(d);
    document.documentElement.classList.add("modal-open");
    bindUnlockForm("unlock", function () { setTimeout(function () { closeUnlock(); toast("اتصال فعال شد ✓ — انتشار و به‌روزرسانی آماده است"); render(); }, 500); });
    document.getElementById("unlock-later").onclick = function () { try { sessionStorage.setItem(UNLOCK_LATER, "1"); } catch (e) {} closeUnlock(); };
    setTimeout(function () { var i = document.getElementById("unlock-pw"); if (i && document.activeElement === document.body) try { i.focus({ preventScroll: true }); } catch (e) {} }, 50);
  }
  // on app start: pick up a token synced from another device, or drop a synced token that was removed everywhere.
  // Never re-renders the channel list (rows must not move under a finger); the modal is an overlay.
  function syncOnStart() {
    if (!authed()) return Promise.resolve();
    var had = getToken(), src = tokSrc();
    return fetchEnc().then(function (obj) {
      state.syncAvailable = !!obj; state.encCreated = obj ? obj.created_at : null;
      if (!obj) {
        if (had && src) { setToken(""); setTokSrc(""); toast("توکن از همه‌ی دستگاه‌ها حذف شده بود؛ از این دستگاه هم پاک شد", 4500); refreshTokenUI(); }
        return;
      }
      if (had && (!src || src === obj.created_at)) return;
      var pw = sessPw();
      if (pw) return pullToken(pw).then(function (r) { if (r.pulled) { toast("توکن همگام شد"); refreshTokenUI(); } else if (!getToken()) refreshTokenUI(); });
      if (had) return; // a newer synced copy exists, but this device still has a working token: keep it
      refreshTokenUI();
    }).catch(function () {});
  }
  // update only what depends on the token (never rebuilds the channel tree)
  function refreshTokenUI() {
    var h = location.hash || "#/";
    if (/^#\/(publish|settings)/.test(h) || h === "#/" || h === "#") render(); else ensureUnlockUI();
  }
  function credsOk(u, p) { return sha256hex(AUTH_SALT + u + "|" + p).then(function (h) { return h === AUTH_HASH; }); }
  // password for encryption: from this session's login, or typed into the settings form (checked against the login hash)
  function pwFromForm() {
    var pw = sessPw();
    if (pw) return Promise.resolve(pw);
    var ue = document.getElementById("sync-user"), pe = document.getElementById("sync-pw");
    var u = ue ? ue.value.trim() : "", p = pe ? pe.value : "";
    if (!u || !p) return Promise.reject(new Error("برای رمزگذاری، نام کاربری و رمز ورود پنل را وارد کن."));
    return credsOk(u, p).then(function (ok) {
      if (!ok) throw new Error("نام کاربری یا رمز ورود پنل اشتباه است.");
      setSessPw(u, p); return p;
    });
  }
  function encSha() {
    return gh("/contents/" + ENC_PATH + "?ref=" + GH_BRANCH + "&t=" + Date.now()).then(function (f) { return f && f.sha; }, function (e) { if (e.status === 404) return null; throw e; });
  }
  function validateToken() { return gh("?t=" + Date.now()); } // GET /repos/negin1100mohammadi/social-panel

  // ------------------------------------------------------------- settings
  function settingsView() {
    var tok = getToken(), havePw = !!sessPw(), ts = tokenState();
    var html = topbar("تنظیمات");
    html += '<button class="back" id="back">→ صفحه‌ی اصلی</button>';
    if (ts.locked) html += '<section class="card form unlock-card" id="unlock-card"><h2>اتصال فعال نیست</h2><p class="help">یک توکن روی دستگاه دیگری همگام شده است. برای فعال‌سازی اتصال، رمز پنل را یک بار وارد کن.</p>' + unlockFormHTML("sunlock") + "</section>";
    html += '<section class="card form" id="token-card">' +
      "<h2>توکن گیت‌هاب</h2>" +
      '<div class="tok-status ' + (tok ? "" : "bad") + '" id="token-status" data-state="' + (tok ? "checking" : "none") + '">' + (tok ? "در حال بررسی اتصال…" : "✗ متصل نیست") + "</div>" +
      '<p class="help">با این توکن، دکمه‌ی به‌روزرسانی بالای صفحه همان لحظه آمار و <b>عکس‌های پروفایل</b> همه‌ی کانال‌ها را از نو می‌خواند، و بخش «انتشار محتوا» فایل‌ها را در صف انتشار می‌گذارد. توکن در مرورگر همین دستگاه (localStorage) ذخیره می‌شود؛ با «همگام‌سازی با همه دستگاه‌ها» نسخه‌ی <b>رمزگذاری‌شده</b> با رمز ورود پنل در مخزن قرار می‌گیرد تا دستگاه‌های دیگر هنگام ورود آن را بگیرند.</p>' +
      '<ol class="steps"><li>در گیت‌هاب به <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">Fine-grained personal access token ↗</a> برو.</li>' +
      "<li>یک نام و تاریخ انقضا بگذار. در <b>Repository access</b> گزینه‌ی <b>Only select repositories</b> و فقط <b dir=\"ltr\">social-panel</b> را انتخاب کن.</li>" +
      "<li>در <b>Permissions → Repository permissions</b>: <b dir=\"ltr\">Actions: Read and write</b> و <b dir=\"ltr\">Contents: Read and write</b> (Metadata خودکار Read می‌شود).</li>" +
      "<li>توکن ساخته‌شده (با <span dir=\"ltr\">github_pat_</span> شروع می‌شود) را کپی کن و این‌جا بچسبان.</li></ol>" +
      '<label for="gh-token">توکن</label><div class="pw"><input id="gh-token" name="gh-token" type="password" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="github_pat_…" value="' + esc(tok) + '">' +
      '<button type="button" class="show" id="showtok">' + ICON_EYE + "<span>نمایش</span></button></div>" +
      '<div class="row-btns"><button type="button" class="go" id="savetok">ذخیره</button><button type="button" class="ghost" id="testtok"' + (tok ? "" : " disabled") + '>آزمایش توکن</button>' +
      (tok ? '<button type="button" class="ghost danger" id="deltok">حذف توکن</button>' : "") + "</div>" +
      '<div class="msg" id="tokmsg">' + (tok ? "توکن روی این دستگاه ثبت شده است." : "توکنی ثبت نشده؛ دکمه‌ی به‌روزرسانی فقط آخرین داده‌های ذخیره‌شده را دوباره بارگذاری می‌کند.") + "</div>" +
      '<div class="sync-box" id="sync-box"><h3>همگام‌سازی بین دستگاه‌ها</h3>' +
      (havePw ? "" : '<p class="help">برای رمزگذاری یا باز کردن توکن همگام‌شده، نام کاربری و رمز ورود پنل را وارد کن (فقط تا بسته شدن این برگه در حافظه می‌ماند).</p>' +
        '<label for="sync-user">نام کاربری پنل</label><input id="sync-user" name="sync-user" type="text" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false">' +
        '<label for="sync-pw">رمز ورود پنل</label><input id="sync-pw" name="sync-pw" type="password" autocomplete="current-password">') +
      '<div class="row-btns"><button type="button" class="go" id="sync-token">همگام‌سازی با همه دستگاه‌ها</button>' +
      (!tok && state.syncAvailable ? '<button type="button" class="ghost" id="pull-token">دریافت توکن همگام‌شده</button>' : "") +
      '<button type="button" class="ghost danger" id="del-token-all">حذف توکن از همه دستگاه‌ها</button></div>' +
      '<div class="msg" id="sync-msg" data-state="idle">' + (state.syncAvailable ? "یک نسخه‌ی رمزگذاری‌شده‌ی توکن در مخزن هست." : "") + "</div></div></section>";
    html += ytAccountsSectionHTML();
    html += '<p class="footnote" id="app-version">نسخه‌ی پنل: ' + SP_VERSION + "</p>";
    app.innerHTML = html;
    bindTopbar();
    document.getElementById("back").onclick = function () { location.hash = "#/"; };
    var ti = document.getElementById("gh-token"), sb = document.getElementById("showtok"), msg = document.getElementById("tokmsg"), smsg = document.getElementById("sync-msg");
    function say(t, st) { smsg.textContent = t; smsg.setAttribute("data-state", st || "idle"); }
    sb.onclick = function () { var s = ti.type === "text"; ti.type = s ? "password" : "text"; sb.innerHTML = (s ? ICON_EYE : ICON_EYE_OFF) + "<span>" + (s ? "نمایش" : "پنهان") + "</span>"; };
    document.getElementById("savetok").onclick = function () {
      var v = ti.value.trim();
      if (!v) { msg.textContent = "اول توکن را بچسبان."; return; }
      if (!/^(github_pat_|ghp_|gho_)/.test(v)) { msg.textContent = "این شبیه توکن گیت‌هاب نیست (باید با github_pat_ شروع شود)."; return; }
      if (v !== getToken()) setTokSrc("");
      setToken(v); settingsView(); testToken();
    };
    var tt = document.getElementById("testtok"); if (tt) tt.onclick = testToken;
    var dt = document.getElementById("deltok"); if (dt) dt.onclick = function () { setToken(""); setTokSrc(""); settingsView(); toast("توکن از این دستگاه حذف شد"); };
    var busy = false;
    document.getElementById("sync-token").onclick = function () {
      if (busy) return;
      var v = (ti.value || "").trim() || getToken();
      if (!v) { say("اول توکن را در کادر بالا بچسبان.", "error"); return; }
      if (!/^(github_pat_|ghp_|gho_)/.test(v)) { say("این شبیه توکن گیت‌هاب نیست (باید با github_pat_ شروع شود).", "error"); return; }
      busy = true; say("در حال بررسی رمز…", "busy");
      var prev = getToken(), prevSrc = tokSrc(), pwv;
      pwFromForm().then(function (pw) {
        pwv = pw; setToken(v); say("در حال بررسی توکن…", "busy");
        return validateToken();
      }).then(function (repo) {
        if (!(repo && repo.permissions && repo.permissions.push)) { var e = new Error("این توکن اجازه‌ی نوشتن (Contents: Read and write) روی social-panel را ندارد."); throw e; }
        say("در حال رمزگذاری…", "busy");
        return encryptToken(v, pwv);
      }).then(function (obj) {
        say("در حال ذخیره در مخزن…", "busy");
        return encSha().then(function (sha) {
          var body = { message: "config: encrypted token for device sync", content: b64utf8(JSON.stringify(obj, null, 1) + "\n"), branch: GH_BRANCH };
          if (sha) body.sha = sha;
          return gh("/contents/" + ENC_PATH, { method: "PUT", body: body });
        }).then(function () { return obj; });
      }).then(function (obj) {
        setTokSrc(obj.created_at); state.syncAvailable = true; busy = false;
        settingsView();
        var m = document.getElementById("sync-msg");
        m.textContent = "✓ همگام شد. هر دستگاه دیگر هنگام ورود به پنل (یا باز کردن آن) توکن را خودش می‌گیرد."; m.setAttribute("data-state", "ok");
        testToken();
      }).catch(function (e) {
        busy = false;
        if (getToken() === v && v !== prev) { setToken(prev); setTokSrc(prevSrc); }
        say("✗ " + (e && e.status ? ghErrorFa(e) : (e && e.message) || "همگام‌سازی ممکن نشد"), "error");
      });
    };
    var pt = document.getElementById("pull-token");
    if (pt) pt.onclick = function () {
      say("در حال دریافت…", "busy");
      pwFromForm().then(function (pw) { return pullToken(pw, { force: true }); }).then(function (r) {
        if (r.pulled) { settingsView(); toast("توکن همگام شد"); testToken(); }
        else say(r.badPw ? "✗ با این رمز باز نشد (توکن با رمز دیگری رمزگذاری شده)." : r.exists ? "✗ دریافت ممکن نشد." : "نسخه‌ی همگام‌شده‌ای در مخزن نیست.", "error");
      }).catch(function (e) { say("✗ " + ((e && e.message) || "دریافت ممکن نشد"), "error"); });
    };
    var armed = false;
    document.getElementById("del-token-all").onclick = function () {
      var b = this;
      if (!getToken()) { say("برای حذف فایل همگام‌سازی از مخزن، توکن لازم است.", "error"); return; }
      if (!armed) { armed = true; b.textContent = "مطمئنی؟ دوباره بزن"; setTimeout(function () { armed = false; if (b.isConnected) b.textContent = "حذف توکن از همه دستگاه‌ها"; }, 5000); return; }
      armed = false; say("در حال حذف…", "busy");
      encSha().then(function (sha) {
        if (!sha) return null;
        return gh("/contents/" + ENC_PATH, { method: "DELETE", body: { message: "config: remove synced token", sha: sha, branch: GH_BRANCH } });
      }).then(function () {
        setToken(""); setTokSrc(""); state.syncAvailable = false; settingsView();
        var m = document.getElementById("sync-msg");
        m.textContent = "✓ نسخه‌ی همگام‌شده حذف شد و توکن از این دستگاه پاک شد. دستگاه‌های دیگر دفعه‌ی بعد که پنل را باز کنند آن را پاک می‌کنند. برای باطل کردن کامل، توکن را در گیت‌هاب هم حذف کن."; m.setAttribute("data-state", "ok");
      }).catch(function (e) { say("✗ " + ghErrorFa(e), "error"); });
    };
    bindUnlockForm("sunlock", function () { setTimeout(function () { settingsView(); toast("اتصال فعال شد ✓"); }, 400); });
    loadYt();
    if (tok) testToken();
  }
  function testToken() {
    var msg = document.getElementById("tokmsg"), st = document.getElementById("token-status");
    if (msg) msg.textContent = "در حال آزمایش…";
    function status(ok, text) { if (!st) return; st.className = "tok-status " + (ok ? "ok" : "bad"); st.setAttribute("data-state", ok ? "connected" : "invalid"); st.textContent = text; }
    Promise.all([validateToken(), gh("/actions/workflows").catch(function (e) { return { _err: e }; })]).then(function (res) {
      var repo = res[0], wf = res[1], parts = [];
      var push = !!(repo.permissions && repo.permissions.push);
      parts.push(push ? "✓ دسترسی Contents (نوشتن) دارد" : "✗ دسترسی نوشتن Contents ندارد");
      parts.push(wf && !wf._err ? "✓ دسترسی Actions دارد" : "✗ دسترسی Actions ندارد");
      status(true, push ? "✓ متصل" : "✓ متصل (فقط خواندن)");
      if (msg) msg.textContent = parts.join(" · ");
    }).catch(function (e) { status(false, "✗ متصل نیست"); if (msg) msg.textContent = "✗ " + ghErrorFa(e); });
  }

  // ------------------------------------------------------------- YouTube: official account connection (OAuth)
  // "اتصال" sends the browser to Google's consent page (authorization-code flow, offline access). Google returns to
  // oauth.html, which hands the one-time code to the yt-connect.yml workflow with this device's GitHub token. The
  // workflow exchanges it with the client secret (a repo secret) and commits the refresh token AES-GCM-encrypted
  // with TOKEN_KEY to config/yt_tokens.enc.json. Nothing secret ever exists in this browser except the GitHub token.
  var YT_STORE_PATH = "config/yt_tokens.enc.json", YT_REPLIES_PATH = "config/yt_replies.json";
  var OAUTH_STATE_KEY = "sp_oauth_state", YT_PENDING_KEY = "sp_yt_pending";
  var YT_SCOPES_DEFAULT = ["https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/youtube.force-ssl",
    "https://www.googleapis.com/auth/youtube.readonly", "https://www.googleapis.com/auth/yt-analytics.readonly"];
  state.yt = { store: null, replies: null, loadedAt: 0, loading: null };
  function ytConf() {
    var c = (state.config && state.config.youtube_oauth) || {};
    return { client_id: c.client_id || "", redirect_uri: c.redirect_uri || "https://negin1100mohammadi.github.io/social-panel/oauth.html",
      scopes: c.scopes && c.scopes.length ? c.scopes : YT_SCOPES_DEFAULT };
  }
  function randHex(n) { var a = crypto.getRandomValues(new Uint8Array(n)); return Array.prototype.map.call(a, function (x) { return ("0" + x.toString(16)).slice(-2); }).join(""); }
  function oauthURL(page, nonce) {
    var c = ytConf();
    var q = { client_id: c.client_id, redirect_uri: c.redirect_uri, response_type: "code", scope: c.scopes.join(" "),
      access_type: "offline", prompt: "consent select_account", include_granted_scopes: "true", state: page + "." + nonce };
    return "https://accounts.google.com/o/oauth2/v2/auth?" + Object.keys(q).map(function (k) { return k + "=" + encodeURIComponent(q[k]); }).join("&");
  }
  function startYtConnect(page, st) {
    var cp = cpById(page); if (!cp || !(cp.accounts || {}).youtube) return;
    var ts = tokenState();
    if (!ts.has) {
      if (ts.locked) { try { sessionStorage.removeItem(UNLOCK_LATER); } catch (e) {} toast("برای اتصال یوتیوب، اول اتصال گیت‌هاب را با رمز پنل فعال کن.", 4500); ensureUnlockUI(); }
      else { toast("برای اتصال یوتیوب، اول توکن گیت‌هاب را در تنظیمات بگذار.", 4500); location.hash = "#/settings"; }
      return;
    }
    var c = ytConf();
    if (!c.client_id) { toast("شناسه‌ی OAuth گوگل در config.json تنظیم نشده."); return; }
    if (st === "ok" && !window.confirm("یوتیوب " + cp.name + " متصل است. دوباره وصل شود؟")) return;
    var nonce = randHex(16), saved = JSON.stringify({ nonce: nonce, page: page, ret: location.hash || "#/channels", at: Date.now() });
    try { sessionStorage.setItem(OAUTH_STATE_KEY, saved); } catch (e) {}
    // copy for an installed (home-screen) app, where Google may return in a browser tab with its own sessionStorage;
    // oauth.html deletes both copies on first use and refuses anything older than 30 minutes
    try { localStorage.setItem(OAUTH_STATE_KEY, saved); } catch (e) {}
    var url = oauthURL(page, nonce);
    if (window.__spNoNavigate) { window.__spLastOAuth = url; return; }
    location.assign(url);
  }
  // read a file of the repo (public) — with the token when there is one (fresh, 5000 req/h), else unauthenticated
  function fetchRepoJSON(path) {
    var api = "https://api.github.com/repos/" + GH_OWNER + "/" + GH_REPO + "/contents/" + path + "?ref=" + GH_BRANCH + "&t=" + Date.now();
    var raw = "https://raw.githubusercontent.com/" + GH_OWNER + "/" + GH_REPO + "/" + GH_BRANCH + "/" + path + "?t=" + Date.now();
    function get(url, hdr) {
      return fetch(url, { cache: "no-store", headers: hdr || {} }).then(function (r) {
        if (r.status === 404) return null;
        if (!r.ok) { var e = new Error("HTTP " + r.status); e.status = r.status; throw e; }
        return r.json();
      });
    }
    var h = { Accept: "application/vnd.github.raw+json" };
    var tok = getToken(); if (tok) h.Authorization = "Bearer " + tok;
    return get(api, h).catch(function () { return get(raw); });
  }
  var ERR = {};
  function loadYt(force) {
    if (state.yt.loading) return state.yt.loading;
    if (!force && Date.now() - state.yt.loadedAt < 30000) return Promise.resolve();
    state.yt.loading = Promise.all([
      fetchRepoJSON(YT_STORE_PATH).catch(function () { return ERR; }),
      fetchRepoJSON(YT_REPLIES_PATH).catch(function () { return ERR; })
    ]).then(function (res) {
      // null = the file does not exist yet (nothing connected); ERR = could not read it (keep what we had)
      state.yt.err = res[0] === ERR;
      if (res[0] !== ERR) state.yt.store = res[0] || { channels: {} };
      if (res[1] !== ERR) state.yt.replies = res[1] || { items: [] };
      if (!state.yt.err) state.yt.loadedAt = Date.now();
      state.yt.loading = null;
      updateYtUI();
    }, function () { state.yt.loading = null; });
    return state.yt.loading;
  }
  function ytEntries(pid) {
    var ch = (state.yt.store && state.yt.store.channels) || {};
    return Object.keys(ch).map(function (k) { return ch[k]; }).filter(function (e) { return e && e.page === pid; })
      .sort(function (a, b) { return (a.mismatch ? 1 : 0) - (b.mismatch ? 1 : 0) || (tsOf(b.connected_at) || 0) - (tsOf(a.connected_at) || 0); });
  }
  // one status per page: none | ok | mismatch | revoked | error | unknown (store not loaded yet)
  function ytStatus(pid) {
    if (!state.yt.store) return { st: "unknown", label: state.yt.err ? "وضعیت خوانده نشد" : "…", btn: "اتصال" };
    var es = ytEntries(pid), e = es[0];
    if (!e) return { st: "none", label: "متصل نیست", btn: "اتصال" };
    var cp = cpById(pid), r = cp ? (pageData(cp).platforms.youtube || {}) : {}, o = r.oauth || null;
    if (e.mismatch) return { st: "mismatch", label: "کانال دیگری متصل شده", btn: "اتصال دوباره", e: e };
    if (o && o.channel_id === e.channel_id && o.status === "revoked" && tsOf(o.at) > tsOf(e.connected_at)) return { st: "revoked", label: "دسترسی لغو شده", btn: "اتصال دوباره", e: e };
    if (o && o.channel_id === e.channel_id && o.status === "error" && tsOf(o.at) > tsOf(e.connected_at)) return { st: "error", label: "خطا در خواندن API", btn: "اتصال", e: e, msg: o.error };
    return { st: "ok", label: "متصل", btn: "متصل ✓", e: e };
  }
  var YT_PILL = { ok: "good", mismatch: "warn", revoked: "bad", error: "warn", none: "", unknown: "" };
  function ytBtnHTML(pid, cls) {
    var s = ytStatus(pid);
    return '<button type="button" class="' + (cls || "bbtn ytc") + '" data-ytc="' + esc(pid) + '" data-st="' + s.st + '" title="اتصال رسمی حساب یوتیوب (Google)">' + esc(s.btn) + "</button>";
  }
  function ytConnCardHTML(pid) {
    var s = ytStatus(pid), e = s.e, h = '<div class="ytc-head"><b>اتصال رسمی یوتیوب</b><span class="pill ' + (YT_PILL[s.st] || "") + '" data-yst="' + s.st + '">' + esc(s.label) + "</span></div>";
    if (e) {
      h += '<div class="ytc-ch"><span dir="ltr">' + esc(e.title || e.channel_id) + "</span>" + (e.handle ? ' <small dir="ltr">' + esc(e.handle) + "</small>" : "") +
        '<small> · وصل‌شده ' + esc(fmtDateTime(e.connected_at)) + "</small></div>";
      if (s.st === "mismatch") h += '<div class="alert">حسابی که تأیید شد (<span dir="ltr">' + esc(e.title || e.channel_id) + '</span>) کانال این پیج نیست' +
        (e.expected_channel_id ? ' (<span dir="ltr">' + esc(e.expected_channel_id) + "</span>)" : "") + ". آمار و انتشار از این حساب استفاده نمی‌کنند؛ «اتصال دوباره» را بزن و در صفحه‌ی گوگل کانال درست را انتخاب کن.</div>";
      if (s.st === "revoked") h += '<div class="alert bad">گوگل دسترسی پنل را نپذیرفت (لغو یا منقضی شده). «اتصال دوباره» را بزن.</div>';
      if (s.st === "error") h += '<div class="alert">آخرین خواندن از API ناموفق بود' + (s.msg ? ' (<span dir="ltr">' + esc(s.msg) + "</span>)" : "") + "؛ تا درست شود، آمار عمومی نشان داده می‌شود.</div>";
      if (s.st === "ok") h += '<p class="help">آمار دقیق (بازدید، لایک و کامنت هر ویدیو و مشترک‌ها) و کامنت‌ها از API رسمی یوتیوب خوانده می‌شود و انتشار ویدیو از صف انتشار با همین حساب انجام می‌شود.</p>';
    } else if (s.st === "none") {
      h += '<p class="help">با اتصال، آمار دقیق هر ویدیو، صندوق کامنت‌ها با امکان پاسخ، و انتشار مستقیم ویدیو فعال می‌شود. ورود در صفحه‌ی خود گوگل انجام می‌شود و رمز گوگل به پنل داده نمی‌شود.</p>';
    }
    return h + '<div class="row-btns">' + ytBtnHTML(pid, "go sm ytc-big") +
      (s.st === "ok" || s.st === "error" ? '<button type="button" class="ghost sm" data-jump="yt-inbox">صندوق کامنت‌ها ↓</button>' : "") + "</div>";
  }
  // in-place updates only (the channel tree never re-renders in the background)
  function updateYtUI() {
    Array.prototype.forEach.call(document.querySelectorAll("button[data-ytc]"), function (b) {
      var s = ytStatus(b.getAttribute("data-ytc")); b.textContent = s.btn; b.setAttribute("data-st", s.st);
    });
    var card = document.getElementById("yt-conn-card"); if (card) card.innerHTML = ytConnCardHTML(card.getAttribute("data-page"));
    var acc = document.getElementById("yt-accounts-list"); if (acc) acc.innerHTML = ytAccountsListHTML();
    var ib = document.getElementById("yt-inbox"); if (ib) renderInbox(ib.getAttribute("data-page"));
  }
  function ytAccountsListHTML() {
    var rows = state.config.pages.filter(function (cp) { return (cp.accounts || {}).youtube; }).map(function (cp) {
      var s = ytStatus(cp.id), e = s.e, page = pageData(cp);
      return '<div class="yacc" data-page="' + esc(cp.id) + '" data-yst="' + s.st + '">' + logoHTML(cp, page, "", "youtube") +
        '<div class="yacc-t"><b>' + esc(cp.name) + '</b><small dir="ltr">' + esc(e ? (e.title || e.channel_id) : cp.accounts.youtube) + "</small>" +
        '<span class="yacc-s"><span class="pill ' + (YT_PILL[s.st] || "") + '">' + esc(s.label) + "</span>" + (e ? "<small>وصل‌شده " + esc(ago(e.connected_at)) + "</small>" : "") + "</span></div>" +
        ytBtnHTML(cp.id, "bbtn ytc") + "</div>";
    }).join("");
    return rows || '<div class="muted-note">هیچ پیجی حساب یوتیوب ندارد.</div>';
  }
  function ytAccountsSectionHTML() {
    return '<section class="card form" id="yt-accounts"><h2>حساب‌های متصل</h2>' +
      '<p class="help">یوتیوب هر پیج را با دکمه‌ی «اتصال» به‌صورت رسمی وصل کن (مثل Zoho Social). ورود در صفحه‌ی گوگل انجام می‌شود؛ اگر گوگل نوشت «این برنامه تأیید نشده»، روی <b>Advanced</b> و بعد <b dir="ltr">Go to social-panel-app</b> بزن و همه‌ی دسترسی‌ها را تیک بزن. اگر کانال روی یک Brand Account است، در صفحه‌ی گوگل همان کانال را انتخاب کن.</p>' +
      '<div class="yacc-list" id="yt-accounts-list">' + ytAccountsListHTML() + "</div>" +
      '<p class="muted-note">توکن دائمی هر کانال فقط به‌صورت رمزگذاری‌شده (AES-GCM) در مخزن ذخیره می‌شود و فقط اجراهای گیت‌هاب می‌توانند بازش کنند. برای قطع کامل دسترسی: <a href="https://myaccount.google.com/permissions" target="_blank" rel="noopener">myaccount.google.com/permissions ↗</a></p></section>';
  }

  // ---- comments inbox (connected channels): data/comments.json + queued replies
  function pendingReplies() { var a = lsGet(YT_PENDING_KEY, []); return Array.isArray(a) ? a : []; }
  function savePending(a) { lsSet(YT_PENDING_KEY, a.filter(function (x) { return Date.now() - x.at < 3 * DAY; }).slice(-50)); }
  function replyResult(req) { var it = ((state.yt.replies && state.yt.replies.items) || []).filter(function (x) { return x.req === req; }); return it[it.length - 1] || null; }
  function threadsOf(pid) {
    var c = state.comments && state.comments.channels && state.comments.channels[pid + "/youtube"];
    var th = (c && c.threads) || [];
    return { meta: c || null, threads: th.slice().sort(function (a, b) { return (tsOf(b.published) || 0) - (tsOf(a.published) || 0); }) };
  }
  function renderInbox(pid) {
    var box = document.getElementById("yt-inbox"); if (!box) return;
    var s = ytStatus(pid);
    var drafts = {}; Array.prototype.forEach.call(box.querySelectorAll("textarea[data-thread]"), function (t) { if (t.value) drafts[t.getAttribute("data-thread")] = t.value; });
    var focused = document.activeElement && document.activeElement.getAttribute && document.activeElement.getAttribute("data-thread");
    var T = threadsOf(pid), h = '<h3>کامنت‌های یوتیوب' + (T.threads.length ? " <small>(" + fa(T.threads.length) + ")</small>" : "") + "</h3>";
    if (s.st === "unknown") { box.innerHTML = h + '<div class="muted-note">' + (state.yt.err ? "وضعیت اتصال از گیت‌هاب خوانده نشد؛ اینترنت را بررسی کن و صفحه را دوباره باز کن." : "در حال بررسی اتصال…") + "</div>"; return; }
    if (s.st === "none" || s.st === "mismatch") { box.innerHTML = h + '<div class="muted-note" id="inbox-empty" data-why="' + s.st + '">برای دیدن کامنت‌ها و پاسخ دادن، اول یوتیوب این پیج را (با کانال درست) متصل کن.</div>'; return; }
    if (T.meta) h += '<p class="muted-note">آخرین دریافت کامنت‌ها: ' + esc(fmtShort(T.meta.fetched_at)) + " (" + esc(ago(T.meta.fetched_at)) + ") · جدیدترین بالا · با دکمه‌ی به‌روزرسانی بالای صفحه دوباره خوانده می‌شود.</p>";
    if (!T.threads.length) { box.innerHTML = h + '<div class="muted-note" id="inbox-empty" data-why="nodata">' + (T.meta ? "هنوز کامنتی روی ویدیوهای این کانال نیست." : "کامنت‌ها با اولین به‌روزرسانی بعد از اتصال این‌جا می‌آیند.") + "</div>"; return; }
    var pend = pendingReplies().filter(function (x) { return x.page === pid; });
    h += '<div class="cmts">' + T.threads.map(function (t) {
      var known = {}; (t.replies || []).forEach(function (r) { known[r.id] = 1; });
      var reps = (t.replies || []).map(function (r) {
        return '<div class="crep"><b dir="auto">' + esc(r.author || "") + '</b> <small>' + esc(ago(r.published)) + '</small><p dir="auto">' + esc(r.text || "") + "</p></div>";
      });
      pend.filter(function (x) { return x.parent_id === t.id; }).forEach(function (x) {
        var res = replyResult(x.req);
        if (res && res.reply_id && known[res.reply_id]) return; // already in the comments read from YouTube
        var st = !res ? "queued" : res.status === "sent" ? "sent" : "failed";
        var lab = st === "queued" ? (Date.now() - x.at > 20 * 60000 ? "وضعیت نامشخص — صفحه را دوباره باز کن" : "در صف ارسال…") : st === "sent" ? "ارسال شد ✓" : "✗ " + (res.error_fa || "ارسال نشد");
        reps.push('<div class="crep mine ' + st + '" data-req="' + esc(x.req) + '" data-rst="' + st + '"><b>پاسخ تو</b> <small>' + esc(lab) + '</small><p dir="auto">' + esc(x.text) + "</p></div>");
      });
      var vt = t.video_title || t.video_id || "";
      return '<div class="cmt" data-thread="' + esc(t.id) + '">' +
        (t.avatar ? '<img class="cav" alt="" referrerpolicy="no-referrer" src="' + esc(t.avatar) + '" onerror="this.remove()">' : '<span class="cav"></span>') +
        '<div class="cbody"><div class="chd"><b dir="auto">' + esc(t.author || "") + '</b><small>' + esc(ago(t.published)) + "</small></div>" +
        '<p class="ctext" dir="auto">' + esc(t.text || "") + "</p>" +
        '<div class="cmeta">' + (t.likes ? "♥ " + fa(t.likes) + " · " : "") + (t.video_id ? '<a href="https://www.youtube.com/watch?v=' + encodeURIComponent(t.video_id) + "&lc=" + encodeURIComponent(t.comment_id || t.id) + '" target="_blank" rel="noopener" dir="auto">' + esc(vt) + " ↗</a>" : "") + "</div>" +
        (reps.length ? '<div class="creps">' + reps.join("") + "</div>" : "") +
        (t.can_reply === false ? '<div class="muted-note">پاسخ به این کامنت ممکن نیست.</div>' :
          '<form class="rform" data-thread="' + esc(t.id) + '" onsubmit="return false"><textarea data-thread="' + esc(t.id) + '" rows="1" maxlength="5000" placeholder="پاسخ به ' + esc(t.author || "این کامنت") + '…" dir="auto">' + esc(drafts[t.id] || "") + '</textarea><button type="submit" class="go sm">ارسال پاسخ</button></form>') +
        "</div></div>";
    }).join("") + "</div>";
    box.innerHTML = h;
    if (focused) { var ft = box.querySelector('textarea[data-thread="' + focused.replace(/"/g, "") + '"]'); if (ft) ft.focus(); }
  }
  function bindInbox(pid) {
    var box = document.getElementById("yt-inbox"); if (!box) return;
    box.onsubmit = function (e) {
      var f = e.target; if (!f.classList || !f.classList.contains("rform")) return;
      e.preventDefault();
      var ta = f.querySelector("textarea"), text = (ta.value || "").trim(), tid = f.getAttribute("data-thread");
      if (!text) { toast("متن پاسخ خالی است"); return; }
      sendReply(pid, tid, text, f);
    };
  }
  // find the run this browser started (run-name carries the request id), then wait for it to finish
  function waitRun(wf, req, say, maxMs) {
    var started = Date.now() - 60000, deadline = Date.now() + (maxMs || 10 * 60000), runId = null;
    function poll() {
      if (Date.now() > deadline) return Promise.resolve({ timeout: true });
      return sleep(runId ? 4000 : 3000).then(function () {
        var q = runId ? gh("/actions/runs/" + runId) : gh("/actions/workflows/" + wf + "/runs?event=workflow_dispatch&per_page=10").then(function (d) {
          return (d.workflow_runs || []).filter(function (x) { return String(x.display_title || x.name || "").indexOf(req) >= 0 && tsOf(x.created_at) >= started; })[0] || null;
        });
        return q.then(function (run) {
          if (!run) { if (say) say("queued"); return poll(); }
          runId = run.id;
          if (run.status === "completed") return { run: run };
          if (say) say(run.status === "in_progress" ? "running" : "queued");
          return poll();
        }, function () { return poll(); });
      });
    }
    return poll();
  }
  function sendReply(pid, parentId, text, form) {
    if (!tokenState().has) { toast(tokenState().locked ? "برای ارسال پاسخ، اول اتصال گیت‌هاب را با رمز پنل فعال کن." : "برای ارسال پاسخ، توکن گیت‌هاب را در تنظیمات بگذار.", 4500); ensureUnlockUI(); return; }
    var req = "r" + Date.now().toString(36) + randHex(3);
    var btn = form && form.querySelector("button"); if (btn) btn.disabled = true;
    gh("/actions/workflows/yt-reply.yml/dispatches", { method: "POST", body: { ref: GH_BRANCH, inputs: { page: pid, parent_id: parentId, text: text, req: req } } }).then(function () {
      var a = pendingReplies(); a.push({ req: req, page: pid, parent_id: parentId, text: text, at: Date.now() }); savePending(a);
      var ta = form && form.querySelector("textarea"); if (ta) ta.value = "";
      renderInbox(pid); toast("پاسخ در صف ارسال قرار گرفت");
      return waitRun("yt-reply.yml", req).then(function () { return loadYt(true); }).then(function () {
        var r = replyResult(req);
        if (r) toast(r.status === "sent" ? "پاسخ در یوتیوب منتشر شد ✓" : "✗ " + (r.error_fa || "ارسال پاسخ ناموفق بود"), 5000);
      });
    }).catch(function (e) {
      if (btn) btn.disabled = false;
      toast("ارسال پاسخ ممکن نشد: " + ghErrorFa(e), 5000);
    });
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
    var ts = tokenState();
    var html = topbar("انتشار محتوا");
    html += '<button class="back" id="back">→ صفحه‌ی اصلی</button>';
    if (!ts.has) {
      if (ts.locked) html += '<section class="card lilac-note form" id="pub-unlock"><div class="vi">' + ICON_LOCK + "</div><h2>اتصال هنوز روی این دستگاه فعال نشده</h2>" +
        "<p>برای فعال‌سازی اتصال، رمز پنل را یک بار وارد کن. توکنی که روی دستگاه دیگر همگام شده باز می‌شود و از این به بعد روی این دستگاه می‌ماند.</p>" + unlockFormHTML("punlock") + "</section>";
      else html += '<section class="card lilac-note" id="pub-notoken"><div class="vi">' + ICON_SEND + "</div><h2>اول توکن گیت‌هاب را اضافه کن</h2>" +
        "<p>انتشار از داخل این پنل با یک توکن گیت‌هاب انجام می‌شود (فایل در صف انتشار گذاشته می‌شود و GitHub Action آن را منتشر می‌کند). توکن فقط در مرورگر همین گوشی می‌ماند.</p>" +
        '<a class="go" href="#/settings">رفتن به تنظیمات</a></section>';
      app.innerHTML = html; bindTopbar();
      document.getElementById("back").onclick = function () { location.hash = "#/"; };
      bindUnlockForm("punlock", function () { setTimeout(function () { publishView(preId, prePl); toast("اتصال فعال شد ✓"); }, 400); });
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
        if (h === AUTH_HASH) {
          try { localStorage.setItem(AUTH_KEY, h); } catch (e2) {}
          setSessPw(u, p); // kept only for this tab (token encryption/decryption), never in localStorage
          try { sessionStorage.removeItem(UNLOCK_LATER); } catch (e2) {}
          render();
          // a synced token is opened right here with the password just typed (no second prompt);
          // if that fails for any reason, the "enter panel password" box appears instead
          if (!getToken()) pullToken(p).then(function (r) { if (r.pulled) { toast("اتصال گیت‌هاب فعال شد ✓"); render(); } else ensureUnlockUI(); }, function () { ensureUnlockUI(); });
          else syncOnStart();
        }
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
    else if (/^#\/tools/.test(h)) toolsView();
    else if (/^#\/(channels|p\/)/.test(h)) channelsView();
    else homeView();
    ensureUnlockUI();
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
      getJSON("data/history.json", true).catch(function () { return { series: {} }; }),
      getJSON("data/posts_history.json", true).catch(function () { return { channels: {} }; }),
      getJSON("data/comments.json", true).catch(function () { return { channels: {} }; })
    ]).then(function (res) {
      state.config = res[0]; state.latest = res[1]; state.history = res[2]; state.postsHist = res[3]; state.comments = res[4]; state.error = null;
      if (!quiet) rerenderSafe();
    }).catch(function (e) { state.error = e; if (!quiet) render(); });
  }

  // hooks for the automated tests (read-only helpers; nothing here bypasses the login)
  window.__spDebug = {
    load: function (fresh) { return load(fresh); }, render: function () { render(); },
    oauthURL: function (page, nonce) { return oauthURL(page, nonce); }, loadYt: function () { return loadYt(true); }, ytStatus: function (p) { return ytStatus(p); }, syncOnStart: function () { return syncOnStart(); }, tokenState: function () { return tokenState(); },
    mutateActivity: function () { // pretend new posts arrived on the channel currently listed last
      var ids = channelOrder(), last = ids[ids.length - 1], pg = state.latest && state.latest.pages[last];
      if (pg) PLATFORMS.forEach(function (pl) { if (pg.platforms[pl]) pg.platforms[pl].last_post_at = new Date().toISOString(); });
      render();
    }
  };
  // "اتصال" buttons (channel rows, analytics card, settings list) — one delegated handler
  document.addEventListener("click", function (e) {
    var j = e.target && e.target.closest ? e.target.closest("button[data-jump]") : null;
    if (j) { var t = document.getElementById(j.getAttribute("data-jump")); if (t) t.scrollIntoView({ behavior: "smooth", block: "start" }); return; }
    var b = e.target && e.target.closest ? e.target.closest("button[data-ytc]") : null;
    if (!b) return;
    e.preventDefault();
    startYtConnect(b.getAttribute("data-ytc"), b.getAttribute("data-st"));
  });
  var pendingReload = false;
  window.addEventListener("hashchange", function () { if (pendingReload && !onFormPage()) { location.reload(); return; } render(); });
  if (!authed()) loginView();
  load(false).then(syncOnStart);

  // Service worker: a new version takes over at once (skipWaiting + clients.claim in sw.js) and the page
  // reloads ONCE so old code never lingers. On a half-filled form the reload waits for the next navigation.
  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).then(function (reg) {
        document.addEventListener("visibilitychange", function () { if (document.visibilityState === "visible") reg.update().catch(function () {}); });
      }).catch(function () {});
    });
    var hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener("controllerchange", function () {
      if (!hadController) { hadController = true; return; } // first install on this visit: nothing old to replace
      var key = "sp_sw_reload";
      try { if (sessionStorage.getItem(key) === String(Date.now()).slice(0, -4)) return; sessionStorage.setItem(key, String(Date.now()).slice(0, -4)); } catch (e) {}
      if (onFormPage()) { pendingReload = true; return; }
      location.reload();
    });
  }
})();
