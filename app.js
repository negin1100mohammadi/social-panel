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

  var SP_VERSION = "v10";
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
  // v10: on a phone «ورود» opens the native app on that account (desktop keeps the web dashboards)
  function isMobileUA() {
    var ua = navigator.userAgent || "";
    return /iPhone|iPad|iPod|Android/i.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  }
  function appLinks(cp, pl, r) {
    var h = String((cp.accounts || {})[pl] || "").replace(/^@/, "");
    if (pl === "instagram" && h) return [{ label: "ورود", long: "اپ اینستاگرام روی @" + h, url: "instagram://user?username=" + encodeURIComponent(h), fallback: "https://www.instagram.com/" + encodeURIComponent(h) + "/", app: true }];
    if (pl === "tiktok" && h) return [{ label: "ورود", long: "اپ تیک‌تاک روی @" + h, url: "https://www.tiktok.com/@" + encodeURIComponent(h), app: true }];
    if (pl === "youtube") {
      var cid = r && /^UC[\w-]{22}$/.test(r.channel_id || "") ? r.channel_id : "";
      return [{ label: "ورود", long: "اپ YouTube Studio", url: "https://studio.youtube.com/" + (cid ? "channel/" + cid : ""), app: true }];
    }
    return null;
  }
  function adminLinks(cp, pl, r) {
    var m = isMobileUA() && appLinks(cp, pl, r); if (m) return m;
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
  var APP_NOTE = "اپ‌ها روی همون حسابی باز می‌شن که الان فعاله؛ اگه حساب دیگه بود، یه بار از منوی اکانت اپ عوضش کن (اینستا تا ۵ اکانت رو با هم نگه می‌داره)";
  // instagram://… opens the app; when the app is not installed the page stays visible -> the web profile instead
  document.addEventListener("click", function (e) {
    var a = e.target && e.target.closest ? e.target.closest("a[data-fallback]") : null; if (!a) return;
    var fb = a.getAttribute("data-fallback"), left = false;
    var onHide = function () { left = true; }; document.addEventListener("visibilitychange", onHide, { once: true }); window.addEventListener("pagehide", onHide, { once: true });
    setTimeout(function () { if (!left && document.visibilityState === "visible") location.href = fb; }, 1600);
  });
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
  var ICON_IDCARD = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2.5"/><circle cx="9" cy="11" r="2.2"/><path d="M5.8 16.2c.6-1.6 1.8-2.4 3.2-2.4s2.6.8 3.2 2.4M14.5 10h4M14.5 13.5h3"/></svg>';
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
      '<a class="tbox idbtn" id="idbtn" href="#/identity" aria-label="هویت برند" title="هویت برند (شناسنامه‌ی هر برند)">' + ICON_IDCARD + '<span>هویت</span></a>' +
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
  function onFormPage() { return /^#\/(publish|settings|brain|gallery|identity)/.test(location.hash); }
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
    html += '<a class="brainbox" href="#/brain" id="brainbox">' +
      '<span class="vi">' + ICON_BRAIN + '</span><span><div class="vt">مغز متفکر</div>' +
      '<div class="vs">ایده، سناریو و اسکریپت هر پیج</div></span>' +
      '<span class="arrow">←</span></a>';
    html += '<a class="galbox" href="#/gallery" id="galbox">' +
      '<span class="vi">' + ICON_GALLERY + '</span><span><div class="vt">گالری محتوا</div>' +
      '<div class="vs">اسلاید، ریل، استوری و ویدئوی آماده</div></span>' +
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
    document.getElementById("logout").onclick = function () { try { localStorage.removeItem(AUTH_KEY); } catch (e) {} setSessPw("", ""); forgetDataKey(); closeUnlock(); render(); };
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
        '<a class="pubmini" href="#/publish/' + esc(cp.id) + '" title="انتشار در ' + esc(cp.name) + '" aria-label="انتشار در ' + esc(cp.name) + '">' + ICON_SEND_SM + "</a></div>" +
        '<p class="app-note">' + esc(APP_NOTE) + "</p>";
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
              return '<a class="bbtn adm' + (i ? " alt" : "") + '" data-admin="' + pl + '" href="' + esc(x.url) + '"' + (/^https?:/.test(x.url) && !x.app ? ' target="_blank"' : "") +
                (x.fallback ? ' data-fallback="' + esc(x.fallback) + '"' : "") + (x.app ? ' data-app="1"' : "") + ' rel="noopener" title="' + esc(x.long) + '">' + (i ? "" : ICON_LOGIN) + "<span>" + esc(x.label) + "</span></a>";
            }).join("") +
            (pl === "youtube" ? ytBtnHTML(cp.id) : "") +
            ((pl === "instagram" || pl === "tiktok") && bufferCh(cp.id, pl) ? '<span class="bbtn ytc bufok" data-st="ok" title="از طریق بافر وصل است: آمار و انتشار از طریق بافر">متصل (بافر) ✓</span>' : "") +
            '<a class="bbtn chartbtn" data-route="' + esc(route.slice(2)) + '" href="' + esc(route) + '" title="آمار ' + PNAME[pl] + " " + esc(cp.name) + '" aria-label="آمار ' + PNAME[pl] + " " + esc(cp.name) + '">' + ICON_CHART + "</a>" +
            "</div>";
        });
        var bufPl = ["instagram", "tiktok"].filter(function (pl) { return (cp.accounts || {})[pl] && bufferCh(cp.id, pl); });
        if (bufPl.length) html += '<p class="adm-note buf-note">«متصل (بافر) ✓»: ' + bufPl.map(function (pl) { return PNAME[pl]; }).join(" و ") + " این پیج از طریق بافر وصل است — آمار و انتشار از طریق بافر.</p>";
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

  function loadPH(pid, pl, sfx) {
    var c = (((state.postsHist || {}).channels) || {})[pid + "/" + pl + (sfx || "")];
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

  // ---- v10: Instagram/TikTok metrics from Buffer (data/buffer.json; snapshots in posts_history "<page>/<pl>@buffer")
  function bufferStats(pid, pl) {
    var ch = (pl === "instagram" || pl === "tiktok") && bufferCh(pid, pl); if (!ch) return null;
    var pg = state.buffer.pages[pid], posts = [], upd = null;
    (pg.posts || []).forEach(function (x) {
      if (x.channelId !== ch.id) return;
      var m = {}; (x.metrics || []).forEach(function (q) { if (q && q.type) m[q.type] = num(q.value); });
      var mt = tsOf(x.metricsUpdatedAt); if (mt != null && (upd == null || mt > upd)) upd = mt;
      posts.push({ id: String(x.id), title: String(x.text || "").trim().split("\n")[0].slice(0, 120), url: x.externalLink || "", published: tsOf(x.dueAt), mt: mt, m: m });
    });
    var sum = function (k) { var h = posts.filter(function (p) { return p.m[k] != null; }); return h.length ? h.reduce(function (a, p) { return a + p.m[k]; }, 0) : null; };
    var er = posts.filter(function (p) { return p.m.engagementRate != null; });
    return { ch: ch, posts: posts, n: posts.length, updated: upd != null ? upd : tsOf(state.buffer.updated),
      t: { views: sum("views"), reach: sum("reach"), shares: sum("shares"), saves: sum("saves"), watch: sum("totalTimeWatched"), reactions: sum("reactions"), comments: sum("comments"),
        er: er.length ? er.reduce(function (a, p) { return a + p.m.engagementRate; }, 0) / er.length : null } };
  }
  // per-post history for a Buffer channel: the stored snapshots, or (until the first refresh stored them) one reading per post
  function bufferPH(pid, pl, B) {
    var ph = loadPH(pid, pl, "@buffer");
    if (ph && ph.posts.length) return ph;
    var t0 = B.updated != null ? B.updated : Date.now();
    var posts = B.posts.map(function (p) {
      var t = p.mt != null ? p.mt : t0;
      return { id: p.id, title: p.title, url: p.url, thumb: "", published: p.published, first: t, last: t, pts: [{ t: t, v: p.m.views, l: p.m.reactions, c: p.m.comments }] };
    });
    return { runs: [t0], posts: posts };
  }
  function bufNote(B) { return "(از بافر، به‌روز: " + (B.updated != null ? fmtShort(new Date(B.updated).toISOString()) : "—") + ")"; }
  function analyticsView(pid, pl, nowArg) {
    var cp = cpById(pid);
    if (!cp || PLATFORMS.indexOf(pl) < 0) { location.hash = "#/channels"; return; }
    var page = pageData(cp), r = page.platforms[pl] || {};
    var B = bufferStats(pid, pl);
    var ok = hasData(r) || !!B;
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

    var ph = B ? bufferPH(pid, pl, B) : loadPH(pid, pl);
    var hasPostLists = ph && ph.posts.length;
    var A = { ph: ph, noPosts: null };
    if (!hasPostLists && r.posts === 0 && pl !== "tiktok") A.noPosts = "هنوز " + POSTS_LABEL[pl] + "ی در این کانال منتشر نشده.";
    else if (!hasPostLists && (pl === "tiktok" || !(r.recent || []).length && r.posts > 0)) A.noPosts = NO_POSTS_MSG[pl] || ("فهرست " + POSTS_LABEL[pl] + "‌های " + PNAME[pl] + " در دسترس نیست؛ آمار تک‌تک " + POSTS_LABEL[pl] + "‌ها نداریم.");
    var series = seriesOf(pid, pl);
    function draw() {
      var now = nowArg || Date.now(), rg = rangeById(pref.r);
      A.W = computeWindow(ph, rg, now);
      var b;
      if (B) {
        var bn = bufNote(B), T = B.t, f1 = function (v) { return v == null ? "—" : fa(Math.round(v * 10) / 10); };
        b = '<div class="kpis three" id="bufkpis" data-views="' + dataAttr(T.views) + '">' +
          kpi(FOLLOW_LABEL[pl], fa(r.followers)) +
          kpi("کل " + POSTS_LABEL[pl] + "‌ها", fa(r.posts != null ? r.posts : B.n)) +
          kpi("کل بازدیدها", fa(T.views), "", "جمع " + fa(B.n) + " " + POSTS_LABEL[pl] + "ِ آخر " + bn) + "</div>" +
          '<div class="kpis bufx" id="bufx">' + kpi("دسترسی (Reach)", fa(T.reach)) + kpi("اشتراک‌گذاری", fa(T.shares)) +
          (pl === "instagram" ? kpi("ذخیره", fa(T.saves)) : kpi("لایک", fa(T.reactions))) +
          kpi("زمان تماشا", T.watch == null ? "—" : fa(Math.round(T.watch)) + " دقیقه") + kpi("نرخ تعامل", T.er == null ? "—" : f1(T.er) + "٪", "", "میانگین پست‌ها") +
          '<p class="bufsrc">' + esc(bn + " · جمع " + fa(B.n) + " " + POSTS_LABEL[pl] + "ی که بافر برگرداند") + "</p></div>";
      } else b = '<div class="kpis three">' +
        kpi(FOLLOW_LABEL[pl], fa(r.followers)) +
        kpi("کل " + POSTS_LABEL[pl] + "‌ها", fa(r.posts)) +
        kpi(pl === "tiktok" ? "کل لایک‌ها" : "کل بازدیدها", fa(pl === "tiktok" ? r.total_likes : r.total_views), "", (pl === "tiktok" ? r.total_likes : r.total_views) == null ? NO_ACCESS : "") + "</div>";
      b += summaryHTML(A, pl, rg, A.W, B ? '<div class="chan-total bufsrc" id="buf-sum">' + esc("بازدید تازه از اندازه‌گیری‌های بافر " + bufNote(B) + (A.ph.runs.length < 2 ? " — تا دو اندازه‌گیری ثبت نشده، برای پست‌های منتشرشده در این بازه کل بازدیدشان حساب می‌شود." : "")) + "</div>" : channelTotalHTML(series, pl, r, rg, now));
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
  var ST_FA = { pending: "در انتظار", scheduled: "زمان‌بندی‌شده", processing: "در حال انتشار", published: "منتشر شد", partial: "بخشی منتشر شد", failed: "ناموفق", needs_setup: "اتصال برقرار نیست", needs_action: "نیاز به اقدام", cancelled: "لغو شد", skipped: "رد شد" };
  var ST_CLS = { published: "good", partial: "warn", failed: "bad", needs_setup: "warn", cancelled: "", pending: "accent", scheduled: "accent", processing: "accent", skipped: "" };
  function stPill(st) { return '<span class="pill ' + (ST_CLS[st] || "") + '">' + esc(ST_FA[st] || st) + "</span>"; }

  function nowTehranInput(offsetMin) {
    var o = tehranParts(new Date(Date.now() + (offsetMin || 0) * 60000));
    return o.year + "-" + o.month + "-" + o.day + "T" + o.hour + ":" + o.minute;
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
  function stageOnBranch(path, sha, attempt) { return stageOn(MEDIA_BRANCH, path, sha, "media: " + path, attempt); }
  function stageOn(branch, path, sha, msg, attempt) {
    return gh("/git/ref/heads/" + branch).catch(function (e) { if (e.status === 404) return null; throw e; }).then(function (ref) {
      var parent = ref && ref.object && ref.object.sha;
      var base = parent ? gh("/git/commits/" + parent).then(function (c) { return c.tree.sha; }) : Promise.resolve(null);
      return base.then(function (baseTree) {
        var body = { tree: [{ path: path, mode: "100644", type: "blob", sha: sha }] };
        if (baseTree) body.base_tree = baseTree;
        return gh("/git/trees", { method: "POST", body: body });
      }).then(function (tree) {
        return gh("/git/commits", { method: "POST", body: { message: msg, tree: tree.sha, parents: parent ? [parent] : [] } });
      }).then(function (commit) {
        if (parent) return gh("/git/refs/heads/" + branch, { method: "PATCH", body: { sha: commit.sha, force: false } });
        return gh("/git/refs", { method: "POST", body: { ref: "refs/heads/" + branch, sha: commit.sha } });
      });
    }).catch(function (e) {
      if (!attempt && (e.status === 422 || e.status === 409)) return sleep(1500).then(function () { return stageOn(branch, path, sha, msg, 1); });
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
        media: { branch: MEDIA_BRANCH, path: path, blob_sha: sha, name: id + "." + ext, type: file.type, size: file.size },
        asset_url: null, status: "pending", results: {}
      };
      say("در حال افزودن به صف انتشار…");
      return gh("/contents/queue/" + id + ".json", { method: "PUT", body: { message: "queue: " + id + (when ? " (scheduled)" : ""), content: b64utf8(JSON.stringify(job, null, 1) + "\n"), branch: GH_BRANCH } }).then(function () { return job; });
    });
  }
  // ============================================================= v8: encrypted data store
  // Brain texts, gallery metadata and publish links live ENCRYPTED in the (public) repo under vault/*.enc.json.
  // A random 256-bit data key (DK) + an inbox ECDH P-256 key pair are wrapped with the panel password
  // (PBKDF2-SHA256 310k -> AES-GCM, exactly like config/token.enc.json) in config/data_key.enc.json.
  // Each data file = AES-256-GCM(DK, JSON), AAD = "sp-data-v1|<path>". Writes go through the contents API with
  // the device's GitHub token, re-read + retried on a sha conflict. External tools (gallery-ingest.yml) encrypt
  // their inbox items to the public key in config/inbox_pub.json (ECIES: ECDH P-256 + HKDF-SHA256 + AES-GCM);
  // only an unlocked panel can open them, and it merges them into the gallery.
  var KEYRING_PATH = "config/data_key.enc.json", INBOX_PUB_PATH = "config/inbox_pub.json", INBOX_DIR = "inbox";
  var DK_LS = "sp_dk", QCACHE_LS = "sp_qcache";
  var GALLERY_TAG = "gallery";
  var DS = { dk: null, kid: null, priv: null, pubJwk: null, ring: undefined, files: {} };
  var TE = new TextEncoder(), TD = new TextDecoder();
  function rnd(n) { return crypto.getRandomValues(new Uint8Array(n)); }
  function utf8b64dec(s) { return TD.decode(b64u8(String(s || "").replace(/\s/g, ""))); }
  function needErr(kind, msg) { var e = new Error(msg || kind); e.need = kind; return e; }
  function importDK(raw) { return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]); }
  function importPriv(jwk) { return crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, d: jwk.d }, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]); }
  function aesEnc(key, obj, aad) {
    var iv = rnd(12);
    return crypto.subtle.encrypt({ name: "AES-GCM", iv: iv, additionalData: TE.encode(aad) }, key, TE.encode(JSON.stringify(obj)))
      .then(function (ct) { return { iv: u8b64(iv), ct: u8b64(new Uint8Array(ct)) }; });
  }
  function aesDec(key, iv, ct, aad) {
    return crypto.subtle.decrypt({ name: "AES-GCM", iv: b64u8(iv), additionalData: TE.encode(aad) }, key, b64u8(ct))
      .then(function (pt) { return JSON.parse(TD.decode(pt)); });
  }
  function wrapRing(pw, kid, payload) {
    var salt = rnd(16), iv = rnd(12);
    return deriveKey(pw, salt).then(function (k) {
      return crypto.subtle.encrypt({ name: "AES-GCM", iv: iv, additionalData: TE.encode("sp-keyring-v1|" + kid) }, k, TE.encode(JSON.stringify(payload)));
    }).then(function (ct) {
      return { v: 1, kid: kid, kdf: "PBKDF2-SHA256", iter: KDF_ITER, alg: "AES-256-GCM", salt: u8b64(salt), iv: u8b64(iv), ct: u8b64(new Uint8Array(ct)),
        created_at: new Date().toISOString(), about: "social-panel data key, wrapped with the panel password (vault/*.enc.json are encrypted with it)" };
    });
  }
  function unwrapRing(ring, pw) {
    return deriveKey(pw, b64u8(ring.salt)).then(function (k) {
      return crypto.subtle.decrypt({ name: "AES-GCM", iv: b64u8(ring.iv), additionalData: TE.encode("sp-keyring-v1|" + ring.kid) }, k, b64u8(ring.ct));
    }).then(function (pt) { return JSON.parse(TD.decode(pt)); });
  }
  function pubOf(jwk) { return { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y }; }
  function adoptKeys(kid, payload) {
    return Promise.all([importDK(b64u8(payload.dk)), importPriv(payload.inbox_priv)]).then(function (k) {
      DS.dk = k[0]; DS.priv = k[1]; DS.kid = kid; DS.pubJwk = pubOf(payload.inbox_priv);
      lsSet(DK_LS, { kid: kid, dk: payload.dk, inbox_priv: payload.inbox_priv }); // same trust level as the GitHub token on this device
    });
  }
  function forgetDataKey() { DS.dk = null; DS.priv = null; DS.kid = null; DS.files = {}; try { localStorage.removeItem(DK_LS); } catch (e) {} }
  // plain (non-secret) JSON file write with sha retry
  function putJSONFile(path, obj, msg) {
    var tries = 0;
    function attempt() {
      return gh("/contents/" + path + "?ref=" + GH_BRANCH + "&t=" + Date.now()).then(function (f) { return f && f.sha; }, function (e) { if (e.status === 404) return null; throw e; })
        .then(function (sha) {
          var body = { message: msg, content: b64utf8(JSON.stringify(obj, null, 1) + "\n"), branch: GH_BRANCH }; if (sha) body.sha = sha;
          return gh("/contents/" + path, { method: "PUT", body: body });
        }).catch(function (e) { if ((e.status === 409 || e.status === 422) && tries++ < 4) return sleep(700 * tries).then(attempt); throw e; });
    }
    return attempt();
  }
  function readRing(force) {
    if (DS.ring !== undefined && !force) return Promise.resolve(DS.ring);
    return fetchRepoJSON(KEYRING_PATH).then(function (r) { DS.ring = r && r.kid ? r : null; return DS.ring; });
  }
  function writeInboxPub() {
    return putJSONFile(INBOX_PUB_PATH, { v: 1, kid: DS.kid, alg: "ECDH-P256+HKDF-SHA256+A256GCM", info: "sp-inbox-v1", jwk: DS.pubJwk, created_at: new Date().toISOString(),
      about: "public key for gallery-ingest.yml: inbox items are encrypted to it; only the unlocked panel can read them" }, "data: inbox public key");
  }
  function createRing(pw) {
    var kid = randHex(8), dk = rnd(32);
    return crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]).then(function (kp) {
      return crypto.subtle.exportKey("jwk", kp.privateKey);
    }).then(function (jwk) {
      var payload = { dk: u8b64(dk), inbox_priv: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, d: jwk.d } };
      return wrapRing(pw, kid, payload).then(function (ring) {
        // create only (no sha): if another device created one meanwhile, GitHub refuses (422) and we use theirs
        return gh("/contents/" + KEYRING_PATH, { method: "PUT", body: { message: "data: create encrypted data key", content: b64utf8(JSON.stringify(ring, null, 1) + "\n"), branch: GH_BRANCH } })
          .then(function () { DS.ring = ring; return adoptKeys(kid, payload); })
          .then(function () { return writeInboxPub().catch(function () {}); }, function (e) {
            if (e.status === 422 || e.status === 409) return readRing(true).then(function (r) { if (!r) throw e; return unwrapRing(r, pw).then(function (p) { return adoptKeys(r.kid, p); }); });
            throw e;
          });
      });
    });
  }
  // is this typed password the panel password? (it must open the synced token copy)
  function verifyTypedPw(pw) {
    return fetchEnc().then(function (obj) {
      if (!obj) return false;
      return decryptToken(obj, pw).then(function () { return true; }, function () { return false; });
    });
  }
  // resolves when the data key is in memory; rejects with e.need = token | pw | badpw | net
  function ensureData(typedPw) {
    if (!getToken()) return Promise.reject(needErr("token"));
    return readRing(DS.ring === undefined).catch(function () { throw needErr("net", "خواندن کلید رمزگذاری از گیت‌هاب ممکن نشد"); }).then(function (ring) {
      if (DS.dk && ring && ring.kid === DS.kid) return true;
      var c = lsGet(DK_LS, null);
      if (ring && c && c.kid === ring.kid && c.dk && c.inbox_priv && !typedPw) return adoptKeys(c.kid, c).then(function () { return true; });
      var pw = typedPw || sessPw();
      if (!pw) throw needErr("pw");
      if (!ring) {
        var check = typedPw ? verifyTypedPw(pw) : Promise.resolve(true); // a login password was already checked against the panel hash
        return check.then(function (good) { if (!good) throw needErr("badpw", "این رمز درست نیست (همان رمز ورود به پنل)."); return createRing(pw); }).then(function () { return true; });
      }
      return unwrapRing(ring, pw).then(function (p) { return adoptKeys(ring.kid, p).then(function () { return true; }); },
        function () { if (typedPw) throw needErr("badpw", "این رمز درست نیست (همان رمز ورود به پنل)."); throw needErr("pw"); });
    });
  }
  function vaultPath(name) { return "vault/" + name + ".enc.json"; }
  function readRepoFile(path) {
    return gh("/contents/" + path + "?ref=" + GH_BRANCH + "&t=" + Date.now()).then(function (meta) {
      var c = meta && meta.content ? Promise.resolve(meta.content) : gh("/git/blobs/" + meta.sha).then(function (b) { return b.content; }); // > 1 MB: blob API
      return c.then(function (b64) { return { obj: JSON.parse(utf8b64dec(b64)), sha: meta.sha }; });
    }, function (e) { if (e.status === 404) return { obj: null, sha: null }; throw e; });
  }
  function dsRead(name) {
    var path = vaultPath(name);
    return readRepoFile(path).then(function (f) {
      if (!f.obj) { DS.files[name] = { data: null, sha: null }; return null; }
      if (f.obj.kid && f.obj.kid !== DS.kid) throw new Error("این فایل با کلید دیگری رمزگذاری شده (" + path + ")");
      return aesDec(DS.dk, f.obj.iv, f.obj.ct, "sp-data-v1|" + path).then(function (data) { DS.files[name] = { data: data, sha: f.sha }; return data; });
    });
  }
  function dsCached(name) { return DS.files[name] ? DS.files[name].data : undefined; }
  // read-modify-write; mutate(currentOrNull) returns the new object. Conflicts (another device wrote first) re-read and re-apply.
  function dsUpdate(name, mutate, msg) {
    var path = vaultPath(name), tries = 0;
    function attempt() {
      return dsRead(name).then(function (cur) {
        var next = mutate(cur ? JSON.parse(JSON.stringify(cur)) : null);
        next.v = 1; next.updated_at = new Date().toISOString();
        return aesEnc(DS.dk, next, "sp-data-v1|" + path).then(function (enc) {
          var file = { v: 1, kid: DS.kid, alg: "AES-256-GCM", iv: enc.iv, ct: enc.ct, updated_at: next.updated_at };
          var body = { message: msg || "data: " + name, content: b64utf8(JSON.stringify(file) + "\n"), branch: GH_BRANCH };
          var sha = DS.files[name] && DS.files[name].sha; if (sha) body.sha = sha;
          return gh("/contents/" + path, { method: "PUT", body: body }).then(function (r) {
            DS.files[name] = { data: next, sha: r && r.content && r.content.sha }; return next;
          });
        });
      }).catch(function (e) {
        if ((e.status === 409 || e.status === 422) && tries++ < 5) return sleep(600 + tries * 700).then(attempt);
        throw e;
      });
    }
    return attempt();
  }
  // ---- ECIES inbox (gallery-ingest.yml -> inbox/<id>.enc.json)
  function inboxDecrypt(obj) {
    return crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: obj.epk.x, y: obj.epk.y }, { name: "ECDH", namedCurve: "P-256" }, false, [])
      .then(function (epk) { return crypto.subtle.deriveBits({ name: "ECDH", public: epk }, DS.priv, 256); })
      .then(function (bits) { return crypto.subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]); })
      .then(function (h) { return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: TE.encode("sp-inbox-v1") }, h, { name: "AES-GCM", length: 256 }, false, ["decrypt"]); })
      .then(function (k) { return aesDec(k, obj.iv, obj.ct, "sp-inbox-v1|" + obj.id); });
  }
  // move every inbox item into its domain's gallery, then delete the inbox file. Resolves the number merged.
  var inboxBusy = null;
  function mergeInbox() {
    if (inboxBusy) return inboxBusy;
    inboxBusy = gh("/contents/" + INBOX_DIR + "?ref=" + GH_BRANCH + "&t=" + Date.now()).catch(function (e) { if (e.status === 404) return []; throw e; }).then(function (files) {
      files = (files || []).filter(function (f) { return /\.enc\.json$/.test(f.name); });
      if (!files.length) return 0;
      return Promise.all(files.map(function (f) {
        return readRepoFile(INBOX_DIR + "/" + f.name).then(function (r) {
          if (!r.obj || (r.obj.kid && r.obj.kid !== DS.kid)) return null;
          return inboxDecrypt(r.obj).then(function (item) { return { file: f, sha: r.sha, item: item }; });
        }).catch(function () { return null; });
      })).then(function (rows) {
        rows = rows.filter(function (x) { return x && x.item && cpById(x.item.page); });
        var byPage = {}; rows.forEach(function (x) { (byPage[x.item.page] = byPage[x.item.page] || []).push(x); });
        return Object.keys(byPage).reduce(function (p, pid) {
          return p.then(function () {
            return dsUpdate("gallery-" + pid, function (d) {
              d = d || { items: [] }; var have = {}; d.items.forEach(function (it) { have[it.id] = 1; });
              byPage[pid].forEach(function (x) { if (!have[x.item.id]) d.items.push(normGalleryItem(x.item, pid)); });
              return d;
            }, "data: gallery " + pid + " (inbox)");
          }).then(function () {
            return Promise.all(byPage[pid].map(function (x) {
              return gh("/contents/" + INBOX_DIR + "/" + x.file.name, { method: "DELETE", body: { message: "inbox: merged " + x.file.name, sha: x.sha, branch: GH_BRANCH } }).catch(function () {});
            }));
          });
        }, Promise.resolve()).then(function () { return rows.length; });
      });
    }).then(function (n) { inboxBusy = null; return n; }, function (e) { inboxBusy = null; throw e; });
    return inboxBusy;
  }
  function normGalleryItem(it, pid) {
    return { id: it.id, page: pid, kind: KIND_FA[it.kind] ? it.kind : "video", kind_auto: it.kind_auto || it.kind, rule: it.rule || "", override: !!it.override,
      title: it.title || "", caption: it.caption || "", media: it.media || [], thumb: it.thumb || "", status: it.status || "uploaded", brain_id: it.brain_id || "",
      source: it.source || null, created_at: it.created_at || new Date().toISOString(), updated_at: it.updated_at || it.created_at || new Date().toISOString() };
  }

  // ============================================================= v8: statuses (shared by brain / gallery / publish)
  var ST = {
    brain: [["idea", "ایده"], ["writing", "در حال نوشتن"], ["scenario_ready", "سناریو آماده"], ["script_ready", "اسکریپت آماده"], ["made", "ساخته شد"], ["published", "منتشر شد"]],
    gallery: [["uploaded", "بارگذاری شد"], ["ready", "آماده انتشار"], ["scheduled", "زمان‌بندی شد"], ["published", "منتشر شد"]],
    publish: [["queued", "در صف"], ["scheduled", "زمان‌بندی شد"], ["publishing", "در حال انتشار"], ["published", "منتشر شد"], ["error", "خطا"]]
  };
  function stIndex(area, key) { for (var i = 0; i < ST[area].length; i++) if (ST[area][i][0] === key) return i; return 0; }
  function stLabel(area, key) { return ST[area][stIndex(area, key)][1]; }
  function stChip(area, key, extra) {
    return '<span class="schip s-' + area + "-" + esc(key) + '" data-status="' + esc(key) + '">' + esc(stLabel(area, key)) + (extra ? " · " + esc(extra) : "") + "</span>";
  }
  function stDots(area, key) {
    var n = ST[area].length, i = stIndex(area, key), h = '<span class="sdots s-' + area + "-" + esc(key) + '" role="img" aria-label="مرحله‌ی ' + fa(i + 1) + " از " + fa(n) + '">';
    if (area === "publish" && key === "error") { for (var k = 0; k < n - 1; k++) h += '<i class="on"></i>'; return h + '<i class="on x"></i></span>'; }
    var steps = area === "publish" ? n - 1 : n; // the publish strip has 4 steps + error
    for (var j = 0; j < steps; j++) h += "<i" + (j <= i ? ' class="on"' : "") + "></i>";
    return h + "</span>";
  }
  function maxSt(area, a, b) { return stIndex(area, a) >= stIndex(area, b) ? a : b; }
  // one target of a queue job: published | manual | error | pending
  // v10: manual = «اتصال برقرار نیست» (unresolved: needs تلاش دوباره / دستی منتشر کردم / لغو); error = final failure
  function targetState(job, t) {
    var r = (job.results || {})[t.page + "/" + t.platform] || {};
    if (r.status === "published") return "published";
    if (r.status === "manual" || r.status === "needs_setup") return job.status === "cancelled" ? "error" : "manual";
    if (r.status === "failed" || r.status === "skipped" || r.status === "cancelled") return "error";
    if (job.status === "cancelled") return "error";
    return "pending"; // no result yet, queued (تلاش دوباره) or an automatic retry
  }
  // the job's own status from its channels (mirrors aggregate() in scripts/publish.py)
  function finalizeJob(job) {
    var sts = (job.targets || []).map(function (t) { return ((job.results || {})[t.page + "/" + t.platform] || {}).status; });
    var fin = ["published", "failed", "skipped", "cancelled", "needs_setup", "manual"];
    if (sts.some(function (x) { return fin.indexOf(x) < 0; })) { job.status = "pending"; delete job.finished_at; return job; }
    if (sts.some(function (x) { return x === "needs_setup" || x === "manual"; })) { job.status = "needs_action"; delete job.finished_at; return job; }
    job.status = sts.every(function (x) { return x === "published"; }) ? "published" : sts.some(function (x) { return x === "published"; }) ? "partial" : "failed";
    job.finished_at = new Date().toISOString();
    return job;
  }
  // publish status of a queue job (plain queue/<id>.json, written back by publish.py)
  function pubStatusOf(job, now, running) {
    if (!job) return "queued";
    if (job.status === "cancelled") return "error";
    var due = tsOf(job.publish_at) || 0, c = { published: 0, manual: 0, error: 0, pending: 0 };
    (job.targets || []).forEach(function (t) { c[targetState(job, t)]++; });
    if (c.pending) {
      if (due > now + 60000) return "scheduled";
      if (running || Object.keys(job.results || {}).length) return "publishing";
      return "queued";
    }
    if (c.published) return "published"; // unresolved channels stay visible per target («نیاز به اقدام»)
    return "error";
  }
  // statuses flow downstream -> upstream through the link ids:
  // queue job -> publish record (gallery_id, brain_id) -> gallery item (brain_id) -> brain item (parent_id chain)
  function syncStatuses(ctx, now, running) {
    var brain = ctx.brain || [], gallery = ctx.gallery || [], records = ctx.records || {}, jobs = ctx.jobs || {};
    var out = { pub: {}, gal: {}, brain: {} };
    Object.keys(records).forEach(function (id) { out.pub[id] = jobs[id] ? pubStatusOf(jobs[id], now, running) : "queued"; });
    Object.keys(jobs).forEach(function (id) { if (!out.pub[id]) out.pub[id] = pubStatusOf(jobs[id], now, running); });
    gallery.forEach(function (g) {
      var s = ST.gallery.some(function (x) { return x[0] === g.status; }) ? g.status : "uploaded";
      Object.keys(records).forEach(function (id) {
        var r = records[id]; if (r.gallery_id !== g.id) return;
        var ps = out.pub[id];
        if (ps === "published") s = maxSt("gallery", s, "published");
        else if (ps === "queued" || ps === "scheduled" || ps === "publishing") s = maxSt("gallery", s, "scheduled");
      });
      out.gal[g.id] = s;
    });
    var byId = {}; brain.forEach(function (b) { byId[b.id] = b; out.brain[b.id] = ST.brain.some(function (x) { return x[0] === b.status; }) ? b.status : "idea"; });
    gallery.forEach(function (g) {
      if (!g.brain_id || !byId[g.brain_id]) return;
      out.brain[g.brain_id] = maxSt("brain", out.brain[g.brain_id], out.gal[g.id] === "published" ? "published" : "made");
    });
    Object.keys(records).forEach(function (id) { // a publish record can point at a brain item directly
      var r = records[id]; if (r.brain_id && byId[r.brain_id] && out.pub[id] === "published") out.brain[r.brain_id] = maxSt("brain", out.brain[r.brain_id], "published");
    });
    // a scenario/script that got further lifts its idea/scenario (never lowers anything)
    for (var pass = 0; pass < 3; pass++) brain.forEach(function (b) {
      var p = b.parent_id && byId[b.parent_id]; if (p) out.brain[p.id] = maxSt("brain", out.brain[p.id], out.brain[b.id]);
    });
    return out;
  }

  // ============================================================= v8: auto-classification (browser side; scripts/gallery_classify.py mirrors it)
  var KINDS = ["slide", "reel", "story", "video"];
  var KIND_FA = { slide: "اسلاید", reel: "ریل", story: "استوری", video: "ویدئو" };
  function nearRatio(w, h, a, b, tol) { if (!w || !h) return false; return Math.abs(w / h - a / b) <= (tol || 0.03); }
  function classifyImage(f) {
    if (!f.w || !f.h) return { kind: "slide", rule: "ابعاد عکس خوانده نشد → اسلاید (پیش‌فرض عکس)" };
    if (nearRatio(f.w, f.h, 9, 16)) return { kind: "story", rule: "عکس تکی ۹:۱۶ → استوری" };
    if (nearRatio(f.w, f.h, 4, 5)) return { kind: "slide", rule: "عکس ۴:۵ → اسلاید" };
    if (nearRatio(f.w, f.h, 1, 1)) return { kind: "slide", rule: "عکس ۱:۱ → اسلاید" };
    return { kind: "slide", rule: "عکس با نسبت دیگر → اسلاید (پیش‌فرض عکس)" };
  }
  function classifyVideo(f, story) {
    var d = f.dur || 0;
    if (!f.w || !f.h) return { kind: "video", rule: "ابعاد ویدئو خوانده نشد → ویدئو" };
    if (story && d > 0 && d <= 60) return { kind: "story", rule: "ویدئوی تا ۶۰ ثانیه با علامت «استوری» → استوری" };
    if (f.w > f.h) return { kind: "video", rule: "ویدئوی افقی → ویدئو" };
    var v916 = nearRatio(f.w, f.h, 9, 16);
    if (v916 && d > 0 && d <= 15) return { kind: "story", rule: "ویدئوی ۹:۱۶ تا ۱۵ ثانیه → پیشنهاد: استوری (یا ریل)", suggest: true };
    if (d > 0 && d <= 90) return { kind: "reel", rule: v916 ? "ویدئوی عمودی ۹:۱۶ تا ۹۰ ثانیه → ریل" : "ویدئوی عمودی/مربعی تا ۹۰ ثانیه → ریل" };
    return { kind: "video", rule: d > 90 ? "ویدئوی بلندتر از ۹۰ ثانیه → ویدئو" : "مدت ویدئو خوانده نشد → ویدئو" };
  }
  // files: [{type:"image"|"video", w, h, dur}] from one upload; returns [{files:[indexes], kind, rule, suggest}]
  function classifyUpload(files, opts) {
    opts = opts || {};
    var out = [], imgs = [], i;
    for (i = 0; i < files.length; i++) if (files[i].type === "image") imgs.push(i);
    if (imgs.length > 1) out.push({ files: imgs, kind: "slide", rule: "چند عکس در یک بارگذاری (" + fa(imgs.length) + " عکس) → اسلاید" });
    else if (imgs.length === 1) { var c = classifyImage(files[imgs[0]]); out.push({ files: imgs, kind: c.kind, rule: c.rule }); }
    for (i = 0; i < files.length; i++) if (files[i].type === "video") { var v = classifyVideo(files[i], !!opts.story); out.push({ files: [i], kind: v.kind, rule: v.rule, suggest: !!v.suggest }); }
    return out;
  }
  window.__spV8 = {
    classifyUpload: classifyUpload, syncStatuses: syncStatuses, pubStatusOf: pubStatusOf, ST: ST,
    ensureData: function (pw) { return ensureData(pw); }, dsRead: function (n) { return dsRead(n); }, dsUpdate: function (n, f) { return dsUpdate(n, f); },
    mergeInbox: function () { return mergeInbox(); }, kid: function () { return DS.kid; }, forget: function () { forgetDataKey(); DS.ring = undefined; },
    inboxDecrypt: function (o) { return inboxDecrypt(o); }
  };
  window.__spV9 = {
    mergeHarkOut: function (p) { return mergeHarkOut(p); }, scriptText: function (s, t) { return scriptText(s, t); }, applyHarkOut: function (d, m, p) { return applyHarkOut(d, m, p, "2026-01-01T00:00:00Z"); },
    harkSeal: function (pub, id, payload) { return harkSeal(pub, id, payload); }, harkOpen: function (env, aad) { return harkOpen(env, aad); }, tools: function () { return PROD_TOOLS; }
  };
  window.__spV10 = {
    applyEdit: function (c, e, k) { return applyEdit(c, e, k, "2026-11-17T10:00:00+03:30"); }, screenText: function (s) { return screenText(s); },
    applyIdentityOut: function (d, m, now) { return applyIdentityOut(d, m, now || "2026-11-17T10:00:00+03:30"); }, identityBrief: function (cp, d) { return identityBrief(cp, d); },
    sections: function () { return ID_SECTIONS; }, idNorm: function (t, v) { return idNorm(t, v); }
  };

  // ============================================================= v8: shared view helpers
  var ICON_BRAIN = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.5 4a3 3 0 0 0-3 3v.3A3 3 0 0 0 4.5 12a3 3 0 0 0 2 4.7V17a3 3 0 0 0 3 3h.5V4z"/><path d="M14.5 4a3 3 0 0 1 3 3v.3a3 3 0 0 1 2 4.7 3 3 0 0 1-2 4.7V17a3 3 0 0 1-3 3H14V4z"/><path d="M10 9H8.5M14 9h1.5M10 14H8M14 14h2"/></svg>';
  var ICON_GALLERY = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="14" height="14" rx="2.5"/><path d="M7 3h11a3 3 0 0 1 3 3v11"/><circle cx="8" cy="10" r="1.5"/><path d="M3 16l4-4 4 4 2-2 4 4"/></svg>';
  var PRIVACY_NOTE = "متن‌ها و اطلاعات گالری و انتشار به‌صورت رمزگذاری‌شده (AES-256-GCM با کلیدی که فقط با رمز پنل باز می‌شود) در مخزن ذخیره می‌شوند. " +
    "اما خود فایل‌های عکس و ویدئو در Release عمومی مخزن هستند: هر کس لینک دقیق فایل را داشته باشد، یا صفحه‌ی Releases مخزن را باز کند، می‌تواند آن‌ها را ببیند.";
  function hashQuery() {
    var h = location.hash || "", i = h.indexOf("?"), o = {};
    if (i < 0) return o;
    h.slice(i + 1).split("&").forEach(function (kv) { var p = kv.split("="); if (p[0]) o[decodeURIComponent(p[0])] = decodeURIComponent(p[1] || ""); });
    return o;
  }
  function newId(prefix) {
    var o = tehranParts(new Date());
    return prefix + o.year.slice(2) + o.month + o.day + "-" + o.hour + o.minute + o.second + "-" + randHex(2);
  }
  function releaseURL(name) { return "https://github.com/" + GH_OWNER + "/" + GH_REPO + "/releases/download/" + GALLERY_TAG + "/" + encodeURIComponent(name); }
  function mb(n) { return fa(Math.round((n || 0) / 1048576 * 10) / 10) + " مگابایت"; }
  function secs(d) { if (!d) return ""; d = Math.round(d); return d < 60 ? fa(d) + " ثانیه" : fa(Math.floor(d / 60)) + ":" + ("0" + (d % 60)).slice(-2).replace(/\d/g, function (x) { return "۰۱۲۳۴۵۶۷۸۹"[x]; }); }
  function shell(title, backTo, backLabel) {
    return topbar(title) + '<button class="back" id="back" data-to="' + esc(backTo) + '">→ ' + esc(backLabel) + "</button>";
  }
  function bindShell() {
    bindTopbar();
    var b = document.getElementById("back"); if (b) b.onclick = function () { location.hash = b.getAttribute("data-to"); };
  }
  function filterSeg(area, cur, counts) {
    return '<div class="sfilter" role="group" aria-label="فیلتر وضعیت" data-area="' + area + '"><button data-f="all" class="' + (cur === "all" ? "on" : "") + '">همه' + (counts ? " " + fa(counts.all || 0) : "") + "</button>" +
      ST[area].map(function (s) { return '<button data-f="' + s[0] + '" class="s-' + area + "-" + s[0] + (cur === s[0] ? " on" : "") + '">' + esc(s[1]) + (counts ? " " + fa(counts[s[0]] || 0) : "") + "</button>"; }).join("") + "</div>";
  }
  var viewSeq = 0; // bumped by every render(): async results of a view that is no longer shown are dropped
  function live(my) { return my === viewSeq; }
  var v8ui = { bf: {}, gf: {}, pf: "all", cal: { mode: "month", anchor: null, day: null }, pview: "queue" };
  // the encrypted area can open only with this device's GitHub token + the data key (panel password once)
  function withData(onReady) {
    var box = document.getElementById("dgate"); if (!box) return;
    var my = viewSeq;
    box.innerHTML = '<div class="muted-note pad">در حال باز کردن محتوای رمزگذاری‌شده…</div>';
    ensureData().then(function () { if (!live(my)) return; box.innerHTML = ""; onReady(); }, function (e) { gate(e); });
    function gate(e) {
      if (!live(my) || !document.getElementById("dgate")) return;
      if (e.need === "token") {
        // the synced-token check may not have finished yet on a fresh visit: ask the repo before saying "no token"
        if (!state.syncAvailable && !e.checked) {
          fetchEnc().then(function (o) { state.syncAvailable = !!o; }, function () {}).then(function () { e.checked = true; gate(e); });
          return;
        }
        var ts = tokenState();
        if (ts.locked) {
          box.innerHTML = '<section class="card lilac-note form" id="data-tokunlock"><div class="vi">' + ICON_LOCK + "</div><h2>اتصال هنوز روی این دستگاه فعال نشده</h2><p>رمز پنل را یک بار وارد کن؛ هم اتصال گیت‌هاب و هم محتوای رمزگذاری‌شده باز می‌شود.</p>" + unlockFormHTML("dunlock") + "</section>";
          bindUnlockForm("dunlock", function () { setTimeout(function () { withData(onReady); }, 300); });
        } else box.innerHTML = '<section class="card lilac-note" id="data-notoken"><div class="vi">' + ICON_LOCK + "</div><h2>اول توکن گیت‌هاب را اضافه کن</h2><p>این بخش با توکن گیت‌هاب ذخیره و خوانده می‌شود.</p><a class=\"go\" href=\"#/settings\">رفتن به تنظیمات</a></section>";
        return;
      }
      if (e.need === "net") {
        box.innerHTML = '<section class="card" id="data-neterr"><p>✗ ' + esc(e.message) + '</p><button class="ghost" id="dretry">دوباره</button></section>';
        document.getElementById("dretry").onclick = function () { DS.ring = undefined; withData(onReady); };
        return;
      }
      box.innerHTML = '<section class="card lilac-note form" id="data-unlock"><div class="vi">' + ICON_LOCK + "</div><h2>محتوای رمزگذاری‌شده</h2>" +
        "<p>برای باز کردن مغز متفکر، گالری و اطلاعات انتشار روی این دستگاه، رمز پنل را یک بار وارد کن.</p>" +
        '<form class="unlock-form" id="dpw-form" onsubmit="return false"><input type="text" name="username" autocomplete="username" hidden aria-hidden="true">' +
        '<label for="dpw">رمز پنل</label><div class="pw"><input id="dpw" type="password" autocomplete="current-password" required></div>' +
        '<button class="go" id="dpw-go" type="submit">باز کردن</button><div class="msg" id="dpw-msg">' + (e.need === "badpw" ? "✗ " + esc(e.message) : "") + "</div></form></section>";
      var f = document.getElementById("dpw-form");
      f.onsubmit = function (ev) {
        if (ev) ev.preventDefault();
        var pw = document.getElementById("dpw").value, m = document.getElementById("dpw-msg"), go = document.getElementById("dpw-go");
        if (!pw) return false;
        go.disabled = true; m.textContent = "در حال باز کردن…";
        ensureData(pw).then(function () { setSessPw(sessUser(), pw); box.innerHTML = ""; onReady(); },
          function (e2) { go.disabled = false; m.textContent = "✗ " + (e2.need === "badpw" ? e2.message : e2.need === "net" ? e2.message : (e2.message || "باز کردن ممکن نشد")); });
        return false;
      };
    }
  }
  function errBox(id, e) { var b = document.getElementById(id); if (b) b.innerHTML = '<div class="card"><p>✗ ' + esc(ghErrorFa(e)) + "</p></div>"; }
  var RUNNING = { at: 0, v: false };
  function publishRunning() {
    if (Date.now() - RUNNING.at < 30000) return Promise.resolve(RUNNING.v);
    return gh("/actions/workflows/publish.yml/runs?status=in_progress&per_page=1").then(function (d) { RUNNING = { at: Date.now(), v: !!(d && d.total_count) }; return RUNNING.v; }, function () { return false; });
  }
  // queue/<id>.json files (plain: publish.py must read them). Cached by blob sha (a sha never changes content).
  function loadQueue() {
    return gh("/contents/queue?ref=" + GH_BRANCH + "&t=" + Date.now()).catch(function (e) { if (e.status === 404) return []; throw e; }).then(function (files) {
      files = (files || []).filter(function (f) { return /\.json$/.test(f.name); });
      var cache = lsGet(QCACHE_LS, {}), keep = {}, out = [];
      return Promise.all(files.map(function (f) {
        var hit = cache[f.sha];
        var p = hit ? Promise.resolve(hit) : gh("/git/blobs/" + f.sha).then(function (b) { return JSON.parse(utf8b64dec(b.content)); });
        return p.then(function (j) { keep[f.sha] = j; var c = {}; for (var k in j) c[k] = j[k]; c._sha = f.sha; c._name = f.name; out.push(c); }, function () {});
      })).then(function () {
        lsSet(QCACHE_LS, keep);
        out.sort(function (a, b) { return (tsOf(b.publish_at) || 0) - (tsOf(a.publish_at) || 0); });
        return out;
      });
    });
  }
  function jobsMap(list) { var m = {}; (list || []).forEach(function (j) { m[j.id] = j; }); return m; }
  function loadReleaseAssets() {
    return gh("/releases/tags/" + GALLERY_TAG).then(function (r) { var s = {}; (r.assets || []).forEach(function (a) { s[a.name] = 1; }); return s; }, function (e) { if (e.status === 404) return {}; return null; });
  }

  // ============================================================= v8: «مغز متفکر» (#/brain)
  var BTYPES = [["idea", "ایده‌ها", "ایده"], ["scenario", "سناریوها", "سناریو"], ["script", "اسکریپت‌ها", "اسکریپت"]];
  var BNEXT = { idea: "scenario", scenario: "script" };
  var BTYPE_FA = { idea: "ایده", scenario: "سناریو", script: "اسکریپت" };
  var FORMATS = ["پست", "اسلاید", "ریل", "استوری", "ویدئو", "شورت", "لایو"];
  function brainHomeView() {
    app.innerHTML = shell("مغز متفکر", "#/", "صفحه‌ی اصلی") +
      '<div class="v8head brainhead"><span class="vi">' + ICON_BRAIN + '</span><div><h1>مغز متفکر</h1><p>پیشنهاد هارک، ایده، غربال‌گری و اسکریپت نهایی هر پیج</p></div></div>' +
      '<div id="dgate"></div><div id="v8body"></div>';
    bindShell();
    withData(function () {
      var body = document.getElementById("v8body"); body.innerHTML = '<div class="muted-note pad">در حال بارگذاری…</div>';
      var my = viewSeq;
      Promise.all(state.config.pages.map(function (cp) { return mergeHarkOut(cp.id).catch(function () { return 0; }).then(function () { return dsRead("brain-" + cp.id); }); })).then(function (res) {
        if (!live(my) || !document.getElementById("v8body")) return;
        body.innerHTML = '<div class="domlist" id="brain-domains">' + state.config.pages.map(function (cp, i) {
          var doc = bdoc(res[i]), items = doc.items, c = { idea: 0, scenario: 0, script: 0 };
          var rdy = doc.screen.filter(function (s) { return s.state === "ready"; }).length;
          items.forEach(function (it) { c[it.type] = (c[it.type] || 0) + 1; });
          return '<a class="dombox brain" href="#/brain/' + esc(cp.id) + '/hark" data-page="' + esc(cp.id) + '">' + logoHTML(cp, pageData(cp), "dlogo") +
            '<span class="dn"><b>' + esc(cp.name) + "</b><span>" + esc(cp.topic_fa || "") + "</span></span>" +
            '<span class="dc">' + fa(doc.hark.length) + " پیشنهاد هارک · " + fa(c.idea) + " ایده · " + fa(doc.screen.length) + " غربال‌گری" + (rdy ? " (" + fa(rdy) + " آماده)" : "") + " · " + fa(doc.final.length) + " نهایی</span></a>";
        }).join("") + "</div>" + '<p class="footnote privacy">' + esc(PRIVACY_NOTE) + "</p>";
      }).catch(function (e) { errBox("v8body", e); });
    });
  }
  function brainItemHTML(it, ctx) {
    var eff = ctx.sync.brain[it.id] || it.status, pid = it.page;
    var parent = it.parent_id && ctx.byId[it.parent_id];
    var kids = ctx.items.filter(function (x) { return x.parent_id === it.id; });
    var gals = ctx.gallery.filter(function (g) { return g.brain_id === it.id; });
    var links = "";
    if (parent) links += '<a class="lchip" href="#/brain/' + esc(pid) + "/" + parent.type + "?focus=" + esc(parent.id) + '">↖ از ' + BTYPE_FA[parent.type] + ": " + esc(parent.title) + "</a>";
    else if (it.parent_id) links += '<span class="lchip">↖ ' + esc(BTYPE_FA[it.type === "script" ? "scenario" : "idea"]) + " مبدأ پیدا نشد</span>";
    kids.forEach(function (k) { links += '<a class="lchip" href="#/brain/' + esc(pid) + "/" + k.type + "?focus=" + esc(k.id) + '">↘ ' + BTYPE_FA[k.type] + ": " + esc(k.title) + "</a>"; });
    var scr = it.screen_id && ctx.doc && findBy(ctx.doc.screen, "id", it.screen_id);
    if (scr) links += '<a class="lchip" href="#/brain/' + esc(pid) + "/screen?focus=" + esc(scr.id) + '">⇢ در غربال‌گری · ' + esc(SCREEN_ST[scr.state] || "") + "</a>";
    gals.forEach(function (g) { links += '<a class="lchip gal" href="#/gallery/' + esc(pid) + "/" + g.kind + "?focus=" + esc(g.id) + '">▣ گالری (' + KIND_FA[g.kind] + "): " + esc(g.title || g.id) + " · " + esc(stLabel("gallery", ctx.sync.gal[g.id] || g.status)) + "</a>"; });
    var nets = (it.networks || []).map(function (pl) { return PNAME[pl] ? '<span class="ntag">' + picon(pl) + PNAME[pl] + "</span>" : ""; }).join("");
    var body = it.body || "", long = body.length > 320 || (body.match(/\n/g) || []).length > 6;
    return '<article class="bitem" id="b-' + esc(it.id) + '" data-id="' + esc(it.id) + '" data-status="' + esc(eff) + '">' +
      '<div class="ih"><b class="it">' + esc(it.title || "(بدون عنوان)") + "</b>" + stChip("brain", eff) + "</div>" + stDots("brain", eff) +
      '<div class="im">' + (it.type === "idea" ? authorTag(it.author) : "") + nets + (it.format ? '<span class="ntag">' + esc(it.format) + "</span>" : "") + '<span class="when">' + esc(fmtShort(it.updated_at || it.created_at)) + "</span></div>" +
      (body ? '<div class="ibody' + (long ? " clamp" : "") + '">' + esc(body) + "</div>" + (long ? '<button class="linkbtn" data-act="more">نمایش کامل</button>' : "") : "") +
      (links ? '<div class="ilinks">' + links + "</div>" : "") +
      '<div class="iact">' + (it.type === "idea" ? (scr ? '<button class="go sm" disabled>فرستاده شد ✓</button>' : '<button class="go sm" data-act="screen">بفرست برای غربال‌گری</button>') : "") +
      '<button class="ghost sm" data-act="edit">ویرایش</button>' +
      (BNEXT[it.type] ? '<button class="ghost sm" data-act="promote">ارتقا به ' + BTYPE_FA[BNEXT[it.type]] + " ←</button>" : "") +
      '<a class="ghost sm" href="#/gallery/' + esc(pid) + "?brain=" + esc(it.id) + '">ساخت در گالری</a></div></article>';
  }
  function brainFormHTML(it, type) {
    it = it || {};
    var nets = PLATFORMS.map(function (pl) { return '<label class="chk"><input type="checkbox" name="bf-net" value="' + pl + '"' + ((it.networks || []).indexOf(pl) >= 0 ? " checked" : "") + ">" + picon(pl) + PNAME[pl] + "</label>"; }).join("");
    return '<form class="card form bform" id="bform" data-id="' + esc(it.id || "") + '" onsubmit="return false">' +
      "<h2>" + (it.id ? "ویرایش " : BTYPE_FA[type] + " جدید") + (it.id ? BTYPE_FA[it.type] : "") + "</h2>" +
      ((it.type || type) === "idea" ? '<label>نویسنده</label><div class="nets" role="radiogroup" id="bf-author">' + ["negin", "amirhossein"].concat(it.author === "hark" ? ["hark"] : []).map(function (a) {
        var cur = it.id ? (it.author || "") : (lsGet(AUTHOR_LS, "negin") || "negin");
        return '<label class="chk"><input type="radio" name="bf-author" value="' + a + '"' + (cur === a ? " checked" : "") + ">" + AUTHORS[a] + "</label>"; }).join("") + "</div>" : "") +
      '<label for="bf-title">عنوان</label><input id="bf-title" type="text" maxlength="200" required value="' + esc(it.title || "") + '">' +
      '<label for="bf-body">متن</label><textarea id="bf-body" rows="9" placeholder="متن کامل… (خط‌ها همان‌طور که می‌نویسی می‌مانند)">' + esc(it.body || "") + "</textarea>" +
      '<label>شبکه‌های هدف (اختیاری)</label><div class="nets">' + nets + "</div>" +
      '<label for="bf-format">فرمت (اختیاری)</label><select id="bf-format"><option value="">—</option>' + FORMATS.map(function (f) { return "<option" + (it.format === f ? " selected" : "") + ">" + f + "</option>"; }).join("") + "</select>" +
      '<label for="bf-status">وضعیت</label><select id="bf-status">' + ST.brain.map(function (s) { return '<option value="' + s[0] + '"' + ((it.status || (type === "idea" ? "idea" : "writing")) === s[0] ? " selected" : "") + ">" + s[1] + "</option>"; }).join("") + "</select>" +
      '<div class="row-btns"><button class="go" type="submit" id="bf-save">ذخیره</button><button class="ghost" type="button" id="bf-cancel">انصراف</button></div><div class="msg" id="bf-msg"></div></form>';
  }
  function brainWorkView(pid, tab) {
    var cp = cpById(pid); if (!cp) { location.hash = "#/brain"; return; }
    tab = V9TABS.some(function (t) { return t[0] === tab; }) ? tab : "hark";
    var q = hashQuery();
    app.innerHTML = shell("مغز متفکر · " + cp.name, "#/brain", "مغز متفکر") +
      '<div class="v8head brainhead sm">' + logoHTML(cp, pageData(cp), "dlogo") + "<div><h1>" + esc(cp.name) + "</h1><p>" + esc(cp.topic_fa || "") + "</p></div></div>" +
      '<div class="tabs" role="tablist">' + V9TABS.map(function (t) { return '<a role="tab" class="tab' + (t[0] === tab ? " on" : "") + '" href="#/brain/' + esc(pid) + "/" + t[0] + '" data-tab="' + t[0] + '">' + t[1] + ' <em id="cnt-' + t[0] + '"></em></a>'; }).join("") + "</div>" +
      '<div id="dgate"></div><div id="v8body"></div>';
    bindShell();
    withData(function () {
      var body = document.getElementById("v8body"); body.innerHTML = '<div class="muted-note pad">در حال بارگذاری…</div>';
      var my = viewSeq;
      mergeHarkOut(pid).catch(function () { return 0; }).then(function () { return Promise.all([dsRead("brain-" + pid), dsRead("gallery-" + pid).catch(function () { return null; }), dsRead("publish").catch(function () { return null; }), loadQueue().catch(function () { return []; }), publishRunning()]); }).then(function (r) {
        if (!live(my) || !document.getElementById("v8body")) return;
        var ctx = { doc: bdoc(r[0]), items: (r[0] && r[0].items) || [], gallery: (r[1] && r[1].items) || [], records: (r[2] && r[2].items) || {}, jobs: jobsMap(r[3]), running: r[4] };
        draw(ctx);
      }).catch(function (e) { errBox("v8body", e); });
    });
    function draw(ctx) {
      var body = document.getElementById("v8body"); if (!body) return;
      var openForm0 = document.getElementById("bform"); // a form being typed survives a redraw
      ctx.byId = {}; ctx.items.forEach(function (x) { ctx.byId[x.id] = x; });
      ctx.sync = syncStatuses({ brain: ctx.items, gallery: ctx.gallery, records: ctx.records, jobs: ctx.jobs }, Date.now(), ctx.running);
      ctx.doc = bdoc(ctx.doc); ctx.doc.items = ctx.items;
      BTYPES.forEach(function (t) { var e = document.getElementById("cnt-" + t[0]); if (e) e.textContent = fa(ctx.items.filter(function (x) { return x.type === t[0]; }).length); });
      [["hark", ctx.doc.hark], ["screen", ctx.doc.screen], ["final", ctx.doc.final]].forEach(function (p) { var e = document.getElementById("cnt-" + p[0]); if (e) e.textContent = fa(p[1].length); });
      if (V9NEW[tab]) { drawV9(pid, cp, tab, ctx, function () { draw(ctx); }); return; }
      var list = ctx.items.filter(function (x) { return x.type === tab; }).sort(function (a, b) { return (tsOf(b.updated_at) || 0) - (tsOf(a.updated_at) || 0); });
      var f = v8ui.bf[pid + tab] || "all", counts = { all: list.length };
      list.forEach(function (x) { var s = ctx.sync.brain[x.id]; counts[s] = (counts[s] || 0) + 1; });
      var shown = f === "all" ? list : list.filter(function (x) { return ctx.sync.brain[x.id] === f; });
      body.innerHTML = '<div class="v8bar"><button class="go" id="bnew">+ ' + BTYPE_FA[tab] + " جدید</button></div>" + '<div id="bform-wrap"></div>' +
        filterSeg("brain", f, counts) +
        '<div class="ilist" id="blist">' + (shown.length ? shown.map(function (x) { return brainItemHTML(x, ctx); }).join("") :
          '<div class="empty">' + (list.length ? "در این وضعیت چیزی نیست." : "هنوز " + BTYPE_FA[tab] + "ی ثبت نشده.") + "</div>") + "</div>" +
        '<p class="footnote privacy">' + esc(PRIVACY_NOTE) + "</p>";
      if (openForm0) document.getElementById("bform-wrap").appendChild(openForm0);
      document.getElementById("bnew").onclick = function () { openForm(null); };
      body.querySelector(".sfilter").onclick = function (e) { var b = e.target.closest("button[data-f]"); if (!b) return; v8ui.bf[pid + tab] = b.getAttribute("data-f"); draw(ctx); };
      document.getElementById("blist").onclick = function (e) {
        var b = e.target.closest("[data-act]"); if (!b) return;
        var card = b.closest(".bitem"), it = ctx.byId[card.getAttribute("data-id")];
        var act = b.getAttribute("data-act");
        if (act === "more") { var ib = card.querySelector(".ibody"); ib.classList.toggle("clamp"); b.textContent = ib.classList.contains("clamp") ? "نمایش کامل" : "بستن"; }
        else if (act === "edit") openForm(it);
        else if (act === "promote") promote(it, b);
        else if (act === "screen") {
          b.disabled = true;
          sendToScreening(pid, cp, { kind: "idea", id: it.id, title: it.title, body: it.body, author: it.author || "", networks: it.networks, format: it.format }, ctx)
            .then(function () { toast("برای غربال‌گری فرستاده شد ✓ (در صف هارک)"); draw(ctx); }, function (e2) { b.disabled = false; toast("✗ " + ghErrorFa(e2), 5000); });
        }
      };
      var focus = hashQuery().focus;
      if (focus) { var el = document.getElementById("b-" + focus); if (el) { el.classList.add("focus"); el.scrollIntoView({ block: "center" }); } }
      function openForm(it) {
        var w = document.getElementById("bform-wrap"); w.innerHTML = brainFormHTML(it, tab);
        var fm = document.getElementById("bform"); fm.scrollIntoView({ block: "start", behavior: "smooth" });
        setTimeout(function () { var t = document.getElementById("bf-title"); if (!t || fm.contains(document.activeElement)) return; try { t.focus({ preventScroll: true }); } catch (e) {} }, 50); // never steal focus from a field already being typed in
        document.getElementById("bf-cancel").onclick = function () { w.innerHTML = ""; };
        fm.onsubmit = function (ev) {
          if (ev) ev.preventDefault();
          var title = document.getElementById("bf-title").value.trim(), text = document.getElementById("bf-body").value.replace(/\r\n/g, "\n");
          var m = document.getElementById("bf-msg");
          if (!title) { m.textContent = "عنوان را بنویس."; return false; }
          var nets = Array.prototype.map.call(fm.querySelectorAll('input[name="bf-net"]:checked'), function (x) { return x.value; });
          var fields = { title: title, body: text, networks: nets, format: document.getElementById("bf-format").value, status: document.getElementById("bf-status").value };
          var au = fm.querySelector('input[name="bf-author"]:checked'); if (au) { fields.author = au.value; if (au.value !== "hark") lsSet(AUTHOR_LS, au.value); }
          var now = new Date().toISOString(), id = it ? it.id : newId("b");
          document.getElementById("bf-save").disabled = true; m.textContent = "در حال ذخیره (رمزگذاری‌شده)…";
          dsUpdate("brain-" + pid, function (d) {
            d = d || { items: [] };
            if (it) { var cur = d.items.filter(function (x) { return x.id === it.id; })[0]; if (!cur) { cur = JSON.parse(JSON.stringify(it)); d.items.push(cur); } for (var k in fields) cur[k] = fields[k]; cur.updated_at = now; }
            else { var n = { id: id, page: pid, type: tab, parent_id: "", created_at: now, updated_at: now }; for (var k2 in fields) n[k2] = fields[k2]; d.items.push(n); }
            return d;
          }, "data: brain " + pid).then(function (d) {
            ctx.doc = bdoc(d); ctx.items = d.items; toast("ذخیره شد ✓"); w.innerHTML = ""; draw(ctx);
          }, function (e) { document.getElementById("bf-save").disabled = false; m.textContent = "✗ " + ghErrorFa(e); });
          return false;
        };
      }
      function promote(it, btn) {
        var to = BNEXT[it.type]; if (!to) return;
        btn.disabled = true;
        var now = new Date().toISOString(), id = newId("b");
        dsUpdate("brain-" + pid, function (d) {
          d = d || { items: [] };
          d.items.push({ id: id, page: pid, type: to, parent_id: it.id, title: it.title, body: it.body || "", networks: (it.networks || []).slice(), format: it.format || "", status: "writing", created_at: now, updated_at: now });
          return d;
        }, "data: brain " + pid).then(function () {
          toast(BTYPE_FA[to] + " ساخته شد و به " + BTYPE_FA[it.type] + " وصل است ✓");
          location.hash = "#/brain/" + pid + "/" + to + "?focus=" + id;
        }, function (e) { btn.disabled = false; toast("✗ " + ghErrorFa(e), 5000); });
      }
    }
  }


  // ============================================================= v9: Hark channel + «پیشنهاد هارک / پیشنهاد ما / غربال‌گری / اسکریپت نهایی»
  // Panel -> Hark : hark/requests/<id>.json   ECIES to config/hark_pub.json  (HKDF info "sp-hark-req-v1", AAD "sp-hark-req-v1|<id>")
  // Hark  -> panel: hark/out/<page>/<id>.json ECIES to config/inbox_pub.json (HKDF info "sp-hark-out-v1", AAD "sp-hark-out-v1|<page>/<id>")
  // ECIES = ephemeral ECDH P-256 + HKDF-SHA256 (no salt) + AES-256-GCM, the same scheme as inbox/ (gallery-ingest.yml).
  // Outbox files are merged into the encrypted brain store (vault/brain-<page>.enc.json) after unlock, then deleted.
  // Brain store keys added in v9 (v8 keys untouched): hark[], hark_gone{}, screen[], final[], tool_links{}, hark_seen{}.
  var HARK_PUB_PATH = "config/hark_pub.json", HARK_REQ_DIR = "hark/requests", HARK_OUT_DIR = "hark/out";
  var HREQ = "sp-hark-req-v1", HOUT = "sp-hark-out-v1", ECIES_ALG = "ECDH-P256+HKDF-SHA256+A256GCM";
  var PROD_TOOLS = [["claude", "Claude"], ["gemini", "Gemini"], ["aistudio", "Google AI Studio"], ["chatgpt", "ChatGPT"], ["hark", "Hark"], ["flow", "Flow"], ["muse", "Muse"]];
  var PROD_NAME = {}; PROD_TOOLS.forEach(function (t) { PROD_NAME[t[0]] = t[1]; });
  var AUTHORS = { negin: "نگین", amirhossein: "امیرحسین", hark: "هارک" };
  var AUTHOR_LS = "sp_author";
  var SCREEN_ST = { queued: "در صف هارک", ready: "اسکریپت آماده", approved: "تأیید شد" };
  var JOB_ST = { queued: "در صف ساخت", done: "ساخته شد", error: "خطا" };
  var V9TABS = [["hark", "پیشنهاد هارک"], ["idea", "پیشنهاد ما"], ["screen", "غربال‌گری"], ["final", "اسکریپت نهایی"], ["scenario", "سناریوها"], ["script", "اسکریپت‌ها"]];
  var V9NEW = { hark: 1, screen: 1, final: 1 };
  var SCREEN_BRIEF = "این ایده را به یک اسکریپت حرفه‌ای و وایرال برای این پیج تبدیل کن، مطابق الگوریتم پلتفرم‌ها و ترندهای همین حالا: " +
    "هوک قوی در ۱ تا ۳ ثانیه‌ی اول، بیت‌های نگه‌داشت مخاطب (retention) در طول ویدئو، CTA روشن، کپشن و هشتگ‌ها، " +
    "و مدت مناسب هر پلتفرم (Instagram Reels / YouTube Shorts / TikTok).";
  var harkPubCache = null;
  function harkPub() {
    if (harkPubCache) return Promise.resolve(harkPubCache);
    return fetchRepoJSON(HARK_PUB_PATH).then(function (p) {
      if (!p || !p.jwk || !p.jwk.x || p.jwk.d) throw new Error("کلید عمومی هارک (config/hark_pub.json) پیدا نشد");
      harkPubCache = p; return p;
    });
  }
  function hkdfAes(bits, info, uses) {
    return crypto.subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]).then(function (h) {
      return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: TE.encode(info) }, h, { name: "AES-GCM", length: 256 }, false, uses);
    });
  }
  // encrypt a request for Hark (only the private key in Hark's sandbox opens it)
  function harkSeal(pub, id, payload, info, aad) {
    info = info || HREQ; aad = aad || HREQ + "|" + id;
    var EC = { name: "ECDH", namedCurve: "P-256" };
    return crypto.subtle.generateKey(EC, true, ["deriveBits"]).then(function (eph) {
      return crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: pub.jwk.x, y: pub.jwk.y }, EC, false, [])
        .then(function (pk) { return crypto.subtle.deriveBits({ name: "ECDH", public: pk }, eph.privateKey, 256); })
        .then(function (bits) { return hkdfAes(bits, info, ["encrypt"]); })
        .then(function (k) { return Promise.all([aesEnc(k, payload, aad), crypto.subtle.exportKey("jwk", eph.publicKey)]); })
        .then(function (r) {
          return { v: 1, id: id, kid: pub.kid, alg: ECIES_ALG, info: info, epk: { kty: "EC", crv: "P-256", x: r[1].x, y: r[1].y }, iv: r[0].iv, ct: r[0].ct, created_at: new Date().toISOString() };
        });
    });
  }
  // open a Hark -> panel envelope with the inbox private key (AAD binds it to its path)
  function harkOpen(env, aad) {
    var EC = { name: "ECDH", namedCurve: "P-256" };
    return crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: env.epk.x, y: env.epk.y }, EC, false, [])
      .then(function (epk) { return crypto.subtle.deriveBits({ name: "ECDH", public: epk }, DS.priv, 256); })
      .then(function (bits) { return hkdfAes(bits, HOUT, ["decrypt"]); })
      .then(function (k) { return aesDec(k, env.iv, env.ct, aad); });
  }
  function sendHarkRequest(payload) {
    return harkPub().then(function (pub) { return harkSeal(pub, payload.id, payload); })
      .then(function (env) { return putJSONFile(HARK_REQ_DIR + "/" + payload.id + ".json", env, "hark: request (" + payload.type + ")"); });
  }
  function bdoc(d) {
    d = d || { items: [] };
    d.items = d.items || []; d.hark = d.hark || []; d.hark_gone = d.hark_gone || {}; d.screen = d.screen || []; d.final = d.final || [];
    d.tool_links = d.tool_links || {}; d.hark_seen = d.hark_seen || {};
    return d;
  }
  function findBy(list, k, v) { for (var i = 0; i < (list || []).length; i++) if (list[i][k] === v) return list[i]; return null; }
  // apply one decrypted outbox message to the brain doc (idempotent)
  function applyHarkOut(d, m, pid, now) {
    d = bdoc(d);
    if (!m || !m.id || d.hark_seen[m.id]) return d;
    d.hark_seen[m.id] = now;
    var seen = Object.keys(d.hark_seen); if (seen.length > 400) seen.sort(function (a, b) { return String(d.hark_seen[a]).localeCompare(String(d.hark_seen[b])); }).slice(0, seen.length - 400).forEach(function (k) { delete d.hark_seen[k]; });
    if (m.type === "ideas") {
      (m.ideas || []).forEach(function (x) {
        if (!x || !String(x.title || "").trim()) return;
        var id = String(x.id || newId("h"));
        if (d.hark_gone[id] || findBy(d.hark, "id", id)) return;
        d.hark.push({ id: id, page: pid, title: String(x.title).trim(), body: String(x.body || ""), why: String(x.why || ""),
          networks: (x.networks || []).filter(function (pl) { return !!PNAME[pl]; }), format: String(x.format || ""), created_at: m.created_at || now, screen_id: "" });
      });
    } else if (m.type === "script") {
      var s = (m.screen_id && findBy(d.screen, "id", m.screen_id)) || (m.request_id && findBy(d.screen, "request_id", m.request_id));
      if (!s) { s = { id: m.screen_id || newId("s"), page: pid, title: (m.script && m.script.title) || "اسکریپت هارک", body: "", author: "", source: null, request_id: m.request_id || "", state: "queued", requested_at: m.created_at || now }; d.screen.push(s); }
      if (s.script && s.edited_at) {
        s.revisions = (s.revisions || []).concat([{ at: now, by: "hark", note: "نسخه‌ی تازه‌ی هارک جایگزین نسخه‌ی ویرایش‌شده شد", prev_text: screenText(s), prev: { title: s.title, body: s.body, script: s.script } }]).slice(-REV_MAX);
      }
      s.script = m.script || {}; s.ready_at = m.created_at || now;
      if (s.state !== "approved") s.state = "ready";
    } else if (m.type === "job_result") {
      var f = findBy(d.final, "id", m.final_id);
      if (f && m.tool) {
        f.jobs = f.jobs || {};
        var j = f.jobs[m.tool];
        if (!j || j.id === m.job_id || j.state !== "queued") // a newer queued job for this tool is not overwritten by an old result
          f.jobs[m.tool] = { id: m.job_id, state: m.state === "error" ? "error" : "done", requested_at: j && j.requested_at || "", done_at: m.created_at || now,
            reason: m.reason || "", gallery_id: m.gallery_id || "", gallery_kind: KIND_FA[m.gallery_kind] ? m.gallery_kind : "", output_url: /^https:\/\//.test(m.output_url || "") ? m.output_url : "", note: m.note || "" };
      }
    }
    return d;
  }
  // read hark/out/<page>/, decrypt, merge into vault/brain-<page>.enc.json, delete the merged files. Resolves the number merged.
  var harkBusy = {};
  function mergeHarkOut(pid) {
    if (harkBusy[pid]) return harkBusy[pid];
    var dir = HARK_OUT_DIR + "/" + pid;
    var p = gh("/contents/" + dir + "?ref=" + GH_BRANCH + "&t=" + Date.now()).catch(function (e) { if (e.status === 404) return []; throw e; }).then(function (files) {
      files = (Array.isArray(files) ? files : []).filter(function (f) { return /\.json$/.test(f.name); });
      if (!files.length) return 0;
      return Promise.all(files.map(function (f) {
        var id = f.name.replace(/\.json$/, "");
        return readRepoFile(dir + "/" + f.name).then(function (r) {
          if (!r.obj || !r.obj.epk || (r.obj.kid && r.obj.kid !== DS.kid)) return null;
          return harkOpen(r.obj, HOUT + "|" + pid + "/" + id).then(function (m) { m.id = id; return { name: f.name, sha: r.sha, msg: m }; });
        }).catch(function () { return null; }); // unreadable/tampered: left in place, never merged
      })).then(function (rows) {
        rows = rows.filter(function (x) { return x && x.msg && x.msg.type !== "identity"; }); // «هویت» messages are merged by the identity page
        if (!rows.length) return 0;
        rows.sort(function (a, b) { return String(a.msg.created_at || "").localeCompare(String(b.msg.created_at || "")); });
        return dsUpdate("brain-" + pid, function (d) {
          var now = new Date().toISOString(); rows.forEach(function (x) { d = applyHarkOut(d, x.msg, pid, now); }); return d;
        }, "data: brain " + pid + " (hark)").then(function () {
          return Promise.all(rows.map(function (x) {
            return gh("/contents/" + dir + "/" + x.name, { method: "DELETE", body: { message: "hark: merged " + x.name, sha: x.sha, branch: GH_BRANCH } }).catch(function () {});
          }));
        }).then(function () { return rows.length; });
      });
    });
    harkBusy[pid] = p.then(function (n) { harkBusy[pid] = null; return n; }, function (e) { harkBusy[pid] = null; throw e; });
    return harkBusy[pid];
  }
  function copyText(t) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(t).catch(function () { return legacy(); });
    return Promise.resolve(legacy());
    function legacy() {
      // iOS Safari: an editable (not readonly) textarea selected through a Range + setSelectionRange, font ≥ 16px (no zoom)
      var ta = document.createElement("textarea"); ta.value = t; ta.contentEditable = "true"; ta.readOnly = false;
      ta.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;font-size:16px;border:0;padding:0";
      document.body.appendChild(ta);
      try { var rg = document.createRange(); rg.selectNodeContents(ta); var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(rg); } catch (e) {}
      ta.focus(); ta.select(); try { ta.setSelectionRange(0, t.length); } catch (e) {}
      var ok = false; try { ok = document.execCommand("copy"); } catch (e) {}
      document.body.removeChild(ta);
      if (!ok) throw new Error("copy failed");
    }
  }
  // last resort when the clipboard is refused: the text pre-selected in a sheet, for a manual long-press «Copy»
  function copyBox(t) {
    var old = document.getElementById("copybox"); if (old) old.remove();
    var d = document.createElement("div"); d.id = "copybox"; d.className = "ovl";
    d.innerHTML = '<div class="ovl-card"><b>کپی خودکار ممکن نشد؛ متن انتخاب شده — نگه دار و «Copy» را بزن.</b><textarea dir="auto" rows="12"></textarea><button class="go" type="button">بستن</button></div>';
    d.querySelector("textarea").value = t; document.body.appendChild(d);
    d.querySelector("button").onclick = function () { d.remove(); };
    d.onclick = function (e) { if (e.target === d) d.remove(); };
    var ta = d.querySelector("textarea"); ta.focus(); ta.select(); try { ta.setSelectionRange(0, t.length); } catch (e) {}
  }
  function copyWithToast(t) {
    return copyText(t).then(function () { toast("کپی شد ✓"); }, function () { copyBox(t); });
  }
  var PLAT_LEN = [["reels", "Instagram Reels"], ["shorts", "YouTube Shorts"], ["tiktok", "TikTok"]];
  function beatsOf(sc) {
    return (sc.beats || []).map(function (b) {
      if (b && typeof b === "object") return { t: String(b.t || b.time || ""), text: String(b.text || b.line || b.beat || "") };
      return { t: "", text: String(b) };
    });
  }
  function tagsOf(sc) {
    var h = sc.hashtags || []; if (typeof h === "string") h = h.split(/\s+/);
    return h.filter(Boolean).map(function (x) { x = String(x).trim(); return x.charAt(0) === "#" ? x : "#" + x; });
  }
  function lenOf(v) { if (!v) return ""; if (typeof v === "object") return [v.length || v.duration || "", v.note || ""].filter(Boolean).join(" — "); return String(v); }
  // the full, paste-ready text of a screened script (what goes to the production tools and «کپی متن»)
  function scriptText(sc, title) {
    sc = sc || {};
    var out = [], bt = beatsOf(sc), tags = tagsOf(sc), lens = sc.platforms || sc.lengths || {};
    out.push(sc.title || title || "");
    if (sc.hook) out.push("", "هوک (۰ تا ۳ ثانیه‌ی اول):", sc.hook);
    if (bt.length) { out.push("", "بیت‌های نگه‌داشت:"); bt.forEach(function (b, i) { out.push((i + 1) + ". " + (b.t ? "[" + b.t + "] " : "") + b.text); }); }
    if (sc.cta) out.push("", "CTA:", sc.cta);
    if (sc.text) out.push("", "متن کامل اسکریپت:", sc.text);
    if (sc.caption) out.push("", "کپشن:", sc.caption);
    if (tags.length) out.push("", "هشتگ‌ها:", tags.join(" "));
    var ls = PLAT_LEN.filter(function (p) { return lens[p[0]]; }).map(function (p) { return p[1] + ": " + lenOf(lens[p[0]]); });
    if (ls.length) out.push("", "مدت هر پلتفرم:", ls.join("\n"));
    if (sc.trend || sc.notes) out.push("", "ترند / نکته:", sc.trend || sc.notes);
    return out.join("\n").trim();
  }
  function scriptHTML(sc) {
    sc = sc || {};
    var bt = beatsOf(sc), tags = tagsOf(sc), lens = sc.platforms || sc.lengths || {}, h = "";
    if (sc.hook) h += '<div class="scr-sec hook"><b>هوک · ۰ تا ۳ ثانیه</b><p>' + esc(sc.hook) + "</p></div>";
    if (bt.length) h += '<div class="scr-sec"><b>بیت‌های نگه‌داشت</b><ol>' + bt.map(function (b) { return "<li>" + (b.t ? '<span class="bt">' + esc(b.t) + "</span> " : "") + esc(b.text) + "</li>"; }).join("") + "</ol></div>";
    if (sc.cta) h += '<div class="scr-sec"><b>CTA</b><p>' + esc(sc.cta) + "</p></div>";
    if (sc.text) h += '<div class="scr-sec"><b>متن کامل</b><div class="ibody clamp">' + esc(sc.text) + '</div><button class="linkbtn" data-act="more">نمایش کامل</button></div>';
    if (sc.caption) h += '<div class="scr-sec"><b>کپشن</b><p>' + esc(sc.caption) + "</p></div>";
    if (tags.length) h += '<div class="scr-sec"><b>هشتگ‌ها</b><div class="htags">' + tags.map(function (t) { return '<span dir="auto">' + esc(t) + "</span>"; }).join("") + "</div></div>";
    var ls = PLAT_LEN.filter(function (p) { return lens[p[0]]; });
    if (ls.length) h += '<div class="scr-sec"><b>مدت هر پلتفرم</b><div class="plens">' + ls.map(function (p) { return '<span><i dir="ltr">' + esc(p[1]) + "</i> " + esc(lenOf(lens[p[0]])) + "</span>"; }).join("") + "</div></div>";
    if (sc.trend || sc.notes) h += '<div class="scr-sec"><b>ترند / نکته</b><p>' + esc(sc.trend || sc.notes) + "</p></div>";
    return '<div class="scr">' + (h || '<p class="muted-note">اسکریپت خالی است.</p>') + "</div>";
  }

  // ---- v10: edit + copy + revision history for «غربال‌گری» and «اسکریپت نهایی»
  var REV_MAX = 30;
  function screenText(s) { return s && s.script ? scriptText(s.script, s.title) : [s && s.title || "", s && s.body || ""].filter(Boolean).join("\n\n"); }
  function finalText(f) { return f.text || scriptText(f.script, f.title); }
  function editorOf() { var a = lsGet(AUTHOR_LS, "negin"); return a === "amirhossein" ? a : "negin"; }
  function lastEditHTML(x) {
    if (!x.edited_at) return "";
    return '<p class="edmeta">✎ آخرین اصلاح: <b>' + esc(AUTHORS[x.edited_by] || x.edited_by || "") + "</b> · " + esc(fmtShort(x.edited_at)) + (x.edit_note ? '<span class="enote">نظر/اصلاحیه: ' + esc(x.edit_note) + "</span>" : "") + "</p>";
  }
  function editBtnsHTML(x) {
    var n = (x.revisions || []).length;
    return '<button class="ghost sm" data-act="edit">ویرایش</button><button class="ghost sm" data-act="copy">کپی</button>' +
      (n ? '<button class="ghost sm" data-act="hist">تاریخچه (' + fa(n) + ")</button>" : "");
  }
  function revsHTML(x) {
    var r = (x.revisions || []).slice().reverse();
    if (!r.length) return "";
    return '<div class="revs" hidden><b class="rt">تاریخچه‌ی اصلاحات</b>' + r.map(function (v) {
      return '<div class="rev"><div class="rh"><span class="atag a-' + esc(v.by) + '">' + esc(AUTHORS[v.by] || v.by || "؟") + "</span> " + esc(fmtShort(v.at)) + "</div>" +
        (v.note ? '<p class="rnote">نظر/اصلاحیه: ' + esc(v.note) + "</p>" : "") +
        '<details><summary>متن پیش از این اصلاح</summary><div class="ibody">' + esc(v.prev_text || "") + "</div></details></div>";
    }).join("") + "</div>";
  }
  function beatsLines(sc) { return beatsOf(sc || {}).map(function (b) { return (b.t ? b.t + " | " : "") + b.text; }).join("\n"); }
  function parseBeats(txt) {
    return String(txt || "").split("\n").map(function (l) { return l.trim(); }).filter(Boolean).map(function (l) {
      var m = /^([^|]{1,12})\s*\|\s*(.+)$/.exec(l); return m ? { t: m[1].trim(), text: m[2].trim() } : { t: "", text: l };
    });
  }
  // the inline editor; withScript = edit the script fields, otherwise the idea (title + text) of a queued item
  function editFormHTML(x, withScript) {
    var me = editorOf(), uid = esc(x.id), sc = (withScript && x.script) || {}, ls = sc.platforms || sc.lengths || {};
    var fld = function (f, label, val, rows, ltr) {
      return "<label>" + label + "</label>" + (rows ? '<textarea data-f="' + f + '" rows="' + rows + '" dir="auto">' + esc(val || "") + "</textarea>"
        : '<input type="text" data-f="' + f + '"' + (ltr ? ' dir="auto"' : "") + ' value="' + esc(val || "") + '">');
    };
    var h = '<div class="form edform"><div class="edh">ویرایش ' + (withScript ? "اسکریپت" : "ایده") + "</div>" +
      '<label>ویرایش‌کننده</label><div class="nets" role="radiogroup">' + ["negin", "amirhossein"].map(function (a) {
        return '<label class="chk"><input type="radio" name="ed-au-' + uid + '" value="' + a + '"' + (me === a ? " checked" : "") + ">" + AUTHORS[a] + "</label>"; }).join("") + "</div>";
    if (withScript) {
      h += fld("title", "عنوان", sc.title || x.title) + fld("hook", "هوک (۰ تا ۳ ثانیه‌ی اول)", sc.hook, 2) +
        fld("beats", "بیت‌های نگه‌داشت (هر بیت یک خط؛ زمان اختیاری: «0:03 | متن»)", beatsLines(sc), 4) + fld("cta", "CTA", sc.cta, 2) +
        fld("text", "متن کامل اسکریپت", sc.text, 8) + fld("caption", "کپشن", sc.caption, 3) + fld("hashtags", "هشتگ‌ها (با فاصله یا خط جدا)", tagsOf(sc).join(" "), 2) +
        '<div class="plen3">' + PLAT_LEN.map(function (p) { return '<div><label dir="ltr">' + p[1] + '</label><input type="text" data-f="len-' + p[0] + '" value="' + esc(lenOf(ls[p[0]])) + '"></div>'; }).join("") + "</div>" +
        fld("trend", "ترند / نکته", sc.trend || sc.notes, 2);
    } else h += fld("title", "عنوان", x.title) + fld("body", "متن ایده", x.body, 7);
    return h + fld("note", "نظر / اصلاحیه (اختیاری)", "", 2) +
      '<div class="row-btns"><button class="go sm" type="button" data-act="esave">ثبت اصلاحات</button><button class="ghost sm" type="button" data-act="ecancel">انصراف</button></div><div class="msg"></div></div>';
  }
  function readEditForm(box, x, withScript) {
    var v = function (f) { var e = box.querySelector('[data-f="' + f + '"]'); return e ? e.value.replace(/\r\n/g, "\n").trim() : ""; };
    var au = box.querySelector('input[type="radio"]:checked');
    var ed = { author: au ? au.value : editorOf(), note: v("note") };
    if (withScript) {
      var sc = JSON.parse(JSON.stringify(x.script || {}));
      sc.title = v("title"); sc.hook = v("hook"); sc.beats = parseBeats(v("beats")); sc.cta = v("cta"); sc.text = v("text"); sc.caption = v("caption");
      sc.hashtags = v("hashtags").split(/[\s,،]+/).filter(Boolean).map(function (t) { return t.charAt(0) === "#" ? t : "#" + t; });
      var pl = {}; PLAT_LEN.forEach(function (p) { var l = v("len-" + p[0]); if (l) pl[p[0]] = l; }); sc.platforms = pl; delete sc.lengths;
      sc.trend = v("trend"); delete sc.notes;
      ed.script = sc; ed.title = sc.title;
    } else { ed.title = v("title"); ed.body = v("body"); }
    return ed;
  }
  // apply an edit to a screening (kind "screen") or final (kind "final") item, keeping the previous version in .revisions
  function applyEdit(cur, ed, kind, now) {
    var prevText = kind === "final" ? finalText(cur) : screenText(cur);
    var prev = kind === "final" ? { title: cur.title, script: cur.script || {}, text: cur.text || "" } : { title: cur.title, body: cur.body || "", script: cur.script || null };
    cur.revisions = (cur.revisions || []).concat([{ at: now, by: ed.author, note: ed.note || "", prev_text: prevText, prev: prev }]).slice(-REV_MAX);
    if (ed.script) { cur.script = ed.script; if (kind === "final") cur.title = ed.script.title || cur.title; }
    else { cur.title = ed.title; cur.body = ed.body; }
    if (kind === "final") cur.text = scriptText(cur.script, cur.title);
    cur.edited_at = now; cur.edited_by = ed.author; cur.edit_note = ed.note || "";
    return cur;
  }
  function authorTag(a) { return AUTHORS[a] ? '<span class="atag a-' + esc(a) + '">' + esc(AUTHORS[a]) + "</span>" : ""; }
  function v9Body(text) {
    var long = text.length > 320 || (text.match(/\n/g) || []).length > 6;
    return text ? '<div class="ibody' + (long ? " clamp" : "") + '">' + esc(text) + "</div>" + (long ? '<button class="linkbtn" data-act="more">نمایش کامل</button>' : "") : "";
  }
  function harkItemHTML(it, doc) {
    var s = it.screen_id && findBy(doc.screen, "id", it.screen_id);
    var nets = (it.networks || []).map(function (pl) { return PNAME[pl] ? '<span class="ntag">' + picon(pl) + PNAME[pl] + "</span>" : ""; }).join("");
    return '<article class="bitem hitem" id="b-' + esc(it.id) + '" data-id="' + esc(it.id) + '">' +
      '<div class="ih"><b class="it">' + esc(it.title) + '</b><span class="atag a-hark">هارک</span></div>' +
      '<div class="im">' + nets + (it.format ? '<span class="ntag">' + esc(it.format) + "</span>" : "") + '<span class="when">' + esc(fmtShort(it.created_at)) + "</span></div>" +
      v9Body(it.body || "") + (it.why ? '<p class="why">چرا: ' + esc(it.why) + "</p>" : "") +
      (s ? '<div class="ilinks"><a class="lchip" href="#/brain/' + esc(it.page) + "/screen?focus=" + esc(s.id) + '">⇢ در غربال‌گری · ' + esc(SCREEN_ST[s.state] || "") + "</a></div>" : "") +
      '<div class="iact">' + (s ? '<button class="go sm" disabled>فرستاده شد ✓</button>' : '<button class="go sm" data-act="screen">بفرست برای غربال‌گری</button>') +
      '<button class="ghost sm" data-act="move">انتقال به ایده‌های من</button><button class="ghost sm danger" data-act="del">حذف</button></div></article>';
  }
  function screenItemHTML(s) {
    var st = s.state || "queued";
    var src = s.source && s.source.kind === "hark" ? '<span class="atag a-hark">پیشنهاد هارک</span>' : authorTag(s.author);
    return '<article class="bitem sitem" id="b-' + esc(s.id) + '" data-id="' + esc(s.id) + '" data-state="' + esc(st) + '">' +
      '<div class="ih"><b class="it">' + esc((s.script && s.script.title) || s.title || "(بدون عنوان)") + '</b><span class="schip v9-' + esc(st) + '">' + esc(SCREEN_ST[st] || st) + "</span></div>" +
      '<div class="sdots v9-' + esc(st) + '"><i class="on"></i><i class="' + (st !== "queued" ? "on" : "") + '"></i><i class="' + (st === "approved" ? "on" : "") + '"></i></div>' +
      '<div class="im">' + src + '<span class="when">فرستاده: ' + esc(fmtShort(s.requested_at)) + (s.ready_at ? " · آماده: " + esc(fmtShort(s.ready_at)) : "") + "</span></div>" +
      (s.body ? '<details class="orig"><summary>ایده‌ی اصلی</summary>' + v9Body(s.body) + "</details>" : "") +
      (st === "queued" ? '<p class="muted-note">هارک این ایده را به یک اسکریپت وایرال تبدیل می‌کند: هوک ۱ تا ۳ ثانیه‌ی اول، بیت‌های نگه‌داشت، CTA، کپشن و هشتگ، و مدت مناسب Reels / Shorts / TikTok.</p>' : scriptHTML(s.script)) +
      (s.final_id ? '<div class="ilinks"><a class="lchip pub" href="#/brain/' + esc(s.page) + "/final?focus=" + esc(s.final_id) + '">✓ در اسکریپت نهایی</a></div>' : "") +
      lastEditHTML(s) +
      '<div class="iact"><button class="go sm" data-act="approve"' + (st === "ready" ? "" : " disabled") + ">تأیید و انتقال به اسکریپت نهایی</button>" + editBtnsHTML(s) + "</div>" +
      '<div class="editwrap"></div>' + revsHTML(s) + "</article>";
  }
  function jobChipHTML(j, pid) {
    if (!j) return "";
    if (j.state === "done") {
      var href = j.gallery_id ? "#/gallery/" + esc(pid) + (j.gallery_kind ? "/" + esc(j.gallery_kind) : "") + "?focus=" + esc(j.gallery_id) : j.output_url ? esc(j.output_url) : "";
      return href ? '<a class="jchip j-done" href="' + href + '"' + (j.gallery_id ? "" : ' target="_blank" rel="noopener"') + ">ساخته شد ↗</a>" : '<span class="jchip j-done">ساخته شد</span>';
    }
    return '<span class="jchip j-' + esc(j.state) + '">' + esc(JOB_ST[j.state] || j.state) + "</span>";
  }
  function finalItemHTML(f, links) {
    var jobs = f.jobs || {};
    var rows = PROD_TOOLS.map(function (t) {
      var j = jobs[t[0]], url = links[t[0]] || "", q = j && j.state === "queued";
      return '<div class="ptool" data-tool="' + t[0] + '"><span class="tbadge" style="background:' + (TOOL_COLORS[t[0]] || "#64748b") + '">' + esc(t[1].replace(/^Google\s+/, "").charAt(0)) + "</span>" +
        '<span class="pn"><b dir="ltr">' + esc(t[1]) + "</b><small>" + (url ? '<a href="' + esc(url) + '" target="_blank" rel="noopener" dir="ltr">' + esc(hostOf(url)) + "</a>" : "لینک پروژه تنظیم نشده") + "</small></span>" +
        jobChipHTML(j, f.page) +
        '<button class="' + (j ? "ghost" : "go") + ' sm" data-act="send" data-tool="' + t[0] + '"' + (q ? " disabled" : "") + ">" + (q ? "در صف…" : j ? "ارسال دوباره" : "ارسال") + "</button>" +
        (j && j.state === "error" ? '<div class="jerr">✗ ' + esc(j.reason || "خطای نامشخص") + "</div>" : "") + "</div>";
    }).join("");
    return '<article class="bitem fitem" id="b-' + esc(f.id) + '" data-id="' + esc(f.id) + '">' +
      '<div class="ih"><b class="it">' + esc(f.title || "(بدون عنوان)") + '</b><span class="schip v9-approved">آماده‌ی ساخت</span></div>' +
      '<div class="im"><span class="when">' + esc(fmtShort(f.created_at)) + "</span></div>" + v9Body(f.text || "") + lastEditHTML(f) +
      '<div class="iact"><button class="go sm" data-act="sendall">ارسال به همه</button>' + editBtnsHTML(f) + "</div>" +
      '<div class="editwrap"></div>' + revsHTML(f) +
      '<div class="ptools" aria-label="ابزارهای ساخت">' + rows + "</div></article>";
  }
  function toolLinksHTML(cp, links) {
    var any = PROD_TOOLS.some(function (t) { return links[t[0]]; });
    return '<details class="card form tlinks" id="tlinks"' + (any ? "" : " open") + "><summary>لینک پروژه‌ی هر ابزار برای " + '<b dir="ltr">' + esc(cp.name) + "</b></summary>" +
      '<p class="help">پوشه/پروژه‌ای که پرامپت‌ها و بریف محتوای این پیج در آن است. هارک همین لینک را باز می‌کند، اسکریپت را می‌چسباند و خروجی را به گالری می‌آورد. اگر لینک نباشد، هارک دنبال پروژه‌ای به اسم <b dir="ltr">' + esc(cp.name) + "</b> می‌گردد.</p>" +
      PROD_TOOLS.map(function (t) { return '<label for="tl-' + t[0] + '" dir="ltr" class="tl-l">' + esc(t[1]) + '</label><input id="tl-' + t[0] + '" data-tool="' + t[0] + '" type="text" dir="ltr" inputmode="url" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="https://…" value="' + esc(links[t[0]] || "") + '">'; }).join("") +
      '<div class="row-btns"><button class="go" type="button" id="tl-save">ذخیره‌ی لینک‌ها</button></div><div class="msg" id="tl-msg"></div></details>';
  }
  // draws the three v9 tabs into #v8body; ctx = brainWorkView's ctx (ctx.doc = the whole brain doc)
  function drawV9(pid, cp, tab, ctx, redraw) {
    var body = document.getElementById("v8body"); if (!body) return;
    var d = ctx.doc, html = "";
    if (tab === "hark") {
      var hl = d.hark.slice().sort(function (a, b) { return String(b.created_at).localeCompare(String(a.created_at)); });
      html = '<p class="v9intro">ایده‌هایی که هارک برای این پیج نوشته. هر کدام را بفرست برای غربال‌گری، به ایده‌های خودت ببر، یا حذف کن.</p>' +
        '<div class="ilist" id="blist">' + (hl.length ? hl.map(function (x) { return harkItemHTML(x, d); }).join("") : '<div class="empty">هنوز هارک پیشنهادی برای این پیج نفرستاده.</div>') + "</div>";
    } else if (tab === "screen") {
      var sl = d.screen.slice().sort(function (a, b) { return String(b.requested_at).localeCompare(String(a.requested_at)); });
      html = '<p class="v9intro">ایده‌هایی که برای غربال‌گری فرستادی. هارک هر کدام را به یک اسکریپت حرفه‌ای و وایرال تبدیل می‌کند؛ بعد از تأیید به «اسکریپت نهایی» می‌رود.</p>' +
        '<div class="ilist" id="blist">' + (sl.length ? sl.map(screenItemHTML).join("") : '<div class="empty">هنوز چیزی برای غربال‌گری نفرستادی.</div>') + "</div>";
    } else {
      var fl = d.final.slice().sort(function (a, b) { return String(b.created_at).localeCompare(String(a.created_at)); });
      html = toolLinksHTML(cp, d.tool_links) +
        '<div class="ilist" id="blist">' + (fl.length ? fl.map(function (x) { return finalItemHTML(x, d.tool_links); }).join("") : '<div class="empty">هنوز اسکریپتی تأیید نشده.</div>') + "</div>";
    }
    body.innerHTML = html + '<p class="footnote privacy">' + esc(PRIVACY_NOTE) + " درخواست‌ها به هارک و پاسخ‌های هارک هم رمزگذاری‌شده‌اند (فقط هارک و پنل بازشان می‌کنند).</p>";
    var save = function (fn, msg) { return dsUpdate("brain-" + pid, function (x) { return fn(bdoc(x)); }, msg || "data: brain " + pid).then(function (nd) { ctx.doc = bdoc(nd); ctx.items = ctx.doc.items; return nd; }); };
    var ts = document.getElementById("tl-save");
    if (ts) ts.onclick = function () {
      var m = document.getElementById("tl-msg"), next = {}, bad = "";
      Array.prototype.forEach.call(document.querySelectorAll("#tlinks input[data-tool]"), function (inp) {
        var v = inp.value.trim(); if (!v) return;
        if (!/^https?:\/\//i.test(v)) v = "https://" + v;
        if (!/^https?:\/\/[^\s/]+\.[^\s]+/i.test(v)) bad = PROD_NAME[inp.getAttribute("data-tool")];
        next[inp.getAttribute("data-tool")] = v;
      });
      if (bad) { m.textContent = "✗ لینک " + bad + " شبیه یک آدرس نیست."; return; }
      ts.disabled = true; m.textContent = "در حال ذخیره (رمزگذاری‌شده)…";
      save(function (x) { x.tool_links = next; return x; }).then(function () { toast("لینک‌ها ذخیره شد ✓"); redraw(); }, function (e) { ts.disabled = false; m.textContent = "✗ " + ghErrorFa(e); });
    };
    document.getElementById("blist").onclick = function (e) {
      var b = e.target.closest("[data-act]"); if (!b || b.disabled) return;
      var card = b.closest(".bitem"), id = card && card.getAttribute("data-id"), act = b.getAttribute("data-act");
      if (act === "more") { var ib = b.parentNode.querySelector(".ibody"); ib.classList.toggle("clamp"); b.textContent = ib.classList.contains("clamp") ? "نمایش کامل" : "بستن"; return; }
      if (tab === "screen" || tab === "final") {
        var list = tab === "screen" ? d.screen : d.final, it = findBy(list, "id", id), wrap = card.querySelector(".editwrap");
        var withScript = tab === "final" || !!(it && it.script);
        if (it && act === "copy") { copyWithToast(tab === "final" ? finalText(it) : screenText(it)); return; }
        if (it && act === "hist") { var rv = card.querySelector(".revs"); if (rv) { rv.hidden = !rv.hidden; b.classList.toggle("on", !rv.hidden); } return; }
        if (it && act === "edit") {
          if (wrap.firstChild) { wrap.innerHTML = ""; return; }
          wrap.innerHTML = editFormHTML(it, withScript);
          var f0 = wrap.querySelector('[data-f="title"]'); wrap.scrollIntoView({ block: "nearest" }); try { f0.focus({ preventScroll: true }); } catch (e3) {}
          return;
        }
        if (act === "ecancel") { wrap.innerHTML = ""; return; }
        if (it && act === "esave") {
          var ed = readEditForm(wrap, it, withScript), em = wrap.querySelector(".msg");
          if (!ed.title) { em.textContent = "عنوان را بنویس."; return; }
          lsSet(AUTHOR_LS, ed.author);
          b.disabled = true; em.textContent = "در حال ذخیره (رمزگذاری‌شده)…";
          var nowE = new Date().toISOString();
          save(function (x) {
            var cur = findBy(tab === "screen" ? x.screen : x.final, "id", id); if (!cur) throw new Error("این آیتم دیگر وجود ندارد");
            applyEdit(cur, ed, tab, nowE); return x;
          }).then(function () { toast("اصلاحات ثبت شد ✓"); redraw(); }, function (e2) { b.disabled = false; em.textContent = "✗ " + ghErrorFa(e2); });
          return;
        }
      }
      if (tab === "hark") {
        var h = findBy(d.hark, "id", id); if (!h) return;
        if (act === "screen") { b.disabled = true; sendToScreening(pid, cp, { kind: "hark", id: h.id, title: h.title, body: h.body, author: "hark", networks: h.networks, format: h.format }, ctx).then(function () { toast("برای غربال‌گری فرستاده شد ✓ (در صف هارک)"); redraw(); }, function (e2) { b.disabled = false; toast("✗ " + ghErrorFa(e2), 5000); }); }
        else if (act === "del") {
          if (!confirm("این پیشنهاد هارک حذف شود؟")) return;
          b.disabled = true;
          save(function (x) { x.hark = x.hark.filter(function (y) { return y.id !== id; }); x.hark_gone[id] = new Date().toISOString(); return x; }).then(function () { toast("حذف شد"); redraw(); }, function (e2) { b.disabled = false; toast("✗ " + ghErrorFa(e2), 5000); });
        } else if (act === "move") {
          b.disabled = true; var nid = newId("b"), now = new Date().toISOString();
          save(function (x) {
            var cur = findBy(x.hark, "id", id) || h;
            x.items.push({ id: nid, page: pid, type: "idea", parent_id: "", title: cur.title, body: cur.body || "", networks: (cur.networks || []).slice(), format: cur.format || "", status: "idea",
              author: "hark", from_hark: cur.id, screen_id: cur.screen_id || "", created_at: now, updated_at: now });
            x.hark = x.hark.filter(function (y) { return y.id !== id; }); x.hark_gone[id] = now;
            x.screen.forEach(function (s) { if (s.source && s.source.kind === "hark" && s.source.id === id) s.source = { kind: "idea", id: nid, from_hark: id }; });
            return x;
          }).then(function () { toast("به «پیشنهاد ما» منتقل شد ✓"); location.hash = "#/brain/" + pid + "/idea?focus=" + nid; }, function (e2) { b.disabled = false; toast("✗ " + ghErrorFa(e2), 5000); });
        }
      } else if (tab === "screen" && act === "approve") {
        var s = findBy(d.screen, "id", id); if (!s || s.state !== "ready") return;
        b.disabled = true; var fid = newId("f"), now2 = new Date().toISOString();
        save(function (x) {
          var cur = findBy(x.screen, "id", id); if (!cur) throw new Error("این آیتم دیگر در غربال‌گری نیست");
          if (cur.final_id) { fid = cur.final_id; return x; }
          cur.state = "approved"; cur.final_id = fid; cur.approved_at = now2;
          x.final.push({ id: fid, page: pid, screen_id: cur.id, title: (cur.script && cur.script.title) || cur.title, text: scriptText(cur.script, cur.title), script: cur.script || {}, created_at: now2, jobs: {} });
          return x;
        }).then(function () { toast("به «اسکریپت نهایی» منتقل شد ✓"); location.hash = "#/brain/" + pid + "/final?focus=" + fid; }, function (e2) { b.disabled = false; toast("✗ " + ghErrorFa(e2), 5000); });
      } else if (tab === "final") {
        var f = findBy(d.final, "id", id); if (!f) return;
        if (act === "send") { b.disabled = true; produce(pid, cp, f, [b.getAttribute("data-tool")], save).then(function (r) { reportProduce(r); redraw(); }, function (e2) { b.disabled = false; toast("✗ " + ghErrorFa(e2), 5000); }); }
        else if (act === "sendall") {
          var tools = PROD_TOOLS.map(function (t) { return t[0]; }).filter(function (t) { return !(f.jobs && f.jobs[t] && f.jobs[t].state === "queued"); });
          if (!tools.length) { toast("همه‌ی ابزارها همین حالا در صف ساخت‌اند"); return; }
          var nol = tools.filter(function (t) { return !d.tool_links[t]; });
          if (!confirm("ارسال برای " + fa(tools.length) + " ابزار: " + tools.map(function (t) { return PROD_NAME[t]; }).join("، ") + (nol.length ? "\nبدون لینک پروژه (هارک دنبال پروژه‌ای به اسم این پیج می‌گردد): " + nol.map(function (t) { return PROD_NAME[t]; }).join("، ") : "") + "\nادامه بدهم؟")) return;
          b.disabled = true; produce(pid, cp, f, tools, save).then(function (r) { reportProduce(r); redraw(); }, function (e2) { b.disabled = false; toast("✗ " + ghErrorFa(e2), 5000); });
        }
      }
    };
    var focus = hashQuery().focus;
    if (focus) { var el = document.getElementById("b-" + focus); if (el) { el.classList.add("focus"); el.scrollIntoView({ block: "center" }); } }
  }
  function reportProduce(r) {
    if (r.failed.length) toast("✗ ارسال برای " + r.failed.join("، ") + " ممکن نشد" + (r.sent.length ? " · فرستاده شد: " + r.sent.join("، ") : ""), 6000);
    else toast("در صف ساخت هارک ✓ " + r.sent.join("، "));
  }
  // a «screen» request: encrypted to Hark first, then the item is recorded in the brain store
  function sendToScreening(pid, cp, src, ctx) {
    var sid = newId("s"), rid = newId("r"), now = new Date().toISOString();
    var payload = { type: "screen", id: rid, page: pid, page_name: cp.name, topic: cp.topic_fa || "", screen_id: sid, source: src.kind, source_id: src.id,
      title: src.title || "", body: src.body || "", author: AUTHORS[src.author] || "", networks: src.networks || [], format: src.format || "", brief: SCREEN_BRIEF, created_at: now };
    return sendHarkRequest(payload).then(function () {
      return dsUpdate("brain-" + pid, function (x) {
        x = bdoc(x);
        x.screen.push({ id: sid, page: pid, title: src.title || "", body: src.body || "", author: src.author || "", source: { kind: src.kind, id: src.id }, request_id: rid, state: "queued", requested_at: now, script: null });
        var o = findBy(src.kind === "hark" ? x.hark : x.items, "id", src.id); if (o) o.screen_id = sid;
        return x;
      }, "data: brain " + pid);
    }).then(function (nd) { if (ctx) { ctx.doc = bdoc(nd); ctx.items = ctx.doc.items; } return nd; });
  }
  // production jobs: one encrypted request per tool (job id = request id), then the jobs are marked «در صف ساخت»
  function produce(pid, cp, f, tools, save) {
    var links = {}, sent = [], failed = [], ok = {};
    return dsRead("brain-" + pid).then(function (cur) {
      links = bdoc(cur).tool_links;
      return Promise.all(tools.map(function (t) {
        var jid = newId("j"), now = new Date().toISOString();
        var payload = { type: "produce", id: jid, page: pid, page_name: cp.name, topic: cp.topic_fa || "", final_id: f.id, tool: t, tool_name: PROD_NAME[t],
          project_url: links[t] || "", project_name: cp.name, title: f.title || "", script_text: f.text || "", script: f.script || {},
          gallery: { workflow: "gallery-ingest.yml", domain: pid, brain_id: f.id, req: jid }, created_at: now };
        return sendHarkRequest(payload).then(function () { ok[t] = { id: jid, state: "queued", requested_at: now }; sent.push(PROD_NAME[t]); }, function () { failed.push(PROD_NAME[t]); });
      }));
    }).then(function () {
      if (!sent.length) { var e = new Error("ارسال به هارک ممکن نشد"); throw e; }
      return save(function (x) { var cf = findBy(x.final, "id", f.id); if (cf) { cf.jobs = cf.jobs || {}; for (var t in ok) cf.jobs[t] = ok[t]; } return x; });
    }).then(function () { return { sent: sent, failed: failed }; });
  }


  // ============================================================= v10: «هویت» — brand identity (#/identity, #/identity/<page>)
  // Store : vault/identity-<page>.enc.json, AES-256-GCM with the data key (same as brain), keys: fields{}, assets[], hark_seen{}.
  //         fields[key] = { v, at (ISO, per-field updated_at), by: negin|amirhossein|hark, src: user|hark, draft, from_hark }
  // Mirror: every save also writes hark/identity/<page>.json, ECIES to config/hark_pub.json (HKDF info "sp-hark-id-v1",
  //         AAD "sp-hark-id-v1|hark/identity/<page>.json"), so Hark can read the identity (hark_bridge.py get-identity).
  // Hark  : writes hark/out/<page>/<id>.json with type "identity"; merged field by field, a field the team edited later is never overwritten.
  // Assets: each file encrypted with its own random AES-256-GCM key (AAD "sp-idasset-v1|<page>/<id>"), uploaded as a git blob and
  //         committed to the branch "identity-assets" (<page>/<id>.bin). The key lives only inside the encrypted identity file
  //         (and in Hark's encrypted mirror). ZIP contents are listed with fflate (vendor/fflate.js, loaded on demand).
  var HID = "sp-hark-id-v1", HARK_ID_DIR = "hark/identity", IDASSET_BRANCH = "identity-assets", IDA_AAD = "sp-idasset-v1";
  var ID_SECTIONS = [
    { k: "card", t: "شناسنامه", f: [["brand_name", "نام برند", "line"], ["handles", "هندل‌ها", "list", "هر هندل یک خط، مثلاً: اینستاگرام: @…"], ["start_date", "تاریخ شروع", "line"], ["owner", "صاحب / تیم", "text"]] },
    { k: "domain", t: "حوزه فعالیت", f: [["domain", "حوزه فعالیت", "text"]] },
    { k: "nature", t: "ماهیت برند", f: [["nature", "ماهیت برند", "text"]] },
    { k: "audience", t: "مخاطب هدف (پرسونا)", f: [["audience", "پرسونا", "text"]] },
    { k: "goal", t: "هدف محتوایی", f: [["content_goal", "هدف محتوایی", "text"]] },
    { k: "pillars", t: "چارچوب / ستون‌های محتوا", f: [["pillars", "ستون‌های محتوا", "list", "هر ستون یک خط"]] },
    { k: "formats", t: "فرمت‌ها و طول‌ها", f: [["formats", "فرمت‌ها و طول‌ها", "list", "مثلاً: ریل ۲۰ تا ۳۵ ثانیه"]] },
    { k: "tone", t: "لحن و زبان برند", f: [["tone", "لحن", "text"], ["dos", "باید‌ها", "list"], ["donts", "نباید‌ها", "list"], ["keywords", "کلمات کلیدی", "list"], ["banned", "کلمات ممنوع", "list"]] },
    { k: "colors", t: "رنگ سازمانی", f: [["colors", "رنگ‌ها", "colors"]] },
    { k: "slogan", t: "اسلوگان", f: [["slogan", "اسلوگان", "text"]] },
    { k: "characters", t: "کاراکترها", f: [["characters", "کاراکترها", "chars"]] },
    { k: "names", t: "اسامی", f: [["names", "اسامی (اسم سری‌ها، بخش‌ها، شخصیت‌ها…)", "list"]] },
    { k: "fonts", t: "فونت‌ها", f: [["fonts", "فونت‌ها", "list", "اسم فونت و کاربردش، هر کدام یک خط"]] },
    { k: "logos", t: "لوگوها", f: [["logos", "توضیح لوگوها (فایل‌ها را پایین صفحه آپلود کن)", "text"]] },
    { k: "visual", t: "فضاسازی / سبک بصری", f: [["mood", "Mood", "text"], ["light", "نور", "text"], ["framing", "قاب", "text"], ["base_prompt", "پرامپت پایه‌ی تصویر / ویدیو", "text"]] },
    { k: "hashtags", t: "هشتگ‌ها", f: [["hashtags", "هشتگ‌ها", "list"]] },
    { k: "ctas", t: "CTAها", f: [["ctas", "CTAها", "list"]] },
    { k: "refs", t: "رقبا / مرجع‌ها", f: [["competitors", "رقبا / مرجع‌ها", "list"]] },
    { k: "ai", t: "نکات برای ابزارهای AI", f: [["ai_notes", "System prompt آماده‌ی کپی", "text"]] }
  ];
  var ID_TYPE = {}, ID_LABEL = {};
  ID_SECTIONS.forEach(function (s) { s.f.forEach(function (f) { ID_TYPE[f[0]] = f[2]; ID_LABEL[f[0]] = f[1]; }); });
  var IDA_KIND = { logo: "لوگو", font: "فونت", image: "تصویر", zip: "ZIP", other: "فایل" };
  var ICON_FILE = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>';
  var v10ui = { open: {} };

  function idoc(d) { d = d || {}; d.fields = d.fields || {}; d.assets = d.assets || []; d.hark_seen = d.hark_seen || {}; return d; }
  function hexNorm(h) {
    h = String(h || "").trim(); if (h && h.charAt(0) !== "#") h = "#" + h;
    if (/^#[0-9a-f]{3}$/i.test(h)) h = "#" + h[1] + h[1] + h[2] + h[2] + h[3] + h[3];
    return /^#[0-9a-f]{6}$/i.test(h) ? h.toLowerCase() : "";
  }
  function idStr(v) { return String(v == null ? "" : v).replace(/\r\n/g, "\n").trim(); }
  function idNorm(type, v) {
    if (type === "list") { if (typeof v === "string") v = v.split("\n"); return (Array.isArray(v) ? v : []).map(idStr).filter(Boolean).slice(0, 300); }
    if (type === "colors") return (Array.isArray(v) ? v : []).map(function (c) { return typeof c === "string" ? { name: "", hex: hexNorm(c) } : { name: idStr(c && c.name), hex: hexNorm(c && c.hex) }; }).filter(function (c) { return c.hex; }).slice(0, 40);
    if (type === "chars") return (Array.isArray(v) ? v : []).map(function (c) { c = c || {}; return { name: idStr(c.name), look: idStr(c.look), personality: idStr(c.personality), prompt: idStr(c.prompt) }; })
      .filter(function (c) { return c.name || c.look || c.personality || c.prompt; }).slice(0, 30);
    return idStr(v);
  }
  function idEmpty(v) { return v == null || (Array.isArray(v) ? !v.length : !String(v).trim()); }
  function idBlank(type) { return type === "line" || type === "text" ? "" : []; }
  // one Hark -> panel identity message, field by field (idempotent). A field the team edited later than Hark's value is kept.
  function applyIdentityOut(d, m, now) {
    d = idoc(d);
    if (!m || !m.id || d.hark_seen[m.id]) return d;
    d.hark_seen[m.id] = now;
    var seen = Object.keys(d.hark_seen); if (seen.length > 300) seen.sort(function (a, b) { return String(d.hark_seen[a]).localeCompare(String(d.hark_seen[b])); }).slice(0, seen.length - 300).forEach(function (k) { delete d.hark_seen[k]; });
    var fs = m.fields || {};
    Object.keys(fs).forEach(function (k) {
      var type = ID_TYPE[k]; if (!type) return;
      var raw = fs[k], wrapped = !!(raw && typeof raw === "object" && !Array.isArray(raw) && ("v" in raw || "value" in raw));
      var val = idNorm(type, wrapped ? ("v" in raw ? raw.v : raw.value) : raw);
      if (idEmpty(val)) return;
      var at = (wrapped && raw.at) || m.created_at || now, cur = d.fields[k];
      if (cur && !idEmpty(cur.v) && (tsOf(cur.at) || 0) >= (tsOf(at) || 0)) return;
      d.fields[k] = { v: val, at: at, by: "hark", src: "hark", draft: !(wrapped && raw.draft === false), label: String(m.label || "پیشنهاد هارک — تأیید کن"), note: wrapped && raw.note ? String(raw.note) : "" };
    });
    return d;
  }
  function idValText(type, v) {
    if (type === "list") return v.map(function (x) { return "- " + x; }).join("\n");
    if (type === "colors") return v.map(function (c) { return "- " + (c.name ? c.name + ": " : "") + c.hex; }).join("\n");
    if (type === "chars") return v.map(function (c) {
      return ["- " + (c.name || "کاراکتر"), c.look && "  ظاهر: " + c.look, c.personality && "  شخصیت: " + c.personality, c.prompt && "  پرامپت تصویر: " + c.prompt].filter(Boolean).join("\n");
    }).join("\n");
    return String(v);
  }
  // the clean Persian brief for ChatGPT / Gemini / Claude… (empty fields are left out)
  function identityBrief(cp, d) {
    d = idoc(d);
    var out = ["شناسنامه‌ی برند «" + cp.name + "»", "این بریف هویت ثابت این برند است. هر محتوایی برای این برند می‌سازی (ایده، اسکریپت، کپشن، تصویر، ویدیو) باید با آن هماهنگ باشد."];
    ID_SECTIONS.forEach(function (s) {
      var parts = [];
      s.f.forEach(function (f) {
        var x = d.fields[f[0]]; if (!x || idEmpty(x.v)) return;
        var t = idValText(f[2], x.v);
        if (s.f.length === 1) parts.push(t);
        else parts.push(f[1] + ":" + (t.indexOf("\n") >= 0 || f[2] === "list" ? "\n" + t : " " + t));
      });
      if (parts.length) out.push("", "## " + s.t, parts.join("\n"));
    });
    var files = d.assets.map(function (a) { return "- " + (IDA_KIND[a.kind] || "فایل") + ": " + a.name; });
    if (files.length) out.push("", "## فایل‌های برند (در پنل)", files.join("\n"));
    return out.join("\n").trim();
  }
  function idFilled(d) { d = idoc(d); return ID_SECTIONS.filter(function (s) { return s.f.some(function (f) { var x = d.fields[f[0]]; return x && !idEmpty(x.v); }); }).length; }
  function idHarkCount(d) { d = idoc(d); return Object.keys(d.fields).filter(function (k) { var x = d.fields[k]; return x && x.src === "hark" && !idEmpty(x.v); }).length; }
  // encrypted copy for Hark (hark/identity/<page>.json); includes each asset's key so Hark can open the files
  function identityMirror(cp, d) {
    d = idoc(d);
    var path = HARK_ID_DIR + "/" + cp.id + ".json";
    var payload = { type: "identity", page: cp.id, page_name: cp.name, topic: cp.topic_fa || "", updated_at: d.updated_at || new Date().toISOString(), fields: d.fields,
      sections: ID_SECTIONS.map(function (s) { return { k: s.k, t: s.t, f: s.f.map(function (f) { return { k: f[0], label: f[1], type: f[2] }; }) }; }),
      assets: d.assets.map(function (a) { return { id: a.id, name: a.name, type: a.type, size: a.size, kind: a.kind, sha: a.sha, iv: a.iv, k: a.k, aad: IDA_AAD + "|" + cp.id + "/" + a.id, branch: a.branch, path: a.path, zip: a.zip || null, at: a.at, by: a.by }; }),
      brief: identityBrief(cp, d) };
    return harkPub().then(function (pub) { return harkSeal(pub, cp.id, payload, HID, HID + "|" + path); })
      .then(function (env) { env.page = cp.id; return putJSONFile(path, env, "hark: identity mirror " + cp.id); });
  }
  // save the identity doc, then refresh Hark's mirror (a mirror failure never loses the save)
  function idSave(cp, mutate) {
    return dsUpdate("identity-" + cp.id, function (d) { return mutate(idoc(d)); }, "data: identity " + cp.id).then(function (d) {
      return identityMirror(cp, d).then(function () { return { doc: idoc(d), mirror: true }; }, function (e) { return { doc: idoc(d), mirror: false, err: e }; });
    });
  }
  var idBusy = {};
  function mergeIdentityOut(pid) {
    if (idBusy[pid]) return idBusy[pid];
    var cp = cpById(pid), dir = HARK_OUT_DIR + "/" + pid;
    var p = gh("/contents/" + dir + "?ref=" + GH_BRANCH + "&t=" + Date.now()).catch(function (e) { if (e.status === 404) return []; throw e; }).then(function (files) {
      files = (Array.isArray(files) ? files : []).filter(function (f) { return /\.json$/.test(f.name); });
      if (!files.length) return 0;
      return Promise.all(files.map(function (f) {
        var id = f.name.replace(/\.json$/, "");
        return readRepoFile(dir + "/" + f.name).then(function (r) {
          if (!r.obj || !r.obj.epk || (r.obj.kid && r.obj.kid !== DS.kid)) return null;
          return harkOpen(r.obj, HOUT + "|" + pid + "/" + id).then(function (m) { m.id = id; return { name: f.name, sha: r.sha, msg: m }; });
        }).catch(function () { return null; });
      })).then(function (rows) {
        rows = rows.filter(function (x) { return x && x.msg && x.msg.type === "identity"; });
        if (!rows.length) return 0;
        rows.sort(function (a, b) { return String(a.msg.created_at || "").localeCompare(String(b.msg.created_at || "")); });
        return idSave(cp, function (d) { var now = new Date().toISOString(); rows.forEach(function (x) { d = applyIdentityOut(d, x.msg, now); }); return d; }).then(function () {
          return Promise.all(rows.map(function (x) {
            return gh("/contents/" + dir + "/" + x.name, { method: "DELETE", body: { message: "hark: merged identity " + x.name, sha: x.sha, branch: GH_BRANCH } }).catch(function () {});
          }));
        }).then(function () { return rows.length; });
      });
    });
    idBusy[pid] = p.then(function (n) { idBusy[pid] = null; return n; }, function (e) { idBusy[pid] = null; throw e; });
    return idBusy[pid];
  }

  // ---- fflate (vendored, loaded only when a ZIP is uploaded or opened)
  var fflateP = null;
  function loadFflate() {
    if (window.fflate) return Promise.resolve(window.fflate);
    if (fflateP) return fflateP;
    fflateP = new Promise(function (res, rej) {
      var sc = document.createElement("script"); sc.src = "vendor/fflate.js?v=0.8.3";
      sc.onload = function () { window.fflate ? res(window.fflate) : rej(new Error("fflate")); };
      sc.onerror = function () { fflateP = null; rej(new Error("بارگذاری ابزار ZIP ممکن نشد")); };
      document.head.appendChild(sc);
    });
    return fflateP;
  }
  function isZipName(n, t) { return /\.zip$/i.test(n || "") || /zip/.test(t || ""); }
  var IMG_EXT = /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i;
  function zipList(ff, u8) {
    var list = [];
    ff.unzipSync(u8, { filter: function (f) { if (list.length < 2000 && !/\/$/.test(f.name) && !/(^|\/)(__MACOSX|\.DS_Store)/.test(f.name)) list.push({ n: f.name, s: f.originalSize }); return false; } });
    return list;
  }
  function guessKind(f, pick) {
    if (pick && pick !== "auto") return pick;
    if (isZipName(f.name, f.type)) return "zip";
    if (/\.(ttf|otf|woff2?|eot)$/i.test(f.name) || /font/.test(f.type)) return "font";
    if (/^image\//.test(f.type) || IMG_EXT.test(f.name)) return /logo|لوگو/i.test(f.name) ? "logo" : "image";
    return "other";
  }
  function imgThumb(blob) {
    return new Promise(function (res) {
      var u = URL.createObjectURL(blob), im = new Image();
      im.onload = function () {
        try {
          var w = im.naturalWidth || 160, h = im.naturalHeight || 160, sc = Math.min(1, 160 / Math.max(w, h));
          var c = document.createElement("canvas"); c.width = Math.max(1, Math.round(w * sc)); c.height = Math.max(1, Math.round(h * sc));
          c.getContext("2d").drawImage(im, 0, 0, c.width, c.height); res(c.toDataURL("image/png"));
        } catch (e) { res(""); }
        URL.revokeObjectURL(u);
      };
      im.onerror = function () { URL.revokeObjectURL(u); res(""); };
      im.src = u;
    });
  }
  function blobB64(blob) {
    return new Promise(function (res, rej) {
      var fr = new FileReader();
      fr.onload = function () { var s = String(fr.result); res(s.slice(s.indexOf(",") + 1)); };
      fr.onerror = function () { rej(new Error("خواندن فایل ممکن نشد")); };
      fr.readAsDataURL(blob);
    });
  }
  function idUpload(cp, file, pick, by, say) {
    if (file.size > MAX_UPLOAD) return Promise.reject(new Error(file.name + ": بیشتر از ۷۰ مگابایت"));
    var aid = newId("a"), kind = guessKind(file, pick), now = new Date().toISOString(), meta = {};
    say("در حال خواندن " + file.name + "…");
    return file.arrayBuffer().then(function (buf) {
      var u8 = new Uint8Array(buf), m;
      if (isZipName(file.name, file.type)) m = loadFflate().then(function (ff) { meta.zip = zipList(ff, u8); }, function () {}).catch(function () { meta.zip_error = true; });
      else if (/^image\//.test(file.type) || IMG_EXT.test(file.name)) m = imgThumb(file).then(function (t) { meta.thumb = t; });
      else m = Promise.resolve();
      return m.then(function () {
        say("در حال رمزگذاری " + file.name + "…");
        var kraw = rnd(32), iv = rnd(12);
        return crypto.subtle.importKey("raw", kraw, "AES-GCM", false, ["encrypt"])
          .then(function (k) { return crypto.subtle.encrypt({ name: "AES-GCM", iv: iv, additionalData: TE.encode(IDA_AAD + "|" + cp.id + "/" + aid) }, k, u8); })
          .then(function (ct) { return blobB64(new Blob([ct])); })
          .then(function (b64) { say("در حال آپلود " + file.name + "… ۰٪"); return uploadBlob(b64, function (p) { say("در حال آپلود " + file.name + "… " + fa(p) + "٪"); }); })
          .then(function (sha) {
            say("در حال ثبت " + file.name + "…");
            var path = cp.id + "/" + aid + ".bin";
            return stageOn(IDASSET_BRANCH, path, sha, "identity: " + cp.id + " asset").then(function () {
              return { id: aid, name: file.name, type: file.type || "", size: file.size, kind: kind, sha: sha, iv: u8b64(iv), k: u8b64(kraw), branch: IDASSET_BRANCH, path: path,
                thumb: meta.thumb || "", zip: meta.zip || null, zip_error: !!meta.zip_error, at: now, by: by };
            });
          });
      });
    });
  }
  // download + decrypt one asset -> Blob
  function idFetchAsset(pid, a) {
    return fetch("https://api.github.com/repos/" + GH_OWNER + "/" + GH_REPO + "/git/blobs/" + a.sha, { headers: ghHeaders({ Accept: "application/vnd.github.raw+json" }), cache: "no-store" }).then(function (r) {
      if (!r.ok) { var e = new Error("HTTP " + r.status); e.status = r.status; throw e; }
      var ct = r.headers.get("content-type") || "";
      if (/json/.test(ct) && !/raw/.test(ct)) return r.json().then(function (j) { return b64u8(String(j.content || "").replace(/\s/g, "")); });
      return r.arrayBuffer().then(function (b) { return new Uint8Array(b); });
    }).then(function (ct) {
      return crypto.subtle.importKey("raw", b64u8(a.k), "AES-GCM", false, ["decrypt"]).then(function (k) {
        return crypto.subtle.decrypt({ name: "AES-GCM", iv: b64u8(a.iv), additionalData: TE.encode(IDA_AAD + "|" + pid + "/" + a.id) }, k, ct);
      });
    }).then(function (pt) { return new Blob([pt], { type: a.type || "application/octet-stream" }); });
  }
  function mimeOf(n) { var e = (String(n).match(/\.(\w+)$/) || [, ""])[1].toLowerCase(); return { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", avif: "image/avif", bmp: "image/bmp" }[e] || "application/octet-stream"; }
  function saveBlob(blob, name) {
    var u = URL.createObjectURL(blob), a = document.createElement("a"); a.href = u; a.download = name || "file"; a.rel = "noopener";
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(u); }, 60000);
  }
  function showImage(blob, name) {
    var u = URL.createObjectURL(blob), old = document.getElementById("imgview"); if (old) old.remove();
    var d = document.createElement("div"); d.id = "imgview"; d.className = "ovl";
    d.innerHTML = '<div class="ovl-card img"><b dir="auto">' + esc(name || "") + '</b><img alt="" src="' + u + '"><div class="row-btns"><button class="ghost sm" data-x="dl">دانلود</button><button class="go sm" data-x="close">بستن</button></div></div>';
    document.body.appendChild(d);
    var close = function () { d.remove(); URL.revokeObjectURL(u); };
    d.onclick = function (e) { var x = e.target.closest("[data-x]"); if (e.target === d || (x && x.getAttribute("data-x") === "close")) close(); else if (x) saveBlob(blob, name); };
  }

  // ---- views
  function idOrder() { return channelOrder().map(cpById).filter(Boolean); }
  function identityHomeView() {
    app.innerHTML = shell("هویت برند", "#/", "صفحه‌ی اصلی") +
      '<div class="v8head idhead"><span class="vi">' + ICON_IDCARD + '</span><div><h1>هویت برند</h1><p>شناسنامه، لحن، رنگ، کاراکترها و فایل‌های هر برند</p></div></div>' +
      '<div id="dgate"></div><div id="v8body"></div>';
    bindShell();
    withData(function () {
      var body = document.getElementById("v8body"); body.innerHTML = '<div class="muted-note pad">در حال بارگذاری…</div>';
      var my = viewSeq, list = idOrder();
      Promise.all(list.map(function (cp) { return mergeIdentityOut(cp.id).catch(function () { return 0; }).then(function () { return dsRead("identity-" + cp.id).catch(function () { return null; }); }); })).then(function (res) {
        if (!live(my) || !document.getElementById("v8body")) return;
        body.innerHTML = '<div class="domlist" id="id-domains">' + list.map(function (cp, i) {
          var d = idoc(res[i]), hk = idHarkCount(d);
          return '<a class="dombox idb" href="#/identity/' + esc(cp.id) + '" data-page="' + esc(cp.id) + '">' + logoHTML(cp, pageData(cp), "dlogo") +
            '<span class="dn"><b>' + esc(cp.name) + "</b><span>" + esc(cp.topic_fa || "") + "</span></span>" +
            '<span class="dc">' + fa(idFilled(d)) + " از " + fa(ID_SECTIONS.length) + " بخش" + (hk ? ' · <i class="hkc">' + fa(hk) + " پیشنهاد هارک برای تأیید</i>" : "") + " · " + fa(d.assets.length) + " فایل</span></a>";
        }).join("") + "</div>" + '<p class="footnote privacy">' + esc(PRIVACY_NOTE) + "</p>";
      }).catch(function (e) { errBox("v8body", e); });
    });
  }
  function idFieldHTML(f, x) {
    var k = f[0], type = f[2], v = x ? x.v : idBlank(type), hint = f[3] || "", h = "";
    var lab = '<div class="idf-h"><label for="idf-' + k + '">' + esc(f[1]) + "</label>" +
      (x && x.src === "hark" ? '<span class="hkbadge">' + esc(x.label || "پیشنهاد هارک — تأیید کن") + (x.draft ? " · پیش‌نویس" : "") + '</span><button class="go xs" type="button" data-act="approve" data-ak="' + k + '">تأیید</button>' : "") + "</div>";
    if (type === "line") h = '<input id="idf-' + k + '" type="text" data-k="' + k + '" dir="auto" value="' + esc(v || "") + '">';
    else if (type === "text") h = '<textarea id="idf-' + k + '" data-k="' + k + '" dir="auto" rows="' + (k === "ai_notes" || k === "base_prompt" ? 7 : 4) + '">' + esc(v || "") + "</textarea>";
    else if (type === "list") h = '<textarea id="idf-' + k + '" data-k="' + k + '" dir="auto" rows="5" placeholder="' + esc(hint || "هر مورد یک خط") + '">' + esc((v || []).join("\n")) + "</textarea>";
    else if (type === "colors") {
      h = '<div class="swatches">' + (v || []).map(function (c) { return '<span style="background:' + esc(c.hex) + '" title="' + esc(c.name || c.hex) + '"></span>'; }).join("") + "</div>" +
        '<div class="colors" data-k="' + k + '">' + (v || []).map(colorRowHTML).join("") + "</div>" +
        '<button class="ghost sm" type="button" data-act="cadd" data-k="' + k + '">+ افزودن رنگ</button>';
    } else if (type === "chars") {
      h = '<div class="chars" data-k="' + k + '">' + (v || []).map(charHTML).join("") + "</div>" + '<button class="ghost sm" type="button" data-act="chadd" data-k="' + k + '">+ افزودن کاراکتر</button>';
    }
    var meta = x && x.at ? '<p class="idmeta">' + (x.src === "hark" ? "هارک" : esc(AUTHORS[x.by] || x.by || "")) + " · " + esc(fmtShort(x.at)) + (x.from_hark ? " · از پیشنهاد هارک" : "") + (x.note ? " · " + esc(x.note) : "") + "</p>" : "";
    return '<div class="idf' + (x && x.src === "hark" ? " hk" : "") + '" data-fk="' + k + '">' + lab + h + meta + "</div>";
  }
  function colorRowHTML(c) {
    c = c || { name: "", hex: "#7c3aed" };
    return '<div class="crow"><input type="color" value="' + esc(c.hex) + '" aria-label="انتخاب رنگ"><input type="text" class="hex" dir="ltr" maxlength="7" value="' + esc(c.hex) + '" aria-label="کد hex">' +
      '<input type="text" class="cname" dir="auto" placeholder="نام / کاربرد" value="' + esc(c.name || "") + '" aria-label="نام رنگ"><button class="ghost sm danger" type="button" data-act="crm" aria-label="حذف رنگ">×</button></div>';
  }
  function charHTML(c) {
    c = c || {};
    return '<div class="charb"><input type="text" class="c-name" dir="auto" placeholder="نام کاراکتر" value="' + esc(c.name || "") + '" aria-label="نام کاراکتر">' +
      '<textarea class="c-look" dir="auto" rows="2" placeholder="توصیف ظاهر" aria-label="توصیف ظاهر">' + esc(c.look || "") + "</textarea>" +
      '<textarea class="c-personality" dir="auto" rows="2" placeholder="شخصیت" aria-label="شخصیت">' + esc(c.personality || "") + "</textarea>" +
      '<textarea class="c-prompt" dir="auto" rows="3" placeholder="پرامپت تصویر (برای ابزار ساخت تصویر)" aria-label="پرامپت تصویر">' + esc(c.prompt || "") + "</textarea>" +
      '<button class="ghost sm danger" type="button" data-act="chrm">حذف کاراکتر</button></div>';
  }
  function readField(box, k) {
    var type = ID_TYPE[k], el;
    if (type === "colors") { el = box.querySelector('.colors[data-k="' + k + '"]'); return idNorm(type, Array.prototype.map.call(el.querySelectorAll(".crow"), function (r) { return { hex: r.querySelector(".hex").value, name: r.querySelector(".cname").value }; })); }
    if (type === "chars") { el = box.querySelector('.chars[data-k="' + k + '"]'); return idNorm(type, Array.prototype.map.call(el.querySelectorAll(".charb"), function (r) { return { name: r.querySelector(".c-name").value, look: r.querySelector(".c-look").value, personality: r.querySelector(".c-personality").value, prompt: r.querySelector(".c-prompt").value }; })); }
    el = box.querySelector('textarea[data-k="' + k + '"], input[data-k="' + k + '"]'); return idNorm(type, el ? el.value : "");
  }
  function idSectionHTML(s, d, open) {
    var hk = s.f.filter(function (f) { var x = d.fields[f[0]]; return x && x.src === "hark"; }).length;
    var filled = s.f.some(function (f) { var x = d.fields[f[0]]; return x && !idEmpty(x.v); });
    return '<details class="card form idsec" data-sec="' + s.k + '" id="sec-' + s.k + '"' + (open ? " open" : "") + "><summary><b>" + esc(s.t) + "</b>" +
      (hk ? '<span class="hkchip">پیشنهاد هارک</span>' : filled ? '<span class="okchip">پر شده</span>' : '<span class="emchip">خالی</span>') + "</summary>" +
      s.f.map(function (f) { return idFieldHTML(f, d.fields[f[0]]); }).join("") +
      '<div class="row-btns"><button class="go sm" type="button" data-act="save" data-sec="' + s.k + '">ذخیره‌ی این بخش</button>' +
      (s.k === "ai" ? '<button class="ghost sm" type="button" data-act="copyai">کپی System prompt</button>' : "") + "</div><div class=\"msg\"></div></details>";
  }
  function idAssetHTML(a) {
    var img = a.kind === "logo" || a.kind === "image";
    return '<div class="asset" data-aid="' + esc(a.id) + '">' +
      (a.thumb ? '<img class="athumb" alt="" src="' + esc(a.thumb) + '">' : '<span class="athumb ic">' + (a.kind === "zip" ? "ZIP" : a.kind === "font" ? "Aa" : ICON_FILE) + "</span>") +
      '<div class="ainfo"><b dir="auto">' + esc(a.name) + "</b><small>" + esc(IDA_KIND[a.kind] || "فایل") + " · " + esc(mb(a.size)) + " · " + esc(AUTHORS[a.by] || "") + " " + esc(fmtShort(a.at)) +
      (a.zip ? " · " + fa(a.zip.length) + " فایل داخل ZIP" : "") + "</small>" +
      '<div class="iact">' + (img ? '<button class="ghost sm" data-act="aview">نمایش</button>' : "") + (a.kind === "zip" || a.zip ? '<button class="ghost sm" data-act="azip">محتوای ZIP</button>' : "") +
      '<button class="ghost sm" data-act="adl">دانلود</button><button class="ghost sm danger" data-act="adel">حذف</button></div></div>' +
      '<div class="zipbox" hidden></div></div>';
  }
  function idAssetsHTML(d) {
    var list = d.assets.slice().sort(function (a, b) { return String(b.at).localeCompare(String(a.at)); });
    return '<section class="card form idassets" id="idassets"><h2>فایل‌ها: لوگو، فونت، تصویر، ZIP</h2>' +
      '<p class="help">هر فایل قبل از آپلود روی همین دستگاه رمزگذاری می‌شود (حداکثر ۷۰ مگابایت). از ZIP فهرست فایل‌ها نشان داده می‌شود و عکس‌هایش را می‌توانی ببینی.</p>' +
      '<label for="ida-kind">نوع</label><select id="ida-kind"><option value="auto">خودکار (از روی پسوند)</option>' + Object.keys(IDA_KIND).map(function (k) { return '<option value="' + k + '">' + IDA_KIND[k] + "</option>"; }).join("") + "</select>" +
      '<label for="ida-file">انتخاب فایل</label><input id="ida-file" type="file" multiple>' +
      '<div class="row-btns"><button class="go" type="button" id="ida-up">آپلود (رمزگذاری‌شده)</button></div><div class="msg" id="ida-msg"></div>' +
      '<div class="alist" id="ida-list">' + (list.length ? list.map(idAssetHTML).join("") : '<div class="empty">هنوز فایلی آپلود نشده.</div>') + "</div></section>";
  }
  function identityView(pid) {
    var cp = cpById(pid); if (!cp) { location.hash = "#/identity"; return; }
    app.innerHTML = shell("هویت · " + cp.name, "#/identity", "هویت برند") +
      '<div class="v8head idhead sm">' + logoHTML(cp, pageData(cp), "dlogo") + "<div><h1>" + esc(cp.name) + "</h1><p>شناسنامه‌ی برند · " + esc(cp.topic_fa || "") + "</p></div></div>" +
      '<div id="dgate"></div><div id="v8body"></div>';
    bindShell();
    var doc = null, baseline = {}, open = v10ui.open[pid] || (v10ui.open[pid] = {});
    withData(function () {
      var body = document.getElementById("v8body"); body.innerHTML = '<div class="muted-note pad">در حال بارگذاری…</div>';
      var my = viewSeq;
      mergeIdentityOut(pid).catch(function () { return 0; }).then(function () { return dsRead("identity-" + pid); }).then(function (d) {
        if (!live(my) || !document.getElementById("v8body")) return;
        doc = idoc(d); draw();
      }).catch(function (e) { errBox("v8body", e); });
    });
    function headHTML() {
      var hk = idHarkCount(doc), me = editorOf();
      return '<div class="idtop card"><div class="idprog"><b>' + fa(idFilled(doc)) + " از " + fa(ID_SECTIONS.length) + "</b> بخش پر شده" + (hk ? ' · <i class="hkc">' + fa(hk) + " پیشنهاد هارک — تأیید کن</i>" : "") + "</div>" +
        '<div class="row-btns"><button class="go" type="button" id="id-copyall">کپی کل شناسنامه برای ابزار AI</button>' + (hk ? '<button class="ghost" type="button" id="id-approveall">تأیید همه‌ی پیشنهادهای هارک</button>' : "") + "</div>" +
        '<label>ویرایش‌کننده</label><div class="nets" role="radiogroup" id="id-author">' + ["negin", "amirhossein"].map(function (a) {
          return '<label class="chk"><input type="radio" name="id-author" value="' + a + '"' + (me === a ? " checked" : "") + ">" + AUTHORS[a] + "</label>"; }).join("") + "</div></div>";
    }
    function snap(s) { s.f.forEach(function (f) { var x = doc.fields[f[0]]; baseline[f[0]] = JSON.stringify(x ? idNorm(f[2], x.v) : idBlank(f[2])); }); }
    function draw() {
      var body = document.getElementById("v8body"); if (!body) return;
      ID_SECTIONS.forEach(snap);
      body.innerHTML = '<div id="idhead">' + headHTML() + "</div>" + '<div id="idsecs">' + ID_SECTIONS.map(function (s) { return idSectionHTML(s, doc, open[s.k]); }).join("") + "</div>" +
        idAssetsHTML(doc) + '<p class="footnote privacy">' + esc(PRIVACY_NOTE) + " شناسنامه و فایل‌ها هم رمزگذاری‌شده‌اند؛ یک نسخه‌ی رمزگذاری‌شده هم برای هارک نوشته می‌شود تا هارک بتواند بخواندش.</p>";
      bind();
    }
    function redrawHead() { var h = document.getElementById("idhead"); if (h) { h.innerHTML = headHTML(); bindHead(); } }
    function redrawSec(k) {
      var s = ID_SECTIONS.filter(function (x) { return x.k === k; })[0], el = document.getElementById("sec-" + k); if (!s || !el) return;
      snap(s); var tmp = document.createElement("div"); tmp.innerHTML = idSectionHTML(s, doc, el.open); el.parentNode.replaceChild(tmp.firstChild, el);
    }
    function redrawAssets() { var el = document.getElementById("idassets"); if (!el) return; var tmp = document.createElement("div"); tmp.innerHTML = idAssetsHTML(doc); el.parentNode.replaceChild(tmp.firstChild, el); bindAssets(); }
    function after(r, msg) {
      doc = r.doc; toast(msg + (r.mirror ? "" : " (نسخه‌ی هارک به‌روز نشد: " + (r.err && r.err.message || "خطا") + ")"), r.mirror ? 3200 : 6000);
    }
    function author() { var r = document.querySelector('input[name="id-author"]:checked'); return r ? r.value : editorOf(); }
    function bindHead() {
      document.getElementById("id-copyall").onclick = function () { copyWithToast(identityBrief(cp, doc)); };
      var aa = document.getElementById("id-approveall");
      if (aa) aa.onclick = function () {
        if (!confirm("همه‌ی پیشنهادهای هارک (" + fa(idHarkCount(doc)) + " مورد) تأیید شود؟")) return;
        aa.disabled = true; var now = new Date().toISOString(), by = author();
        idSave(cp, function (d) { Object.keys(d.fields).forEach(function (k) { var x = d.fields[k]; if (x && x.src === "hark") { x.src = "user"; x.draft = false; x.from_hark = true; x.at = now; x.by = by; } }); return d; })
          .then(function (r) { after(r, "تأیید شد ✓"); draw(); }, function (e) { aa.disabled = false; toast("✗ " + ghErrorFa(e), 5000); });
      };
      Array.prototype.forEach.call(document.querySelectorAll('input[name="id-author"]'), function (r) { r.onchange = function () { lsSet(AUTHOR_LS, r.value); }; });
    }
    function bind() {
      bindHead(); bindAssets();
      var secs = document.getElementById("idsecs");
      secs.addEventListener("toggle", function (e) { var dt = e.target; if (dt && dt.getAttribute) open[dt.getAttribute("data-sec")] = dt.open; }, true);
      secs.oninput = function (e) {
        var t = e.target, row = t.closest(".crow"); if (!row) return;
        if (t.type === "color") row.querySelector(".hex").value = t.value;
        else if (t.classList.contains("hex")) { var hx = hexNorm(t.value); if (hx) row.querySelector('input[type="color"]').value = hx; }
        var sw = row.closest(".idf").querySelector(".swatches");
        if (sw) sw.innerHTML = Array.prototype.map.call(row.parentNode.querySelectorAll(".crow"), function (r) { var h = hexNorm(r.querySelector(".hex").value); return h ? '<span style="background:' + h + '"></span>' : ""; }).join("");
      };
      secs.onclick = function (e) {
        var b = e.target.closest("[data-act]"); if (!b || b.disabled) return;
        var act = b.getAttribute("data-act"), sec = b.closest(".idsec"), k = b.getAttribute("data-k") || b.getAttribute("data-ak");
        if (act === "cadd") { sec.querySelector('.colors[data-k="' + k + '"]').insertAdjacentHTML("beforeend", colorRowHTML()); return; }
        if (act === "crm") { b.closest(".crow").remove(); return; }
        if (act === "chadd") { sec.querySelector('.chars[data-k="' + k + '"]').insertAdjacentHTML("beforeend", charHTML()); var n = sec.querySelectorAll(".charb .c-name"); n[n.length - 1].focus(); return; }
        if (act === "chrm") { if (confirm("این کاراکتر حذف شود؟ (با «ذخیره‌ی این بخش» ثبت می‌شود)")) b.closest(".charb").remove(); return; }
        if (act === "copyai") { var x = doc.fields.ai_notes; var t = sec.querySelector('textarea[data-k="ai_notes"]').value.trim() || (x && x.v) || ""; if (!t) { toast("System prompt هنوز خالی است"); return; } copyWithToast(t); return; }
        var sk = sec.getAttribute("data-sec"), m = sec.querySelector(".msg"), now = new Date().toISOString(), by = author();
        if (act === "approve") {
          b.disabled = true;
          idSave(cp, function (d) { var x = d.fields[k]; if (x && x.src === "hark") { x.src = "user"; x.draft = false; x.from_hark = true; x.at = now; x.by = by; } return d; })
            .then(function (r) { after(r, "تأیید شد ✓"); redrawSec(sk); redrawHead(); }, function (e2) { b.disabled = false; toast("✗ " + ghErrorFa(e2), 5000); });
          return;
        }
        if (act === "save") {
          var s = ID_SECTIONS.filter(function (x) { return x.k === sk; })[0], changed = {};
          s.f.forEach(function (f) { var v = readField(sec, f[0]); if (JSON.stringify(v) !== baseline[f[0]]) changed[f[0]] = v; });
          if (!Object.keys(changed).length) { m.textContent = "تغییری نبود."; return; }
          b.disabled = true; m.textContent = "در حال ذخیره (رمزگذاری‌شده)…";
          idSave(cp, function (d) { for (var kk in changed) d.fields[kk] = { v: changed[kk], at: now, by: by, src: "user", draft: false }; return d; })
            .then(function (r) { after(r, "ذخیره شد ✓"); redrawSec(sk); redrawHead(); }, function (e2) { b.disabled = false; m.textContent = "✗ " + ghErrorFa(e2); });
        }
      };
    }
    function bindAssets() {
      var up = document.getElementById("ida-up"), msg = document.getElementById("ida-msg");
      up.onclick = function () {
        var files = Array.prototype.slice.call(document.getElementById("ida-file").files || []);
        if (!files.length) { msg.textContent = "اول فایل را انتخاب کن."; return; }
        var big = files.filter(function (f) { return f.size > MAX_UPLOAD; });
        if (big.length) { msg.textContent = "✗ بیشتر از ۷۰ مگابایت: " + big.map(function (f) { return f.name; }).join("، "); return; }
        var pick = document.getElementById("ida-kind").value, by = author(), done = [];
        up.disabled = true;
        var chain = Promise.resolve();
        files.forEach(function (f) { chain = chain.then(function () { return idUpload(cp, f, pick, by, function (t) { msg.textContent = t; }).then(function (a) { done.push(a); }); }); });
        chain.then(function () {
          msg.textContent = "در حال ذخیره‌ی فهرست فایل‌ها…";
          return idSave(cp, function (d) { done.forEach(function (a) { d.assets.push(a); }); return d; });
        }).then(function (r) { after(r, fa(done.length) + " فایل آپلود شد ✓"); redrawAssets(); redrawHead(); }, function (e) {
          up.disabled = false; msg.textContent = "✗ " + ghErrorFa(e);
          if (done.length) idSave(cp, function (d) { done.forEach(function (a) { d.assets.push(a); }); return d; }).then(function (r) { doc = r.doc; redrawAssets(); }, function () {});
        });
      };
      document.getElementById("ida-list").onclick = function (e) {
        var b = e.target.closest("[data-act]"); if (!b || b.disabled) return;
        var row = b.closest(".asset"), a = findBy(doc.assets, "id", row.getAttribute("data-aid")), act = b.getAttribute("data-act"); if (!a) return;
        var busy = function (p, label) { var t = b.textContent; b.disabled = true; b.textContent = label || "…"; return p.then(function (x) { b.disabled = false; b.textContent = t; return x; }, function (err) { b.disabled = false; b.textContent = t; toast("✗ " + ghErrorFa(err), 5000); throw err; }); };
        if (act === "aview") busy(idFetchAsset(pid, a), "در حال باز کردن…").then(function (bl) { showImage(bl, a.name); }, function () {});
        else if (act === "adl") busy(idFetchAsset(pid, a), "در حال دانلود…").then(function (bl) { saveBlob(bl, a.name); }, function () {});
        else if (act === "azip") {
          var zb = row.querySelector(".zipbox");
          if (!zb.hidden) { zb.hidden = true; return; }
          zb.hidden = false;
          var imgs = (a.zip || []).filter(function (z) { return IMG_EXT.test(z.n); }).length;
          zb.innerHTML = '<div class="ziplist">' + (a.zip && a.zip.length ? a.zip.slice(0, 400).map(function (z) { return '<div class="zrow"><span dir="ltr">' + esc(z.n) + "</span><small>" + esc(mb(z.s)) + "</small></div>"; }).join("") + (a.zip.length > 400 ? '<div class="muted-note">… و ' + fa(a.zip.length - 400) + " فایل دیگر</div>" : "")
            : '<div class="muted-note">فهرست فایل‌ها ذخیره نشده.</div>') + "</div>" +
            '<button class="ghost sm" data-act="zimgs">' + (imgs ? "نمایش " + fa(imgs) + " عکس داخل ZIP" : "باز کردن ZIP و نمایش عکس‌ها") + '</button><div class="zgrid"></div>';
        } else if (act === "zimgs") {
          var grid = row.querySelector(".zgrid");
          busy(Promise.all([idFetchAsset(pid, a), loadFflate()]).then(function (r) {
            return r[0].arrayBuffer().then(function (buf) {
              var n = 0, files = r[1].unzipSync(new Uint8Array(buf), { filter: function (f) { return IMG_EXT.test(f.name) && !/(^|\/)__MACOSX/.test(f.name) && n++ < 80; } });
              return Object.keys(files).map(function (name) { return { name: name, blob: new Blob([files[name]], { type: mimeOf(name) }) }; });
            });
          }), "در حال باز کردن…").then(function (list) {
            grid.innerHTML = list.length ? "" : '<div class="muted-note">عکسی داخل ZIP نیست.</div>';
            list.forEach(function (it) {
              var bt = document.createElement("button"); bt.type = "button"; bt.className = "zimg"; bt.title = it.name;
              var im = document.createElement("img"); im.alt = it.name; im.src = URL.createObjectURL(it.blob); bt.appendChild(im);
              var cap = document.createElement("small"); cap.textContent = it.name.split("/").pop(); cap.dir = "ltr"; bt.appendChild(cap);
              bt.onclick = function () { showImage(it.blob, it.name.split("/").pop()); };
              grid.appendChild(bt);
            });
          }, function () {});
        } else if (act === "adel") {
          if (!confirm("فایل «" + a.name + "» حذف شود؟")) return;
          b.disabled = true;
          idSave(cp, function (d) { d.assets = d.assets.filter(function (x) { return x.id !== a.id; }); return d; }).then(function (r) {
            after(r, "حذف شد"); redrawAssets(); redrawHead();
            if (a.path) stageOn(a.branch || IDASSET_BRANCH, a.path, null, "identity: remove " + a.path).catch(function () {});
          }, function (e2) { b.disabled = false; toast("✗ " + ghErrorFa(e2), 5000); });
        }
      };
    }
  }

  // ============================================================= v8: «گالری محتوا» (#/gallery)
  function galleryHomeView() {
    app.innerHTML = shell("گالری محتوا", "#/", "صفحه‌ی اصلی") +
      '<div class="v8head galhead"><span class="vi">' + ICON_GALLERY + '</span><div><h1>گالری محتوا</h1><p>انبار داخلی محتوای آماده‌ی هر پیج</p></div></div>' +
      '<div id="dgate"></div><div id="v8body"></div>';
    bindShell();
    withData(function () {
      var body = document.getElementById("v8body"); body.innerHTML = '<div class="muted-note pad">در حال بارگذاری…</div>';
      var my = viewSeq;
      mergeInbox().catch(function () { return 0; }).then(function (n) {
        if (n) toast(fa(n) + " آیتم تازه از صندوق ورودی به گالری اضافه شد");
        return Promise.all(state.config.pages.map(function (cp) { return dsRead("gallery-" + cp.id); }));
      }).then(function (res) {
        if (!live(my) || !document.getElementById("v8body")) return;
        body.innerHTML = '<div class="domlist" id="gal-domains">' + state.config.pages.map(function (cp, i) {
          var items = (res[i] && res[i].items) || [], c = {};
          items.forEach(function (it) { c[it.kind] = (c[it.kind] || 0) + 1; });
          return '<a class="dombox gal" href="#/gallery/' + esc(cp.id) + '/slide" data-page="' + esc(cp.id) + '">' + logoHTML(cp, pageData(cp), "dlogo") +
            '<span class="dn"><b>' + esc(cp.name) + "</b><span>" + esc(cp.topic_fa || "") + "</span></span>" +
            '<span class="dc">' + KINDS.map(function (k) { return fa(c[k] || 0) + " " + KIND_FA[k]; }).join(" · ") + "</span></a>";
        }).join("") + "</div>" + '<p class="footnote privacy">' + esc(PRIVACY_NOTE) + "</p>";
      }).catch(function (e) { errBox("v8body", e); });
    });
  }
  // read width/height/duration + a small thumbnail (stays inside the encrypted gallery file)
  function thumbOf(src, w, h) {
    try {
      var s = Math.min(1, 240 / Math.max(w || 1, h || 1)), c = document.createElement("canvas");
      c.width = Math.max(1, Math.round((w || 240) * s)); c.height = Math.max(1, Math.round((h || 240) * s));
      c.getContext("2d").drawImage(src, 0, 0, c.width, c.height);
      return c.toDataURL("image/jpeg", 0.6);
    } catch (e) { return ""; }
  }
  function probeFile(f) {
    var url = URL.createObjectURL(f), isImg = /^image\//.test(f.type), isVid = /^video\//.test(f.type);
    var base = { file: f, name: f.name, size: f.size, mime: f.type, type: isImg ? "image" : isVid ? "video" : "other", w: 0, h: 0, dur: 0, thumb: "" };
    return new Promise(function (res) {
      var done = false; function fin() { if (done) return; done = true; URL.revokeObjectURL(url); res(base); }
      setTimeout(fin, 12000);
      if (isImg) {
        var im = new Image();
        im.onload = function () { base.w = im.naturalWidth; base.h = im.naturalHeight; base.thumb = thumbOf(im, base.w, base.h); fin(); };
        im.onerror = fin; im.src = url;
      } else if (isVid) {
        var v = document.createElement("video"); v.muted = true; v.playsInline = true; v.preload = "metadata";
        v.onloadedmetadata = function () {
          base.w = v.videoWidth; base.h = v.videoHeight; base.dur = isFinite(v.duration) ? v.duration : 0;
          try { v.currentTime = Math.min(1, (base.dur || 2) / 3); } catch (e) { fin(); }
        };
        v.onseeked = function () { base.thumb = thumbOf(v, base.w, base.h); fin(); };
        v.onerror = fin; v.src = url;
      } else fin();
    });
  }
  function galleryItemHTML(it, ctx) {
    var eff = ctx.sync.gal[it.id] || it.status, pid = it.page, b = it.brain_id && ctx.brainById[it.brain_id];
    var recs = Object.keys(ctx.records).filter(function (id) { return ctx.records[id].gallery_id === it.id; });
    var m0 = (it.media || [])[0] || {}, moving = ctx.assets && (it.media || []).some(function (m) { return !ctx.assets[m.name]; });
    var dims = m0.w && m0.h ? "\u2066" + fa(m0.w) + "×" + fa(m0.h) + "\u2069" : "";
    var size = (it.media || []).reduce(function (s, m) { return s + (m.size || 0); }, 0);
    return '<article class="gitem" id="g-' + esc(it.id) + '" data-id="' + esc(it.id) + '" data-status="' + esc(eff) + '">' +
      '<div class="gthumb">' + (it.thumb ? '<img alt="" src="' + esc(it.thumb) + '">' : '<span class="gph">' + ICON_GALLERY + "</span>") +
      '<span class="gk">' + KIND_FA[it.kind] + ((it.media || []).length > 1 ? " · " + fa(it.media.length) + " فایل" : "") + "</span></div>" +
      '<div class="gbody"><div class="ih"><b class="it">' + esc(it.title || "(بدون عنوان)") + "</b>" + stChip("gallery", eff) + "</div>" + stDots("gallery", eff) +
      '<div class="im"><span>' + esc([dims, m0.dur ? secs(m0.dur) : "", mb(size)].filter(Boolean).join(" · ")) + '</span><span class="when">' + esc(fmtShort(it.created_at)) + "</span></div>" +
      '<div class="grule">قانون: ' + esc(it.rule || "—") + (it.override ? " · <b>دستی تغییر کرد</b>" : "") + "</div>" +
      (b ? '<a class="lchip" href="#/brain/' + esc(pid) + "/" + b.type + "?focus=" + esc(b.id) + '">✦ مغز متفکر (' + BTYPE_FA[b.type] + "): " + esc(b.title) + "</a>" :
        /^f\d/.test(it.brain_id || "") ? '<a class="lchip" href="#/brain/' + esc(pid) + "/final?focus=" + esc(it.brain_id) + '">✦ مغز متفکر (اسکریپت نهایی)</a>' : it.brain_id ? '<span class="lchip">✦ آیتم مغز متفکر پیدا نشد</span>' : "") +
      recs.map(function (id) { var j = ctx.jobs[id]; return '<a class="lchip pub" href="#/publish?job=' + esc(id) + '">⇪ انتشار ' + esc(j ? fmtShort(j.publish_at) : id) + " · " + esc(stLabel("publish", ctx.sync.pub[id])) + "</a>"; }).join("") +
      (moving ? '<div class="muted-note">فایل در حال انتقال به انبار (Release)…</div>' : "") +
      '<div class="iact"><a class="go sm" href="#/publish?g=' + esc(it.id) + "&page=" + esc(pid) + '">انتشار / زمان‌بندی از گالری</a>' +
      '<select class="ssel" data-act="status" aria-label="وضعیت">' + ST.gallery.slice(0, 2).map(function (s) { return '<option value="' + s[0] + '"' + (it.status === s[0] ? " selected" : "") + ">" + s[1] + "</option>"; }).join("") + "</select>" +
      '<select class="ssel" data-act="kind" aria-label="نوع">' + KINDS.map(function (k) { return '<option value="' + k + '"' + (it.kind === k ? " selected" : "") + ">" + KIND_FA[k] + "</option>"; }).join("") + "</select>" +
      (it.media || []).map(function (m, i) { return '<a class="flink" href="' + esc(m.url) + '" target="_blank" rel="noopener">فایل' + (it.media.length > 1 ? " " + fa(i + 1) : "") + " ↗</a>"; }).join("") +
      "</div></div></article>";
  }
  function galleryWorkView(pid, kind) {
    var cp = cpById(pid); if (!cp) { location.hash = "#/gallery"; return; }
    if (!KIND_FA[kind]) kind = "slide";
    var q = hashQuery();
    app.innerHTML = shell("گالری · " + cp.name, "#/gallery", "گالری محتوا") +
      '<div class="v8head galhead sm">' + logoHTML(cp, pageData(cp), "dlogo") + "<div><h1>" + esc(cp.name) + "</h1><p>" + esc(cp.topic_fa || "") + "</p></div></div>" +
      '<div class="tabs" role="tablist">' + KINDS.map(function (k) { return '<a role="tab" class="tab' + (k === kind ? " on" : "") + '" href="#/gallery/' + esc(pid) + "/" + k + '" data-tab="' + k + '">' + KIND_FA[k] + ' <em id="cnt-' + k + '"></em></a>'; }).join("") + "</div>" +
      '<div id="dgate"></div><div id="v8body"></div>';
    bindShell();
    var ctx = null, plan = [];
    withData(function () {
      var body = document.getElementById("v8body"); body.innerHTML = '<div class="muted-note pad">در حال بارگذاری…</div>';
      var my = viewSeq;
      mergeInbox().catch(function () { return 0; }).then(function () {
        return Promise.all([dsRead("gallery-" + pid), dsRead("brain-" + pid).catch(function () { return null; }), dsRead("publish").catch(function () { return null; }), loadQueue().catch(function () { return []; }), loadReleaseAssets(), publishRunning()]);
      }).then(function (r) {
        if (!live(my)) return;
        ctx = { items: (r[0] && r[0].items) || [], brain: (r[1] && r[1].items) || [], records: (r[2] && r[2].items) || {}, jobs: jobsMap(r[3]), assets: r[4], running: r[5] };
        draw();
      }).catch(function (e) { errBox("v8body", e); });
    });
    function draw() {
      var body = document.getElementById("v8body"); if (!body) return;
      ctx.brainById = {}; ctx.brain.forEach(function (b) { ctx.brainById[b.id] = b; });
      ctx.sync = syncStatuses({ brain: ctx.brain, gallery: ctx.items, records: ctx.records, jobs: ctx.jobs }, Date.now(), ctx.running);
      KINDS.forEach(function (k) { var e = document.getElementById("cnt-" + k); if (e) e.textContent = fa(ctx.items.filter(function (x) { return x.kind === k; }).length); });
      var list = ctx.items.filter(function (x) { return x.kind === kind; }).sort(function (a, b) { return (tsOf(b.created_at) || 0) - (tsOf(a.created_at) || 0); });
      var f = v8ui.gf[pid + kind] || "all", counts = { all: list.length };
      list.forEach(function (x) { var s = ctx.sync.gal[x.id]; counts[s] = (counts[s] || 0) + 1; });
      var shown = f === "all" ? list : list.filter(function (x) { return ctx.sync.gal[x.id] === f; });
      var brainOpts = ctx.brain.slice().sort(function (a, b) { return ["script", "scenario", "idea"].indexOf(a.type) - ["script", "scenario", "idea"].indexOf(b.type); })
        .map(function (b) { return '<option value="' + esc(b.id) + '"' + (q.brain === b.id ? " selected" : "") + ">" + BTYPE_FA[b.type] + ": " + esc(b.title) + "</option>"; }).join("");
      body.innerHTML = '<section class="card form upl" id="upl">' +
        '<h2>بارگذاری در گالری</h2>' +
        '<div class="drop" id="drop" tabindex="0" role="button" aria-label="انتخاب یا رها کردن فایل">' + ICON_GALLERY +
        '<span>فایل‌ها را اینجا رها کن یا بزن تا انتخاب کنی</span><small>چند فایل با هم · عکس و ویدئو · هر فایل تا ۷۰ مگابایت</small></div>' +
        '<input id="gf" type="file" multiple accept="image/*,video/*" hidden>' +
        '<label class="chk"><input type="checkbox" id="g-story"> برای استوری است (ویدئوی تا ۶۰ ثانیه → استوری)</label>' +
        '<label for="g-brain">اتصال به مغز متفکر (اختیاری)</label><select id="g-brain"><option value="">— بدون اتصال —</option>' + brainOpts + "</select>" +
        '<div id="g-plan" class="gplan"></div>' +
        '<button class="go" id="g-up" disabled>بارگذاری در گالری</button><div class="msg" id="g-msg"></div></section>' +
        filterSeg("gallery", f, counts) +
        '<div class="glist" id="glist">' + (shown.length ? shown.map(function (x) { return galleryItemHTML(x, ctx); }).join("") :
          '<div class="empty">' + (list.length ? "در این وضعیت چیزی نیست." : "هنوز " + KIND_FA[kind] + "ی در گالری نیست.") + "</div>") + "</div>" +
        '<p class="footnote privacy">' + esc(PRIVACY_NOTE) + "</p>";
      bindUpload();
      body.querySelector(".sfilter").onclick = function (e) { var b = e.target.closest("button[data-f]"); if (!b) return; v8ui.gf[pid + kind] = b.getAttribute("data-f"); draw(); };
      document.getElementById("glist").onchange = function (e) {
        var s = e.target.closest("select[data-act]"); if (!s) return;
        var id = s.closest(".gitem").getAttribute("data-id"), act = s.getAttribute("data-act"), val = s.value;
        s.disabled = true;
        dsUpdate("gallery-" + pid, function (d) {
          d = d || { items: [] };
          d.items.forEach(function (x) { if (x.id !== id) return; if (act === "status") x.status = val; else { x.kind = val; x.override = val !== x.kind_auto; } x.updated_at = new Date().toISOString(); });
          return d;
        }, "data: gallery " + pid).then(function (d) { ctx.items = d.items; toast(act === "kind" ? "به " + KIND_FA[val] + " منتقل شد ✓" : "وضعیت ذخیره شد ✓"); draw(); },
          function (er) { s.disabled = false; toast("✗ " + ghErrorFa(er), 5000); });
      };
      if (q.focus) { var el = document.getElementById("g-" + q.focus); if (el) { el.classList.add("focus"); el.scrollIntoView({ block: "center" }); } }
      if (q.brain) { var up = document.getElementById("upl"); up.classList.add("focus"); }
    }
    function bindUpload() {
      var drop = document.getElementById("drop"), inp = document.getElementById("gf"), story = document.getElementById("g-story");
      drop.onclick = function () { inp.click(); };
      drop.onkeydown = function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); inp.click(); } };
      drop.ondragover = function (e) { e.preventDefault(); drop.classList.add("over"); };
      drop.ondragleave = function () { drop.classList.remove("over"); };
      drop.ondrop = function (e) { e.preventDefault(); drop.classList.remove("over"); take(e.dataTransfer.files); };
      inp.onchange = function () { take(inp.files); };
      story.onchange = function () { if (plan.metas) makePlan(plan.metas); };
      document.getElementById("g-up").onclick = runUpload;
    }
    function take(fl) {
      var files = Array.prototype.slice.call(fl || []), m = document.getElementById("g-msg");
      var bad = files.filter(function (f) { return !/^(image|video)\//.test(f.type) || f.size > MAX_UPLOAD; });
      files = files.filter(function (f) { return bad.indexOf(f) < 0; });
      m.textContent = bad.length ? "✗ " + bad.map(function (f) { return f.name + (f.size > MAX_UPLOAD ? " (بیشتر از ۷۰ مگابایت)" : " (فقط عکس یا ویدئو)"); }).join("، ") + " کنار گذاشته شد." : "";
      if (!files.length) return;
      document.getElementById("g-plan").innerHTML = '<div class="muted-note">در حال خواندن فایل‌ها…</div>';
      Promise.all(files.map(probeFile)).then(makePlan);
    }
    function makePlan(metas) {
      var groups = classifyUpload(metas, { story: document.getElementById("g-story").checked });
      plan = groups.map(function (g, i) {
        var prev = plan[i] && plan[i].override ? plan[i] : null;
        return { files: g.files, auto: g.kind, kind: prev ? prev.kind : g.kind, override: !!prev, rule: g.rule, suggest: g.suggest,
          title: metas[g.files[0]].name.replace(/\.[^.]+$/, "") };
      });
      plan.metas = metas;
      var box = document.getElementById("g-plan");
      box.innerHTML = plan.map(function (p, i) {
        var fs = p.files.map(function (j) { return metas[j]; });
        return '<div class="gp" data-i="' + i + '"><div class="gpthumbs">' + fs.map(function (x) { return x.thumb ? '<img alt="" src="' + esc(x.thumb) + '">' : '<span class="gph">' + ICON_GALLERY + "</span>"; }).join("") + "</div>" +
          '<div class="gpinfo"><div class="gpf">' + fs.map(function (x) { return esc(x.name) + " · " + mb(x.size) + (x.w ? " · \u2066" + fa(x.w) + "×" + fa(x.h) + "\u2069" : "") + (x.dur ? " · " + secs(x.dur) : ""); }).join("<br>") + "</div>" +
          '<div class="grule">قانون خودکار: ' + esc(p.rule) + "</div>" +
          '<div class="gprow"><select class="ssel" data-plan-kind="' + i + '" aria-label="نوع">' + KINDS.map(function (k) { return '<option value="' + k + '"' + (p.kind === k ? " selected" : "") + ">" + KIND_FA[k] + (k === p.auto ? " (پیشنهاد)" : "") + "</option>"; }).join("") + "</select>" +
          '<input type="text" class="gptitle" data-plan-title="' + i + '" value="' + esc(p.title) + '" maxlength="120" aria-label="عنوان"></div></div></div>';
      }).join("");
      box.onchange = function (e) { var s = e.target.closest("[data-plan-kind]"); if (s) { var p = plan[+s.getAttribute("data-plan-kind")]; p.kind = s.value; p.override = p.kind !== p.auto; } };
      box.oninput = function (e) { var t = e.target.closest("[data-plan-title]"); if (t) plan[+t.getAttribute("data-plan-title")].title = t.value; };
      document.getElementById("g-up").disabled = !plan.length;
    }
    function runUpload() {
      var m = document.getElementById("g-msg"), btn = document.getElementById("g-up"), brainId = document.getElementById("g-brain").value, metas = plan.metas;
      if (!plan.length) return;
      btn.disabled = true;
      var done = 0, made = [];
      plan.reduce(function (p, g, gi) {
        return p.then(function () {
          var gid = newId("g"), media = [];
          return g.files.reduce(function (pp, j, k) {
            return pp.then(function () {
              var meta = metas[j], ext = (meta.name.match(/\.([A-Za-z0-9]{1,5})$/) || [, (meta.mime.split("/")[1] || "bin")])[1].toLowerCase();
              var name = gid + "-" + (k + 1) + "." + ext, label = "(" + fa(gi + 1) + " از " + fa(plan.length) + ") " + meta.name;
              m.textContent = "در حال آماده‌سازی " + label + "…";
              return readBase64(meta.file).then(function (b64) {
                return uploadBlob(b64, function (pc) { m.textContent = "در حال آپلود " + label + "… " + fa(pc) + "٪"; });
              }).then(function (sha) {
                m.textContent = "در حال ثبت " + label + "…";
                return stageOnBranch("gallery/" + name, sha).then(function () {
                  media.push({ name: name, url: releaseURL(name), type: meta.mime, size: meta.size, w: meta.w, h: meta.h, dur: Math.round(meta.dur * 10) / 10, blob_sha: sha });
                });
              });
            });
          }, Promise.resolve()).then(function () {
            var now = new Date().toISOString();
            var item = { id: gid, page: pid, kind: g.kind, kind_auto: g.auto, rule: g.rule, override: g.kind !== g.auto, title: (g.title || "").trim(), caption: "",
              media: media, thumb: metas[g.files[0]].thumb || "", status: "uploaded", brain_id: brainId, source: { via: "panel" }, created_at: now, updated_at: now };
            m.textContent = "در حال ذخیره‌ی اطلاعات (رمزگذاری‌شده)…";
            return dsUpdate("gallery-" + pid, function (d) { d = d || { items: [] }; d.items.push(item); return d; }, "data: gallery " + pid).then(function (d) { ctx.items = d.items; done++; made.push(item); });
          });
        });
      }, Promise.resolve()).then(function () {
        // move the staged files into the "gallery" release now (otherwise the next scheduled run, ≤ 15 min)
        return gh("/actions/workflows/publish.yml/dispatches", { method: "POST", body: { ref: GH_BRANCH } }).then(function () { return true; }, function () { return false; });
      }).then(function (dispatched) {
        plan = []; toast("✓ " + fa(done) + " آیتم به گالری اضافه شد" + (dispatched ? "" : " (انتقال فایل در اجرای بعدی)"), 4500);
        var k = made.length === 1 ? made[0].kind : kind;
        if (k !== kind) location.hash = "#/gallery/" + pid + "/" + k + "?focus=" + made[0].id; else draw();
      }).catch(function (e) { btn.disabled = false; m.textContent = "✗ " + ghErrorFa(e) + (done ? " — " + fa(done) + " آیتم قبل از خطا ذخیره شد." : ""); });
    }
  }

  // ============================================================= v8: publish (#/publish)
  // channel readiness: YouTube from the connection store; others from config/publish_caps.json (written by publish.py:
  // booleans only — whether the page's secrets exist). Aparat has no public upload API => always manual.
  function capsOf(pid, pl) {
    if (pl === "youtube") { var s = ytStatus(pid).st; return s === "ok" ? { ready: true } : { ready: false, reason: s === "unknown" ? "وضعیت اتصال یوتیوب خوانده نشد" : "یوتیوب این پیج هنوز متصل نیست" }; }
    if (pl === "aparat") return { ready: false, reason: "آپارات API انتشار عمومی ندارد" };
    var c = state.caps && state.caps.channels && state.caps.channels[pid + "/" + pl];
    if (c && c.ready) return { ready: true };
    if (bufferCh(pid, pl) && !(c && c.reason_fa && /کلید بافر/.test(c.reason_fa))) return { ready: true, via: "buffer" };
    return { ready: false, reason: (c && c.reason_fa) || (pl === "instagram" ? "کلید API اینستاگرام (Business) ثبت نشده" : "کلید API تیک‌تاک ثبت نشده") };
  }
  var MANUAL_LABEL = "اتصال برقرار نیست";
  // Instagram/TikTok through Buffer: data/buffer.json (buffer-sync.yml) lists the page's connected channels
  function bufferCh(pid, pl) {
    var p = state.buffer && state.buffer.pages && state.buffer.pages[pid];
    if (!p || p.status !== "ok") return null;
    return (p.channels || []).filter(function (c) { return c.service === pl; })[0] || null;
  }
  // one Persian line: why this channel can't publish automatically + what fixes it (the real cause, not a stale message)
  function connWhy(pid, pl, r) {
    r = r || {};
    if (pl === "youtube") {
      var y = ytStatus(pid).st;
      if (y === "ok") return { why: "یوتیوب این پیج حالا متصل است" + (r.status === "needs_setup" ? "؛ این مورد قبل از اتصال (یا با پیام قدیمی) بررسی شده بود" : ""), fix: "«تلاش دوباره» را بزن." };
      if (y === "mismatch") return { why: "حساب یوتیوبِ وصل‌شده کانال این پیج نیست", fix: "کانال‌ها ← یوتیوب ← «اتصال دوباره» و انتخاب کانال درست." };
      if (y === "revoked") return { why: "گوگل دسترسی پنل به این کانال را لغو کرده", fix: "کانال‌ها ← یوتیوب ← «اتصال دوباره»." };
      return { why: "حساب یوتیوب این پیج به پنل وصل نیست", fix: "کانال‌ها ← یوتیوب ← «اتصال»؛ بعد «تلاش دوباره»." };
    }
    if (pl === "aparat") return { why: "آپارات API عمومی برای انتشار ندارد", fix: "فایل را دانلود و در آپارات دستی منتشر کن، بعد «دستی منتشر کردم ✓»." };
    var c = state.caps && state.caps.channels && state.caps.channels[pid + "/" + pl], b = bufferCh(pid, pl), nm = PNAME[pl];
    if (r.status === "needs_setup" && r.reason && /بافر|BUFFER|یکی نیست|Paused/.test(r.reason)) return { why: r.reason, fix: "بعد از درست کردن، «تلاش دوباره» را بزن." };
    if ((c && c.ready) || b) return { why: nm + " این پیج " + (c && c.via === "official" ? "با API رسمی" : "از طریق بافر") + " وصل است", fix: "«تلاش دوباره» را بزن تا خودکار منتشر شود." };
    return { why: nm + " این پیج نه کلید API رسمی دارد نه در بافر وصل است", fix: "کانال را در بافر وصل کن (+ Secret BUFFER_KEY) یا دستی منتشر کن." };
  }
  function chMatrixHTML(sel) {
    var h = '<div class="chm-wrap"><table class="chm" id="chm"><thead><tr><th class="c0"><label class="chk"><input type="checkbox" data-g="all"> همه</label></th>' +
      PLATFORMS.map(function (pl) { return '<th><label class="chk col" title="همه‌ی ' + PNAME[pl] + '"><input type="checkbox" data-g="pl:' + pl + '">' + picon(pl) + '<span class="pln">' + PNAME[pl] + "</span></label></th>"; }).join("") + "</tr></thead><tbody>";
    state.config.pages.forEach(function (cp) {
      h += '<tr><th class="c0"><label class="chk"><input type="checkbox" data-g="pg:' + esc(cp.id) + '"> ' + esc(cp.name) + "</label></th>";
      PLATFORMS.forEach(function (pl) {
        if (!(cp.accounts || {})[pl]) { h += "<td></td>"; return; }
        var k = cp.id + "|" + pl, c = capsOf(cp.id, pl);
        h += '<td><label class="cell' + (c.ready ? "" : " manual") + '" title="' + esc(cp.name + " · " + PNAME[pl] + (c.ready ? "" : " — " + MANUAL_LABEL + ": " + c.reason)) + '"><input type="checkbox" data-t="' + esc(k) + '"' + (sel[k] ? " checked" : "") + ">" +
          (c.ready ? "" : '<span class="mtag">دستی</span>') + "</label></td>";
      });
      h += "</tr>";
    });
    return h + '</tbody></table></div><div class="legend"><span class="mtag">دستی</span> = ' + MANUAL_LABEL + " (این کانال هنوز برای انتشار خودکار وصل نیست)</div>";
  }
  function selectedTargets(sel) {
    var out = [];
    state.config.pages.forEach(function (cp) { PLATFORMS.forEach(function (pl) { if (sel[cp.id + "|" + pl] && (cp.accounts || {})[pl]) { var c = capsOf(cp.id, pl), t = { page: cp.id, platform: pl }; if (!c.ready) t.manual = true; out.push(t); } }); });
    return out;
  }
  function syncMatrix(sel) {
    var tb = document.getElementById("chm"); if (!tb) return;
    Array.prototype.forEach.call(tb.querySelectorAll("input[data-t]"), function (i) { i.checked = !!sel[i.getAttribute("data-t")]; });
    Array.prototype.forEach.call(tb.querySelectorAll("input[data-g]"), function (g) {
      var key = g.getAttribute("data-g"), ks = groupKeys(key), n = ks.filter(function (k) { return sel[k]; }).length;
      g.checked = ks.length > 0 && n === ks.length; g.indeterminate = n > 0 && n < ks.length;
    });
    var t = selectedTargets(sel), man = t.filter(function (x) { return x.manual; }), sum = document.getElementById("chm-sum");
    if (sum) sum.innerHTML = t.length ? "<b>" + fa(t.length) + " مقصد انتخاب شد</b>" + (man.length ? '<div class="mline"><span class="schip manual">' + MANUAL_LABEL + "</span> " + man.map(function (x) { return esc(targetName(x)); }).join("، ") + "</div>" : "") : "هنوز مقصدی انتخاب نشده.";
  }
  function groupKeys(g) {
    var ks = [];
    state.config.pages.forEach(function (cp) { PLATFORMS.forEach(function (pl) {
      if (!(cp.accounts || {})[pl]) return;
      if (g === "all" || g === "pg:" + cp.id || g === "pl:" + pl) ks.push(cp.id + "|" + pl);
    }); });
    return ks;
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
    var q = hashQuery(), sel = {}, src = q.g ? "gallery" : "upload", galPage = q.page && cpById(q.page) ? q.page : (preId && cpById(preId) ? preId : state.config.pages[0].id), galPick = q.g || "";
    if (preId && cpById(preId)) groupKeys(prePl ? "x" : "pg:" + preId).forEach(function (k) { sel[k] = true; });
    if (preId && prePl) sel[preId + "|" + prePl] = true;
    if (q.g && q.page) groupKeys("pg:" + q.page).forEach(function (k) { sel[k] = true; });
    var when = "now", galItems = null, galCtx = { brain: [] };
    if (q.job) v8ui.pview = "queue";
    html += '<section class="card form pubform" id="pubform">' +
      '<div class="seg srcseg" role="group" aria-label="منبع محتوا"><button type="button" data-src="upload">آپلود فایل</button><button type="button" data-src="gallery">از گالری</button></div>' +
      '<div id="src-upload"><label for="pf">فایل (ویدیو یا عکس)</label><input id="pf" type="file" accept="video/*,image/*"><div class="fileinfo" id="fileinfo"></div></div>' +
      '<div id="src-gallery" hidden><label for="pg-page">پیج</label><select id="pg-page">' + state.config.pages.map(function (cp) { return '<option value="' + esc(cp.id) + '"' + (cp.id === galPage ? " selected" : "") + ">" + esc(cp.name) + "</option>"; }).join("") + "</select>" +
      '<div id="pg-list" class="pglist"></div></div>' +
      '<label for="pt">عنوان</label><input id="pt" type="text" maxlength="100" placeholder="عنوان (برای یوتیوب و آپارات)">' +
      '<label for="pc">کپشن / توضیحات</label><textarea id="pc" rows="4" maxlength="2200" placeholder="متن پست…"></textarea>' +
      "<label>مقصدها (یک، چند یا همه‌ی کانال‌ها)</label>" + '<div id="chm-box">' + chMatrixHTML(sel) + "</div>" + '<div class="chsum" id="chm-sum"></div>' +
      '<label>زمان انتشار</label><div class="seg whenseg" role="group"><button type="button" data-when="now" class="on">همین حالا</button><button type="button" data-when="sched">زمان‌بندی</button></div>' +
      '<div class="sched" id="schedbox" hidden><label for="pd">زمان انتشار (به وقت تهران)</label><input id="pd" type="datetime-local" min="' + nowTehranInput(5) + '" value="' + nowTehranInput(60) + '"></div>' +
      '<div class="pub-btns"><button class="go" id="pub-go" type="button">ثبت انتشار</button></div>' +
      '<div class="msg" id="pubmsg"></div></section>';
    html += '<div class="jobs-h"><div class="seg viewseg" role="tablist"><button data-v="queue">صف انتشار</button><button data-v="cal">تقویم</button></div><button class="ghost sm" id="reloadjobs">به‌روزرسانی</button></div>' +
      '<div id="pview"><div class="muted-note pad">در حال بارگذاری…</div></div>';
    html += '<p class="footnote">فایل در گیت‌هاب ذخیره و در صف گذاشته می‌شود؛ GitHub Action حداکثر هر ۱۵ دقیقه صف را بررسی و منتشر می‌کند. کانال‌هایی که برای انتشار خودکار وصل نیستند «' + MANUAL_LABEL + "» نشان داده می‌شوند و در صف یادآوری می‌مانند تا خودت منتشر و تیک بزنی.</p>" +
      '<p class="footnote privacy">برای اینکه GitHub Action بتواند منتشر کند، صف انتشار (لینک فایل، مقصدها، زمان، عنوان و کپشن) خوانا در مخزن عمومی است. ' + esc(PRIVACY_NOTE) + "</p>";
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
    function setSrc(s) {
      src = s;
      Array.prototype.forEach.call(document.querySelectorAll(".srcseg button"), function (b) { var on = b.getAttribute("data-src") === s; b.className = on ? "on" : ""; b.setAttribute("aria-pressed", on); });
      document.getElementById("src-upload").hidden = s !== "upload"; document.getElementById("src-gallery").hidden = s !== "gallery";
      if (s === "gallery") loadGal();
    }
    document.querySelector(".srcseg").onclick = function (e) { var b = e.target.closest("button[data-src]"); if (b) setSrc(b.getAttribute("data-src")); };
    function loadGal() {
      var box = document.getElementById("pg-list"); box.innerHTML = '<div class="muted-note">در حال بارگذاری گالری…</div>';
      ensureData().then(function () {
        return Promise.all([dsRead("gallery-" + galPage), dsRead("brain-" + galPage).catch(function () { return null; })]);
      }).then(function (r) {
        galItems = ((r[0] && r[0].items) || []).slice().sort(function (a, b) { return (tsOf(b.created_at) || 0) - (tsOf(a.created_at) || 0); });
        galCtx.brain = (r[1] && r[1].items) || [];
        if (!document.getElementById("pg-list")) return;
        box.innerHTML = galItems.length ? galItems.map(function (it) {
          return '<label class="pgi' + (it.id === galPick ? " on" : "") + '" data-id="' + esc(it.id) + '"><input type="radio" name="pgpick" value="' + esc(it.id) + '"' + (it.id === galPick ? " checked" : "") + ">" +
            (it.thumb ? '<img alt="" src="' + esc(it.thumb) + '">' : '<span class="gph">' + ICON_GALLERY + "</span>") +
            '<span class="pgt"><b>' + esc(it.title || it.id) + "</b><span>" + KIND_FA[it.kind] + ((it.media || []).length > 1 ? " · " + fa(it.media.length) + " فایل" : "") + " · " + esc(fmtShort(it.created_at)) + "</span></span></label>";
        }).join("") : '<div class="empty">گالری این پیج خالی است. <a href="#/gallery/' + esc(galPage) + '">رفتن به گالری</a></div>';
        if (galPick) pick(galPick, true);
      }, function (e) {
        if (!document.getElementById("pg-list")) return;
        box.innerHTML = '<div class="muted-note">برای انتخاب از گالری، محتوای رمزگذاری‌شده باید باز باشد. <a href="#/gallery/' + esc(galPage) + '">باز کردن گالری</a>' + (e && e.need === "net" ? " (" + esc(e.message) + ")" : "") + "</div>";
      });
    }
    function pick(id, initial) {
      galPick = id;
      Array.prototype.forEach.call(document.querySelectorAll(".pgi"), function (l) { l.classList.toggle("on", l.getAttribute("data-id") === id); });
      var it = (galItems || []).filter(function (x) { return x.id === id; })[0]; if (!it) return;
      var t = document.getElementById("pt"), c = document.getElementById("pc");
      if (!t.value || !initial) t.value = it.title || "";
      if (it.caption && (!c.value || !initial)) c.value = it.caption;
      if ((it.media || []).length > 1) msg.textContent = "این اسلاید " + fa(it.media.length) + " فایل دارد؛ انتشار خودکار فعلاً فقط فایل اول را می‌فرستد و بقیه را باید دستی اضافه کنی.";
    }
    document.getElementById("pg-page").onchange = function () { galPage = this.value; galPick = ""; loadGal(); };
    document.getElementById("pg-list").onchange = function (e) { var r = e.target.closest("input[name=pgpick]"); if (r) pick(r.value); };
    var chm = document.getElementById("chm-box");
    chm.onchange = function (e) {
      var i = e.target; if (!i || i.type !== "checkbox") return;
      if (i.hasAttribute("data-t")) { if (i.checked) sel[i.getAttribute("data-t")] = true; else delete sel[i.getAttribute("data-t")]; }
      else if (i.hasAttribute("data-g")) groupKeys(i.getAttribute("data-g")).forEach(function (k) { if (i.checked) sel[k] = true; else delete sel[k]; });
      syncMatrix(sel);
    };
    function redrawMatrix() { if (!document.getElementById("chm-box")) return; chm.innerHTML = chMatrixHTML(sel); syncMatrix(sel); }
    syncMatrix(sel);
    document.querySelector(".whenseg").onclick = function (e) {
      var b = e.target.closest("button[data-when]"); if (!b) return; when = b.getAttribute("data-when");
      Array.prototype.forEach.call(document.querySelectorAll(".whenseg button"), function (x) { x.className = x === b ? "on" : ""; });
      document.getElementById("schedbox").hidden = when !== "sched";
    };
    document.getElementById("pub-go").onclick = function () {
      var targets = selectedTargets(sel), title = document.getElementById("pt").value.trim(), caption = document.getElementById("pc").value.trim(), at = null;
      if (when === "sched") {
        var v = document.getElementById("pd").value;
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v)) { msg.textContent = "تاریخ و ساعت را کامل انتخاب کن."; return; }
        at = v + ":00+03:30"; // Iran has no daylight saving: always UTC+03:30
        if (tsOf(at) < Date.now() + 60000) { msg.textContent = "زمان انتخاب‌شده گذشته است."; return; }
      }
      if (!targets.length) { msg.textContent = "حداقل یک مقصد انتخاب کن."; return; }
      var f = fileIn.files[0], it = null;
      if (src === "upload") {
        if (!f) { msg.textContent = "اول یک فایل انتخاب کن."; return; }
        if (!/^(video|image)\//.test(f.type)) { msg.textContent = "فقط ویدیو یا عکس پذیرفته می‌شود."; return; }
        if (f.size > MAX_UPLOAD) { msg.textContent = "حجم فایل بیشتر از ۷۰ مگابایت است."; return; }
      } else {
        it = (galItems || []).filter(function (x) { return x.id === galPick; })[0];
        if (!it) { msg.textContent = "یک آیتم از گالری انتخاب کن."; return; }
      }
      var man = targets.filter(function (t) { return t.manual; });
      var whenTxt = at ? "در " + fmtDateTime(at) : "همین حالا";
      if (!window.confirm("این محتوا " + whenTxt + " در " + fa(targets.length) + " مقصد ثبت شود؟\n\n" + targets.map(function (t) { return targetName(t) + (t.manual ? " — " + MANUAL_LABEL : ""); }).join("\n"))) return;
      setPubBusy(true);
      var job = src === "upload" ? submitJob(f, title, caption, targets, at, function (t) { msg.textContent = t; }) : submitGalleryJob(it, title, caption, targets, at);
      job.then(function (j) {
        msg.textContent = "✓ ثبت شد (" + j.id + ")" + (man.length ? " — " + fa(man.length) + " مقصد " + MANUAL_LABEL + " در صف یادآوری می‌ماند." : ".");
        // link record (encrypted): queue job -> gallery item -> brain item, so statuses flow back
        var rec = { id: j.id, src: src, gallery_id: it ? it.id : "", page: it ? it.page : "", brain_id: it ? it.brain_id || "" : "", created_at: new Date().toISOString() };
        var save = ensureData().then(function () { return dsUpdate("publish", function (d) { d = d || { items: {} }; d.items[j.id] = rec; return d; }, "data: publish links"); })
          .catch(function () { if (src === "gallery") msg.textContent += " (پیوند به گالری ذخیره نشد؛ وضعیت گالری خودکار به‌روز نمی‌شود)"; });
        return save.then(function () {
          fileIn.value = ""; document.getElementById("fileinfo").textContent = "";
          setPubBusy(false); RUNNING.at = 0; loadPView();
        });
      }).catch(function (e) { msg.textContent = "✗ " + ghErrorFa(e); setPubBusy(false); });
    };
    document.querySelector(".viewseg").onclick = function (e) { var b = e.target.closest("button[data-v]"); if (!b) return; v8ui.pview = b.getAttribute("data-v"); loadPView(true); };
    document.getElementById("reloadjobs").onclick = function () { RUNNING.at = 0; loadPView(); };
    setSrc(src);
    var pctx = { jobs: [], records: {}, gallery: {} }, myView = viewSeq;
    function loadPView(cached) {
      Array.prototype.forEach.call(document.querySelectorAll(".viewseg button"), function (b) { b.className = b.getAttribute("data-v") === v8ui.pview ? "on" : ""; });
      if (cached && pctx.loaded) return drawPView(pctx);
      var recs = DS.dk || lsGet(DK_LS, null) ? ensureData().then(function () { return dsRead("publish"); }).catch(function () { return null; }) : Promise.resolve(null);
      Promise.all([loadQueue(), recs, publishRunning()]).then(function (r) {
        if (!live(myView)) return;
        pctx = { jobs: r[0], records: (r[1] && r[1].items) || {}, running: r[2], loaded: true };
        drawPView(pctx);
      }).catch(function (e) { var b = document.getElementById("pview"); if (b) b.innerHTML = '<div class="muted-note">' + esc("خواندن صف ممکن نشد: " + ghErrorFa(e)) + "</div>"; });
    }
    function drawPView(c) {
      var box = document.getElementById("pview"); if (!box) return;
      var now = Date.now(), st = {};
      c.jobs.forEach(function (j) { st[j.id] = pubStatusOf(j, now, c.running); });
      if (v8ui.pview === "cal") { box.innerHTML = calendarHTML(c.jobs, st); bindCalendar(box, c, st); return; }
      var f = v8ui.pf, counts = { all: c.jobs.length };
      c.jobs.forEach(function (j) { counts[st[j.id]] = (counts[st[j.id]] || 0) + 1; });
      var shown = f === "all" ? c.jobs : c.jobs.filter(function (j) { return st[j.id] === f; });
      box.innerHTML = filterSeg("publish", f, counts) + '<div class="jobs" id="jobs">' + (shown.length ? shown.map(function (j) { return jobHTML(j, st[j.id], c.records[j.id]); }).join("") :
        '<div class="muted-note">' + (c.jobs.length ? "در این وضعیت چیزی نیست." : "هنوز چیزی در صف نیست.") + "</div>") + "</div>";
      box.querySelector(".sfilter").onclick = function (e) { var b = e.target.closest("button[data-f]"); if (!b) return; v8ui.pf = b.getAttribute("data-f"); drawPView(c); };
      bindJobs(box, c);
      var fj = hashQuery().job; if (fj) { var el = document.getElementById("job-" + fj); if (el) { el.classList.add("focus"); el.scrollIntoView({ block: "center" }); } }
    }
    function bindJobs(box, c) {
      box.onclick = function (e) {
        var b = e.target.closest("button[data-jact]"); if (!b) return;
        var name = b.getAttribute("data-name"), act = b.getAttribute("data-jact"), key = b.getAttribute("data-key");
        if (act === "cancel" && !window.confirm("این انتشار لغو شود؟")) return;
        if (act === "manual" && !window.confirm("این مقصد را دستی منتشر کردی؟")) return;
        if (act === "retry" && !window.confirm("انتشار در «" + key + "» همین حالا دوباره امتحان شود؟")) return;
        var why = "";
        if (act === "giveup") { why = window.prompt("این مقصد «ناموفق» بسته شود. دلیل (اختیاری):", ""); if (why === null) return; why = String(why).trim(); }
        b.disabled = true;
        var nowI = new Date().toISOString();
        updateQueueFile(name, function (job) {
          job.results = job.results || {};
          var prev = job.results[key] || {};
          if (act === "cancel") { job.status = "cancelled"; job.cancelled_at = nowI; return job; }
          if (act === "manual") job.results[key] = { status: "published", manual: true, reason: "دستی منتشر شد", at: nowI, prev_reason: prev.reason || "" };
          else if (act === "giveup") job.results[key] = { status: "failed", resolved_by: "panel", reason: "لغو / ناموفق" + (why ? ": " + why : ""), at: nowI, prev_reason: prev.reason || "" };
          else if (act === "retry") {
            job.results[key] = { status: "queued", attempts: 0, retry_requested_at: nowI, prev_reason: prev.reason || "", at: nowI };
            (job.targets || []).forEach(function (t) { if (t.page + "/" + t.platform === key) delete t.manual; });
          }
          return finalizeJob(job);
        }).then(function () {
          if (act !== "retry") { toast(act === "cancel" ? "انتشار لغو شد" : act === "manual" ? "ثبت شد: دستی منتشر شد ✓" : "ثبت شد: ناموفق"); loadPView(); return; }
          // the queue commit itself starts publish.yml (push on queue/**); the dispatch makes sure a run starts now
          return gh("/actions/workflows/publish.yml/dispatches", { method: "POST", body: { ref: GH_BRANCH } }).then(function () { return true; }, function () { return false; })
            .then(function (ok) { RUNNING.at = 0; toast(ok ? "دوباره در صف انتشار ✓ (اجرای انتشار شروع شد)" : "دوباره در صف انتشار ✓ (اجرای بعدی انتشار حداکثر ۱۵ دقیقه‌ی دیگر)", 4500); loadPView(); });
        }, function (er) { b.disabled = false; toast("✗ " + ghErrorFa(er), 5000); });
      };
    }
    function bindCalendar(box, c, st) {
      box.onclick = function (e) {
        var b = e.target.closest("button[data-cal]"); if (!b) return;
        var a = b.getAttribute("data-cal"), cal = v8ui.cal, step = cal.mode === "week" ? 7 : 30;
        if (a === "month" || a === "week") cal.mode = a;
        else if (a === "prev") cal.anchor = (cal.anchor || tehNoon(now0())) - step * DAY;
        else if (a === "next") cal.anchor = (cal.anchor || tehNoon(now0())) + step * DAY;
        else if (a === "today") { cal.anchor = null; cal.day = null; }
        else if (a === "day") cal.day = b.getAttribute("data-day");
        drawPView(c);
      };
    }
    loadYt().then(function () { redrawMatrix(); }, function () {});
    fetchRepoJSON("config/publish_caps.json").then(function (c) { state.caps = c; redrawMatrix(); }, function () {});
    loadPView();
  }
  function now0() { return Date.now(); }
  function submitGalleryJob(it, title, caption, targets, when) {
    var o = tehranParts(new Date());
    var id = o.year + o.month + o.day + "-" + o.hour + o.minute + o.second + "-" + Math.random().toString(36).slice(2, 6);
    var nowIso = o.year + "-" + o.month + "-" + o.day + "T" + o.hour + ":" + o.minute + ":" + o.second + "+03:30";
    var m0 = it.media[0];
    var job = { id: id, created_at: nowIso, publish_at: when || nowIso, targets: targets, title: title || it.title || m0.name, caption: caption,
      media: { path: "gallery/" + m0.name, blob_sha: m0.blob_sha || null, name: m0.name, type: m0.type, size: m0.size, source: "gallery" },
      asset_url: m0.url, assets: it.media.map(function (m) { return m.url; }), status: "pending", results: {} };
    return gh("/contents/queue/" + id + ".json", { method: "PUT", body: { message: "queue: " + id + (when ? " (scheduled)" : ""), content: b64utf8(JSON.stringify(job, null, 1) + "\n"), branch: GH_BRANCH } }).then(function () { return job; });
  }
  function updateQueueFile(name, mutate) {
    var tries = 0;
    function attempt() {
      return gh("/contents/queue/" + name + "?ref=" + GH_BRANCH + "&t=" + Date.now()).then(function (f) {
        var job = mutate(JSON.parse(utf8b64dec(f.content)));
        return gh("/contents/queue/" + name, { method: "PUT", body: { message: "queue: update " + job.id, content: b64utf8(JSON.stringify(job, null, 1) + "\n"), sha: f.sha, branch: GH_BRANCH } });
      }).catch(function (e) { if ((e.status === 409 || e.status === 422) && tries++ < 4) return sleep(800 * tries).then(attempt); throw e; });
    }
    return attempt();
  }
  function jobExtra(j) {
    if (j.status === "cancelled") return "لغو شد";
    var ts = (j.targets || []).map(function (t) { return targetState(j, t); });
    if (ts.indexOf("pending") >= 0) {
      var rt = (j.targets || []).map(function (t) { return (j.results || {})[t.page + "/" + t.platform] || {}; }).filter(function (r) { return r.status === "retry"; });
      return rt.length ? "تلاش خودکار " + fa(Math.max.apply(null, rt.map(function (r) { return r.attempts || 1; }))) + " از ۳" : "";
    }
    if (ts.indexOf("manual") >= 0) return "نیاز به اقدام";
    if (ts.every(function (x) { return x === "published"; })) return "";
    return ts.indexOf("published") >= 0 ? "جزئی" : "ناموفق";
  }
  function jobHTML(j, st, rec) {
    var res = j.results || {};
    var extra = jobExtra(j);
    return '<div class="job" id="job-' + esc(j.id) + '" data-id="' + esc(j.id) + '" data-status="' + st + '"><div class="jh">' + stChip("publish", st, extra) + '<b class="jt">' + esc(j.title || "(بدون عنوان)") + "</b></div>" + stDots("publish", st) +
      '<div class="jm">' + esc("زمان انتشار: " + fmtDateTime(j.publish_at)) + (j.media && j.media.source === "gallery" ? " · از گالری" : "") + "</div>" +
      (rec && rec.gallery_id ? '<a class="lchip" href="#/gallery/' + esc(rec.page) + "?focus=" + esc(rec.gallery_id) + '">▣ آیتم گالری</a>' : "") +
      '<ul class="jtargets">' + (j.targets || []).map(function (t) {
        var key = t.page + "/" + t.platform, r = res[key] || {}, ts = targetState(j, t);
        var chip = ts === "published" ? '<span class="schip s-publish-published">' + (r.manual ? "دستی منتشر شد" : "منتشر شد") + (r.via === "buffer" ? " (بافر)" : "") + "</span>" :
          ts === "manual" ? '<span class="schip manual">' + MANUAL_LABEL + "</span>" :
          ts === "error" ? (j.status === "cancelled" && !r.status ? '<span class="schip s-publish-error">لغو شد</span>' : '<span class="schip s-publish-error">' + (r.status === "skipped" ? "رد شد" : r.resolved_by === "panel" ? "ناموفق (لغو)" : "ناموفق") + "</span>") :
          r.status === "retry" ? '<span class="schip warnchip">تلاش دوباره ' + fa(r.attempts || 1) + " از ۳</span>" :
          r.status === "queued" ? '<span class="schip s-publish-queued">در صف تلاش دوباره</span>' :
          stChip("publish", st === "published" || st === "error" ? "queued" : st);
        var open = (ts === "manual" || (ts === "error" && r.status === "failed" && r.resolved_by !== "panel")) && j.status !== "cancelled";
        var info = "";
        if (ts === "manual") { var w = connWhy(t.page, t.platform, r); info = '<div class="tr why">' + esc(w.why) + '</div><div class="tr fix">راه‌حل: ' + esc(w.fix) + "</div>"; }
        else if (r.reason && !r.manual) info = '<div class="tr">' + esc(r.reason) + "</div>";
        if (ts === "pending" && t.manual && !r.status) info += '<div class="tr notyet">موقع ثبت به انتشار خودکار وصل نبود؛ اگر تا زمان انتشار وصل شود، خودکار منتشر می‌شود.</div>';
        var btns = open ? '<div class="tr racts">' + (j.asset_url ? '<a href="' + esc(j.asset_url) + '" target="_blank" rel="noopener">دانلود فایل ↓</a>' : "") +
          '<button class="ghost sm" data-jact="retry" data-key="' + esc(key) + '" data-name="' + esc(j._name) + '">تلاش دوباره</button>' +
          '<button class="ghost sm" data-jact="manual" data-key="' + esc(key) + '" data-name="' + esc(j._name) + '">دستی منتشر کردم ✓</button>' +
          '<button class="ghost sm danger" data-jact="giveup" data-key="' + esc(key) + '" data-name="' + esc(j._name) + '">لغو / ناموفق</button></div>' : "";
        return '<li data-key="' + esc(key) + '" data-ts="' + ts + '">' + picon(t.platform) + '<span class="tn">' + esc(targetName(t)) + "</span>" + chip + info +
          (r.url ? '<a class="tr" href="' + esc(r.url) + '" target="_blank" rel="noopener">مشاهده ↗</a>' : "") + btns + "</li>";
      }).join("") + "</ul>" +
      (j.status === "pending" ? '<button class="ghost danger sm" data-jact="cancel" data-name="' + esc(j._name) + '">لغو این انتشار</button>' : "") + "</div>";
  }
  // ---- calendar (Persian months, weeks start on Saturday, Tehran time)
  var JFMT = null, JMON = null, JDAY = null;
  function jparts(t) {
    JFMT = JFMT || new Intl.DateTimeFormat("en-US-u-ca-persian", { timeZone: TZ, year: "numeric", month: "numeric", day: "numeric", weekday: "short" });
    var o = {}; JFMT.formatToParts(new Date(t)).forEach(function (p) { o[p.type] = p.value; });
    return { y: parseInt(o.year, 10), m: parseInt(o.month, 10), d: parseInt(o.day, 10), wd: ["Sat", "Sun", "Mon", "Tue", "Wed", "Thu", "Fri"].indexOf(o.weekday) };
  }
  function dayKey(t) { var o = tehranParts(new Date(t)); return o.year + "-" + o.month + "-" + o.day; }
  function tehNoon(t) { return Date.parse(dayKey(t) + "T12:00:00+03:30"); }
  function calendarHTML(jobs, st) {
    var cal = v8ui.cal, anchor = cal.anchor || tehNoon(Date.now()), today = dayKey(Date.now());
    JMON = JMON || new Intl.DateTimeFormat("fa-IR-u-ca-persian", { timeZone: TZ, month: "long", year: "numeric" });
    JDAY = JDAY || new Intl.DateTimeFormat("fa-IR-u-ca-persian", { timeZone: TZ, day: "numeric" });
    var byDay = {};
    jobs.forEach(function (j) { var t = tsOf(j.publish_at); if (t == null) return; (byDay[dayKey(t)] = byDay[dayKey(t)] || []).push(j); });
    Object.keys(byDay).forEach(function (k) { byDay[k].sort(function (a, b) { return tsOf(a.publish_at) - tsOf(b.publish_at); }); });
    var WD = ["ش", "ی", "د", "س", "چ", "پ", "ج"];
    var days = [], lead = 0, title;
    if (cal.mode === "week") {
      var start = anchor - jparts(anchor).wd * DAY;
      for (var i = 0; i < 7; i++) days.push(start + i * DAY);
      title = fmtFmt(days[0], { month: "long", day: "numeric" }) + " تا " + fmtFmt(days[6], { month: "long", day: "numeric" });
    } else {
      var p = jparts(anchor), first = anchor - (p.d - 1) * DAY;
      for (var t = first; jparts(t).m === p.m; t += DAY) days.push(t);
      lead = jparts(first).wd; title = JMON.format(new Date(anchor));
    }
    var h = '<div class="cal" id="cal" data-mode="' + cal.mode + '"><div class="calbar"><div class="seg small"><button data-cal="month" class="' + (cal.mode === "month" ? "on" : "") + '">ماه</button><button data-cal="week" class="' + (cal.mode === "week" ? "on" : "") + '">هفته</button></div>' +
      '<button class="ghost sm" data-cal="prev" aria-label="قبلی">→</button><b class="caltitle">' + esc(title) + '</b><button class="ghost sm" data-cal="next" aria-label="بعدی">←</button><button class="ghost sm" data-cal="today">امروز</button></div>';
    if (cal.mode === "month") {
      h += '<div class="calgrid">' + WD.map(function (w) { return '<span class="wd">' + w + "</span>"; }).join("");
      for (var l = 0; l < lead; l++) h += '<span class="cd blank"></span>';
      days.forEach(function (d) {
        var k = dayKey(d), js = byDay[k] || [];
        h += '<button class="cd' + (k === today ? " today" : "") + (k === cal.day ? " sel" : "") + (js.length ? " has" : "") + '" data-cal="day" data-day="' + k + '"><span class="dn">' + JDAY.format(new Date(d)) + '</span><span class="cdots">' +
          js.slice(0, 4).map(function (j) { return '<i class="s-publish-' + st[j.id] + '"></i>'; }).join("") + (js.length > 4 ? "<em>+" + fa(js.length - 4) + "</em>" : "") + "</span></button>";
      });
      h += "</div>";
      var dsel = cal.day && byDay[cal.day] ? cal.day : null;
      h += '<div class="calday">' + (dsel ? "<h4>" + esc(fmtFmt(Date.parse(dsel + "T12:00:00+03:30"), { weekday: "long", month: "long", day: "numeric" })) + "</h4>" + byDay[dsel].map(function (j) { return calRow(j, st[j.id]); }).join("") :
        '<div class="muted-note">روی یک روز بزن تا انتشارهایش را ببینی.</div>') + "</div>";
    } else {
      h += '<div class="calweek">' + days.map(function (d) {
        var k = dayKey(d), js = byDay[k] || [];
        return '<div class="wrow' + (k === today ? " today" : "") + '"><div class="wh">' + esc(fmtFmt(d, { weekday: "long", day: "numeric", month: "short" })) + "</div>" +
          (js.length ? js.map(function (j) { return calRow(j, st[j.id]); }).join("") : '<div class="muted-note">—</div>') + "</div>";
      }).join("") + "</div>";
    }
    return h + "</div>";
  }
  function calRow(j, s) {
    return '<a class="crow" href="#/publish?job=' + esc(j.id) + '" data-id="' + esc(j.id) + '"><span class="ct">' + esc(fmtTime(j.publish_at)) + '</span><span class="cti">' + esc(j.title || "(بدون عنوان)") + "</span>" + stChip("publish", s) + "</a>";
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
    viewSeq++;
    if (!authed()) { if (!document.getElementById("lf")) loginView(); return; }
    if (state.error && !state.config) { app.innerHTML = '<div class="loading">بارگذاری داده‌ها ناموفق بود. اتصال را بررسی کنید.</div>'; return; }
    if (!state.config) return;
    var h = location.hash || "#/";
    var br, gl, idr, a = h.match(/^#\/a\/([\w-]+)\/(\w+)/), pb = h.match(/^#\/publish(?:\/([\w-]+))?(?:\/(\w+))?/);
    if (a) analyticsView(a[1], a[2]);
    else if (pb) publishView(pb[1], pb[2]);
    else if (/^#\/settings/.test(h)) settingsView();
    else if ((br = h.match(/^#\/brain(?:\/([\w-]+))?(?:\/(\w+))?/))) { if (br[1]) brainWorkView(br[1], br[2]); else brainHomeView(); }
    else if ((gl = h.match(/^#\/gallery(?:\/([\w-]+))?(?:\/(\w+))?/))) { if (gl[1]) galleryWorkView(gl[1], gl[2]); else galleryHomeView(); }
    else if ((idr = h.match(/^#\/identity(?:\/([\w-]+))?/))) { if (idr[1]) identityView(idr[1]); else identityHomeView(); }
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
      getJSON("data/comments.json", true).catch(function () { return { channels: {} }; }),
      getJSON("data/buffer.json", true).catch(function () { return null; })
    ]).then(function (res) {
      state.config = res[0]; state.latest = res[1]; state.history = res[2]; state.postsHist = res[3]; state.comments = res[4]; state.buffer = res[5]; state.error = null;
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
