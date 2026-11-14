/* Social pages dashboard — vanilla JS, hash routing, no framework. */
(function () {
  "use strict";

  var VAULT_URL = "https://vault.vaultwarden.com/";
  var TZ = "Asia/Tehran";
  var DAY = 86400000;
  var PLATFORMS = ["instagram", "youtube", "aparat", "tiktok"];
  var PNAME = { instagram: "اینستاگرام", youtube: "یوتیوب", aparat: "آپارات", tiktok: "تیک‌تاک" };
  var FOLLOW_LABEL = { instagram: "دنبال‌کننده", youtube: "مشترک", aparat: "دنبال‌کننده", tiktok: "دنبال‌کننده" };
  var POSTS_LABEL = { instagram: "پست", youtube: "ویدیو", aparat: "ویدیو", tiktok: "ویدیو" };

  var AUTH_SALT = "sp-panel-v1|";
  var AUTH_HASH = "1b906a20e9fea1a47f58c9c56aa49688acb2dd0ba5fba3188825f252401a3ba8";
  var AUTH_KEY = "sp_auth";
  var THEME_KEY = "sp_theme";

  var state = { config: null, latest: null, history: null, error: null, busy: false };
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
    return fa(n);
  }
  function pct(x) { return x == null ? "—" : fa(x, { maximumFractionDigits: 2 }) + "٪"; }
  function signed(n) {
    if (n == null) return "—";
    if (n === 0) return "۰";
    return (n > 0 ? "+" : "−") + fa(Math.abs(n));
  }
  function fmtDateTime(iso) {
    if (!iso) return "—";
    try {
      return new Intl.DateTimeFormat("fa-IR", { timeZone: TZ, year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
    } catch (e) { return iso; }
  }
  function fmtShort(iso) {
    if (!iso) return "—";
    try {
      return new Intl.DateTimeFormat("fa-IR", { timeZone: TZ, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
    } catch (e) { return iso; }
  }
  function fmtDay(d) { // d: 'YYYY-MM-DD' (Tehran date)
    try {
      return new Intl.DateTimeFormat("fa-IR", { timeZone: TZ, month: "short", day: "numeric" }).format(new Date(d + "T12:00:00+03:30"));
    } catch (e) { return d; }
  }
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
  function tehranDate(dt) { // -> 'YYYY-MM-DD'
    var p = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(dt);
    var o = {}; p.forEach(function (x) { o[x.type] = x.value; });
    return o.year + "-" + o.month + "-" + o.day;
  }

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

  // ------------------------------------------------------------ channel helpers
  function pageData(cp) { return (state.latest && state.latest.pages[cp.id]) || { id: cp.id, name: cp.name, platforms: {} }; }
  function hasData(r) { return r && (r.ok || r.stale); }
  function lastActivity(page) {
    var best = null;
    PLATFORMS.forEach(function (pl) {
      var r = page.platforms[pl]; if (!hasData(r)) return;
      (r.recent || []).forEach(function (p) { if (p.published && (!best || p.published > best)) best = p.published; });
    });
    return best;
  }
  function avatarOf(cp, page) {
    if (cp.logo) return cp.logo;
    var order = ["youtube", "instagram", "tiktok", "aparat"];
    for (var i = 0; i < order.length; i++) { var r = page.platforms[order[i]]; if (r && r.avatar) return r.avatar; }
    return null;
  }
  function initials(name) { return esc(String(name || "?").replace(/[^A-Za-z\u0600-\u06FF ]/g, "").split(" ").filter(Boolean).slice(0, 2).map(function (w) { return w[0]; }).join("").toUpperCase() || "?"); }
  function logoHTML(cp, page, cls) {
    var a = avatarOf(cp, page);
    var fb = '<span class="logo-fb">' + initials(cp.name) + "</span>";
    if (!a) return '<span class="clogo ' + (cls || "") + '">' + fb + "</span>";
    return '<span class="clogo ' + (cls || "") + '"><img alt="" referrerpolicy="no-referrer" src="' + esc(a) + '" onerror="this.parentNode.innerHTML=\'' + fb.replace(/'/g, "\\'") + '\'"></span>';
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
  function seenMap() { try { return JSON.parse(localStorage.getItem("sp_seen") || "{}"); } catch (e) { return {}; } }
  function saveSeen(m) { try { localStorage.setItem("sp_seen", JSON.stringify(m)); } catch (e) {} }
  function newCount(cp, page) {
    var seen = seenMap(), cur = interactions(page);
    if (seen[cp.id] == null) { seen[cp.id] = cur; saveSeen(seen); return 0; }
    return Math.max(0, cur - seen[cp.id]);
  }
  function markSeen(cp, page) { var seen = seenMap(); seen[cp.id] = interactions(page); saveSeen(seen); }
  function openSet() { try { return JSON.parse(sessionStorage.getItem("sp_open") || "{}"); } catch (e) { return {}; } }
  function saveOpen(o) { try { sessionStorage.setItem("sp_open", JSON.stringify(o)); } catch (e) {} }

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
    return '<header class="topbar">' +
      '<button class="refresh-btn' + (state.busy ? " spin" : "") + '" id="refresh" aria-label="به‌روزرسانی همه‌ی کانال‌ها" title="به‌روزرسانی همه‌ی کانال‌ها">' + ICON_REFRESH + "</button>" +
      '<div class="brand"><b>' + esc(title) + "</b></div>" +
      '<div class="tbox" title="آخرین به‌روزرسانی پنل">' + ICON_CLOCK + '<span class="ul"><b>' + esc(fmtShort(L && L.updated_at)) + "</b><span>" + esc(ago(L && L.updated_at)) + "</span></span></div>" +
      '<button class="tbox" id="theme" aria-label="تغییر تم">' + (dark ? ICON_SUN : ICON_MOON) + '<span class="tlabel">' + (dark ? "لایت" : "دارک") + "</span></button>" +
      "</header>";
  }
  function bindTopbar() {
    var rb = document.getElementById("refresh");
    if (rb) rb.onclick = refreshAll;
    var tb = document.getElementById("theme");
    if (tb) tb.onclick = function () { setTheme(currentTheme() === "dark" ? "light" : "dark"); render(); };
  }
  function toast(msg) {
    var t = document.createElement("div"); t.className = "toast"; t.textContent = msg;
    document.body.appendChild(t); setTimeout(function () { t.remove(); }, 2600);
  }
  function refreshAll() {
    if (state.busy) return;
    state.busy = true; render();
    var before = state.latest && state.latest.updated_at;
    load(true).then(function () {
      state.busy = false; render();
      var now = state.latest && state.latest.updated_at;
      toast(now && now !== before ? "همه‌ی کانال‌ها به‌روز شد" : "داده‌ها به‌روز هستند · آخرین بررسی " + ago(now));
    });
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
    html += "</div>";
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
    var list = state.config.pages.map(function (cp, i) { var pg = pageData(cp); return { cp: cp, page: pg, last: lastActivity(pg), i: i }; });
    list.sort(function (a, b) {
      if (a.last && b.last) return a.last < b.last ? 1 : -1;
      if (a.last) return -1; if (b.last) return 1; return a.i - b.i;
    });
    html += '<div class="clist">';
    list.forEach(function (x) {
      var cp = x.cp, page = x.page, open = !!opened[cp.id];
      var nc = newCount(cp, page);
      html += '<div class="cgroup' + (open ? " open" : "") + '">';
      html += '<button class="cbox" data-id="' + esc(cp.id) + '" aria-expanded="' + open + '">' +
        logoHTML(cp, page) +
        '<span class="cname">' + esc(cp.name) + "</span>" +
        '<span class="bell' + (nc ? " on" : "") + '" title="' + (nc ? "لایک یا کامنت جدید" : "چیز جدیدی نیست") + '">' + ICON_BELL + (nc ? "<i>" + esc(compact(nc)) + "</i>" : "") + "</span>" +
        '<span class="pm">' + (open ? "−" : "+") + "</span></button>";
      if (open) {
        html += '<div class="branches">';
        PLATFORMS.forEach(function (pl) {
          var r = page.platforms[pl]; if (!r) return;
          var handle = pl === "tiktok" ? "@" + r.handle : r.handle;
          html += '<div class="branch">' +
            '<a class="bnet" href="' + esc(r.url) + '" target="_blank" rel="noopener">' + picon(pl) +
            '<span class="bt"><b>' + PNAME[pl] + '</b><span class="bh">' + esc(handle) + "</span></span></a>" +
            '<a class="bbtn" href="' + esc(LOGIN_URL[pl]) + '" target="_blank" rel="noopener" title="ورود به ' + PNAME[pl] + '">' + ICON_LOGIN + "<span>ورود</span></a>" +
            '<a class="bbtn chart" href="#/a/' + esc(cp.id) + "/" + pl + '" title="آمار ' + PNAME[pl] + '">' + ICON_CHART + "</a>" +
            "</div>";
        });
        html += "</div>";
      }
      html += "</div>";
    });
    html += "</div>";
    html += '<p class="footnote">زنگوله یعنی از آخرین باری که این کانال را باز کردی، لایک یا کامنت تازه آمده.</p>';
    app.innerHTML = html;
    bindTopbar();
    document.getElementById("back").onclick = function () { location.hash = "#/"; };
    Array.prototype.forEach.call(document.querySelectorAll(".cbox"), function (b) {
      b.onclick = function () {
        var id = b.getAttribute("data-id"), o = openSet();
        o[id] = !o[id]; saveOpen(o);
        if (o[id]) { var cp = state.config.pages.filter(function (p) { return p.id === id; })[0]; markSeen(cp, pageData(cp)); }
        var y = window.scrollY; channelsView(); window.scrollTo(0, y);
      };
    });
  }

  // -------------------------------------------------------------- analytics
  function sumOf(posts, k) {
    var have = posts.filter(function (p) { return p[k] != null; });
    if (!have.length) return null;
    return have.reduce(function (s, p) { return s + p[k]; }, 0);
  }
  function rateOf(posts, k) { // sum(k) / sum(views) over posts that have both
    var both = posts.filter(function (p) { return p[k] != null && p.views; });
    if (!both.length) return null;
    var a = 0, v = 0; both.forEach(function (p) { a += p[k]; v += p.views; });
    return v ? (a / v) * 100 : null;
  }
  function avgRetention(posts) {
    var have = posts.filter(function (p) { return p.retention != null; });
    if (!have.length) return null;
    return have.reduce(function (s, p) { return s + p.retention; }, 0) / have.length;
  }
  function kpi(label, value, sub, note) {
    return '<div class="kpi"><div class="k">' + esc(label) + '</div><div class="v">' + esc(value) + "</div>" +
      (sub ? '<div class="pct">' + esc(sub) + "</div>" : "") + (note ? '<div class="n">' + esc(note) + "</div>" : "") + "</div>";
  }
  function barChart(posts, valFn, fmt, label) {
    var vals = posts.map(valFn);
    if (!posts.length || vals.every(function (v) { return v == null; })) return '<div class="chart"><div class="empty">' + esc(label) + "</div></div>";
    var W = 320, H = 150, top = 18, bot = 20, n = posts.length;
    var max = Math.max.apply(null, vals.map(function (v) { return v || 0; })) || 1;
    var slot = W / n, bw = Math.min(28, slot * 0.62);
    var s = '<svg viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="' + esc(label) + '">';
    s += '<line x1="0" y1="' + (H - bot) + '" x2="' + W + '" y2="' + (H - bot) + '" stroke="currentColor" stroke-opacity=".15"/>';
    vals.forEach(function (v, i) {
      var cx = W - slot * (i + 0.5); // newest on the right (RTL)
      var h = v == null ? 0 : ((H - top - bot) * v) / max;
      var y = H - bot - h;
      if (v != null) {
        s += '<rect x="' + (cx - bw / 2).toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + Math.max(h, 1.5).toFixed(1) + '" rx="4" fill="url(#g)"/>';
        if (n <= 12) s += '<text x="' + cx.toFixed(1) + '" y="' + (y - 4).toFixed(1) + '" text-anchor="middle" font-size="9" fill="currentColor" fill-opacity=".75">' + esc(fmt(v)) + "</text>";
      } else {
        s += '<text x="' + cx.toFixed(1) + '" y="' + (H - bot - 4) + '" text-anchor="middle" font-size="9" fill="currentColor" fill-opacity=".4">—</text>';
      }
      s += '<text x="' + cx.toFixed(1) + '" y="' + (H - 6) + '" text-anchor="middle" font-size="9" fill="currentColor" fill-opacity=".5">' + fa(i + 1) + "</text>";
    });
    s += '<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#a855f7"/><stop offset="1" stop-color="#7c3aed"/></linearGradient></defs></svg>';
    return '<div class="chart bars">' + s + '<div class="axis"><span>۱ = جدیدترین</span><span>' + esc(label) + "</span></div></div>";
  }
  function lineChart(series, label) {
    if (series.length < 2) return '<div class="chart"><div class="empty">برای نمودار روند، دست‌کم دو روز داده لازم است</div></div>';
    var W = 320, H = 110, P = 10, n = series.length;
    var vals = series.map(function (p) { return p.f; });
    var min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
    if (min === max) { min = Math.max(0, min - 1); max = max + 1; }
    var pts = series.map(function (p, i) { return [W - (P + (i * (W - 2 * P)) / (n - 1)), H - P - ((p.f - min) * (H - 2 * P)) / (max - min)]; });
    var line = pts.map(function (q) { return q[0].toFixed(1) + "," + q[1].toFixed(1); }).join(" ");
    return '<div class="chart" style="color:var(--accent)"><svg viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="none" role="img" aria-label="' + esc(label) + '">' +
      '<polyline points="' + line + '" fill="none" stroke="currentColor" stroke-width="2.4" vector-effect="non-scaling-stroke" stroke-linejoin="round"/></svg>' +
      '<div class="axis"><span>' + esc(fmtDay(series[0].d)) + " · " + fa(series[0].f) + "</span><span>" + esc(fmtDay(series[n - 1].d)) + " · " + fa(series[n - 1].f) + "</span></div></div>";
  }

  function analyticsView(pid, pl) {
    var cp = state.config.pages.filter(function (p) { return p.id === pid; })[0];
    if (!cp || PLATFORMS.indexOf(pl) < 0) { location.hash = "#/channels"; return; }
    var page = pageData(cp), r = page.platforms[pl] || {};
    var ok = hasData(r);
    var posts = (r.recent || []).slice().sort(function (a, b) { return (b.published || "") > (a.published || "") ? 1 : -1; });
    var html = topbar(cp.name);
    html += '<button class="back" id="back">→ کانال‌ها</button>';
    html += '<div class="ahead">' + logoHTML(cp, page, "big") + '<div class="at"><h1>' + esc(cp.name) + "</h1>" +
      '<div class="asub">' + picon(pl) + "<span>" + PNAME[pl] + '</span><a href="' + esc(r.url || "#") + '" target="_blank" rel="noopener">باز کردن ↗</a></div></div></div>';

    if (!ok) {
      var why = pl === "instagram" ? "اینستاگرام بدون دسترسی رسمی (توکن Graph API) اجازه‌ی خواندن آمار نمی‌دهد."
        : /not found/i.test(r.error || "") ? "این آیدی در " + PNAME[pl] + " پیدا نشد." : "داده‌ای از " + PNAME[pl] + " دریافت نشد.";
      html += '<div class="alert bad">' + esc(why) + "</div>";
    } else if (r.stale) {
      html += '<div class="alert">آخرین تلاش ناموفق بود؛ عددها مربوط به ' + esc(fmtDateTime(r.fetched_at)) + " هستند.</div>";
    }

    // account summary
    var hs = (((state.history && state.history.series) || {})[pid + "/" + pl] || []).filter(function (p) { return p.f != null; });
    var g = hs.length >= 2 ? hs[hs.length - 1].f - hs[0].f : null;
    html += '<div class="kpis three">' +
      kpi(FOLLOW_LABEL[pl], ok ? fa(r.followers) : "—", g != null ? (g >= 0 ? "+" : "−") + fa(Math.abs(g)) + " از " + fmtDay(hs[0].d) : "") +
      kpi("کل " + POSTS_LABEL[pl] + "‌ها", ok ? fa(r.posts) : "—") +
      kpi(pl === "tiktok" ? "کل لایک‌ها" : "کل بازدیدها", ok ? fa(pl === "tiktok" ? r.total_likes : r.total_views) : "—") +
      "</div>";

    // content performance (recent posts)
    var views = sumOf(posts, "views"), likes = sumOf(posts, "likes"), comments = sumOf(posts, "comments");
    var shares = sumOf(posts, "shares"), saves = sumOf(posts, "saves"), ret = avgRetention(posts);
    var lr = rateOf(posts, "likes"), cr = rateOf(posts, "comments"), sr = rateOf(posts, "shares"), svr = rateOf(posts, "saves");
    var why2 = function (k) {
      if (!posts.length) return "";
      if (k === "comments" && pl === "youtube") return "با کلید YouTube API";
      if (k === "likes" && pl === "aparat") return "آپارات عمومی نمی‌دهد";
      return NO_ACCESS;
    };
    html += "<h3>عملکرد " + (posts.length ? fa(posts.length) + " " + POSTS_LABEL[pl] + "ِ آخر" : "محتوا") + "</h3>";
    html += '<div class="kpis">' +
      kpi("بازدید", views == null ? "—" : fa(views), posts.length && views != null ? "میانگین " + fa(Math.round(views / posts.length)) : "", views == null && posts.length ? why2("views") : "") +
      kpi("لایک", likes == null ? "—" : fa(likes), lr == null ? "" : pct(lr) + " از بازدید", likes == null ? why2("likes") : "") +
      kpi("کامنت", comments == null ? "—" : fa(comments), cr == null ? "" : pct(cr) + " از بازدید", comments == null ? why2("comments") : "") +
      kpi("اشتراک‌گذاری", shares == null ? "—" : fa(shares), sr == null ? "" : pct(sr) + " از بازدید", shares == null ? NO_ACCESS : "") +
      kpi("ذخیره", saves == null ? "—" : fa(saves), svr == null ? "" : pct(svr) + " از بازدید", saves == null ? NO_ACCESS : "") +
      kpi("نگهداشت تا انتها", ret == null ? "—" : pct(ret), "", ret == null ? NO_ACCESS : "") +
      "</div>";

    if (posts.length) {
      html += "<h3>بازدید هر " + POSTS_LABEL[pl] + "</h3>" + barChart(posts, function (p) { return p.views; }, compact, "بازدید");
      html += "<h3>نرخ لایک هر " + POSTS_LABEL[pl] + " (٪ از بازدید)</h3>" +
        barChart(posts, function (p) { return p.likes != null && p.views ? (p.likes / p.views) * 100 : null; }, function (v) { return fa(v, { maximumFractionDigits: 1 }); },
          pl === "aparat" ? "آپارات لایک را عمومی نمی‌دهد" : "نرخ لایک");
    }
    html += "<h3>روند " + FOLLOW_LABEL[pl] + "‌ها</h3>" + lineChart(hs, "روند");

    // content list, newest first
    html += "<h3>محتوا به ترتیب آخرین انتشار</h3>";
    if (!posts.length) {
      html += '<div class="muted-note">' + esc(!ok ? "داده‌ای نیست" : r.posts === 0 ? "هنوز " + POSTS_LABEL[pl] + "ی منتشر نشده" :
        pl === "tiktok" ? "تیک‌تاک آمار تک‌ویدیو را بدون دسترسی به اکانت نمی‌دهد" : "فهرست در دسترس نیست") + "</div>";
    } else {
      html += '<div class="posts">' + posts.map(function (p, i) {
        var m = [];
        m.push("بازدید " + fa(p.views));
        m.push("لایک " + fa(p.likes) + (p.likes != null && p.views ? " (" + pct((p.likes / p.views) * 100) + ")" : ""));
        m.push("کامنت " + fa(p.comments));
        if (p.shares != null) m.push("اشتراک " + fa(p.shares));
        if (p.saves != null) m.push("ذخیره " + fa(p.saves));
        if (p.retention != null) m.push("نگهداشت " + pct(p.retention));
        return '<a class="post" href="' + esc(p.url) + '" target="_blank" rel="noopener">' +
          '<span class="pn">' + fa(i + 1) + "</span>" +
          (p.thumb ? '<img loading="lazy" referrerpolicy="no-referrer" alt="" src="' + esc(p.thumb) + '" onerror="this.remove()">' : "") +
          '<div class="body"><div class="pt">' + esc(p.title || "(بدون عنوان)") + '</div><div class="pm2">' + esc(p.published ? ago(p.published) : "تاریخ نامشخص") + "</div>" +
          '<div class="pm">' + m.map(function (x) { return "<span>" + esc(x) + "</span>"; }).join("") + "</div></div></a>";
      }).join("") + "</div>";
    }
    html += '<p class="footnote">اشتراک‌گذاری، ذخیره و نگهداشت مخاطب فقط از داخل خود اکانت (YouTube Studio، Instagram Insights، TikTok Analytics) خوانده می‌شوند. «—» یعنی عدد در دسترس نبود؛ هیچ عددی حدس زده نمی‌شود.</p>';
    app.innerHTML = html;
    window.scrollTo(0, 0);
    bindTopbar();
    document.getElementById("back").onclick = function () { location.hash = "#/channels"; };
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
    var a = h.match(/^#\/a\/([\w-]+)\/(\w+)/);
    if (a) analyticsView(a[1], a[2]);
    else if (/^#\/(channels|p\/)/.test(h)) channelsView();
    else homeView();
  }
  function getJSON(url, fresh) {
    return fetch(url + (fresh ? "?t=" + Date.now() : ""), { cache: "no-store" }).then(function (r) {
      if (!r.ok) throw new Error(url + " " + r.status);
      return r.json();
    });
  }
  function load(fresh) {
    return Promise.all([
      getJSON("config.json", fresh),
      getJSON("data/latest.json", fresh).catch(function () { return null; }),
      getJSON("data/history.json", fresh).catch(function () { return { series: {} }; })
    ]).then(function (res) {
      state.config = res[0]; state.latest = res[1]; state.history = res[2]; state.error = null;
      render();
    }).catch(function (e) { state.error = e; render(); });
  }

  window.addEventListener("hashchange", render);
  if (!authed()) loginView();
  load(false);

  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    window.addEventListener("load", function () { navigator.serviceWorker.register("sw.js").catch(function () {}); });
  }
})();
