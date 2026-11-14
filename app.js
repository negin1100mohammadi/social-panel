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

  var state = { config: null, latest: null, history: null, error: null };
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

  // ------------------------------------------------------------ metrics
  function postDates(r) {
    return (r.recent || []).map(function (p) { return p.published ? new Date(p.published).getTime() : null; })
      .filter(function (t) { return t && !isNaN(t); }).sort(function (a, b) { return b - a; });
  }

  function metrics(pageId, plat, r) {
    var m = { notes: {} };
    var now = Date.now();
    var dates = postDates(r);
    var recentN = (r.recent || []).length;

    // engagement
    var eng = (r.recent || []).filter(function (p) { return p.likes != null; });
    if (!r.followers) {
      m.er = null;
      m.notes.er = r.followers === 0 ? "دنبال‌کننده صفر است" : "تعداد دنبال‌کننده در دسترس نیست";
    } else if (!eng.length) {
      m.er = null;
      m.notes.er = plat === "aparat" ? "آپارات لایک را عمومی نمی‌دهد" :
        plat === "tiktok" ? "آمار تک‌ویدیو در دسترس نیست" : "لایک پست‌ها در دسترس نیست";
    } else {
      var sum = 0, anyComments = false;
      eng.forEach(function (p) { sum += (p.likes + (p.comments || 0)) / r.followers; if (p.comments != null) anyComments = true; });
      m.er = (sum / eng.length) * 100;
      m.notes.er = "میانگین " + fa(eng.length) + " پست اخیر" + (anyComments ? "" : " (بدون کامنت)");
    }

    // posting frequency / days since last post
    if (r.posts === 0 && !dates.length) {
      m.p7 = 0; m.p30 = 0; m.since = null; m.noPosts = true;
    } else if (dates.length) {
      m.p7 = dates.filter(function (t) { return now - t <= 7 * DAY; }).length;
      m.p30 = dates.filter(function (t) { return now - t <= 30 * DAY; }).length;
      m.since = Math.floor((now - dates[0]) / DAY);
      m.lastPost = new Date(dates[0]).toISOString();
      if (m.p30 === recentN && recentN >= 12) { m.notes.p30 = "حداقل؛ فقط " + fa(recentN) + " پست آخر خوانده شد"; }
    } else {
      m.p7 = m.p30 = m.since = null;
      m.notes.freq = plat === "tiktok" ? "تیک‌تاک تاریخ ویدیوها را عمومی نمی‌دهد" : "تاریخ پست‌ها در دسترس نیست";
    }

    // growth over the last 7 days (from history)
    var pts = ((state.history && state.history.series) || {})[pageId + "/" + plat] || [];
    pts = pts.filter(function (p) { return p.f != null; });
    m.series = pts;
    if (pts.length >= 2 && r.followers != null) {
      var today = tehranDate(new Date());
      var target = tehranDate(new Date(now - 7 * DAY));
      var base = null;
      for (var i = pts.length - 1; i >= 0; i--) { if (pts[i].d <= target) { base = pts[i]; break; } }
      if (base) { m.g7 = r.followers - base.f; }
      else {
        m.g7 = r.followers - pts[0].f;
        m.notes.g7 = "از " + fmtDay(pts[0].d) + " (تاریخچه کمتر از ۷ روز)";
      }
      if (pts[0].d === today) { m.g7 = null; }
    } else {
      m.g7 = null;
      m.notes.g7 = r.followers == null ? "تعداد دنبال‌کننده در دسترس نیست" : "تاریخچه هنوز کافی نیست";
    }

    // verdict
    var v;
    if (!r.ok && !r.stale) v = { k: "", t: "بدون داده" };
    else if (m.noPosts) v = { k: "bad", t: "غیرفعال" };
    else if (m.since == null) v = { k: "", t: "نامشخص" };
    else if (m.since <= 7 && m.p7 >= 2) v = { k: "good", t: "فعال" };
    else if (m.since <= 21) v = { k: "warn", t: "کم‌کار" };
    else v = { k: "bad", t: "غیرفعال" };
    m.verdict = v;
    m.text = verdictText(plat, r, m);
    return m;
  }

  function verdictText(plat, r, m) {
    if (!r.ok && !r.stale) return "داده‌ای از " + PNAME[plat] + " دریافت نشد، پس ارزیابی ممکن نیست.";
    if (m.noPosts) return "هنوز هیچ " + POSTS_LABEL[plat] + " عمومی‌ای منتشر نشده است.";
    if (m.since == null) {
      return "کل " + POSTS_LABEL[plat] + "‌ها: " + fa(r.posts) + ". تاریخ انتشار در دسترس نیست، پس نظم انتشار قابل سنجش نیست.";
    }
    var s = "در ۷ روز گذشته " + fa(m.p7) + " و در ۳۰ روز گذشته " + fa(m.p30) + " " + POSTS_LABEL[plat] + " منتشر شده؛ ";
    s += m.since === 0 ? "آخرین انتشار کمتر از یک روز پیش بوده." : "آخرین انتشار " + fa(m.since) + " روز پیش بوده.";
    if (m.g7 != null) s += " رشد دنبال‌کننده: " + signed(m.g7) + ".";
    if (m.verdict.t === "فعال") s += " ریتم انتشار خوب است؛ همین را حفظ کنید.";
    else if (m.verdict.t === "کم‌کار") s += " برای رشد، دست‌کم هفته‌ای دو انتشار پیشنهاد می‌شود.";
    else s += " پیج عملاً متوقف است؛ از سرگیری انتشار اولویت دارد.";
    return s;
  }

  function pageSummary(page) {
    var total = 0, known = 0, missing = [], best = null, lastPost = null, verdicts = [];
    PLATFORMS.forEach(function (pl) {
      var r = page.platforms[pl]; if (!r) return;
      if (r.followers != null && (r.ok || r.stale)) { total += r.followers; known++; } else missing.push(PNAME[pl]);
      var m = metrics(page.id, pl, r);
      verdicts.push(m.verdict.t);
      if (m.lastPost && (!lastPost || m.lastPost > lastPost)) lastPost = m.lastPost;
    });
    var order = ["فعال", "کم‌کار", "غیرفعال", "نامشخص", "بدون داده"];
    verdicts.sort(function (a, b) { return order.indexOf(a) - order.indexOf(b); });
    best = verdicts[0] || "بدون داده";
    var anyPosts = PLATFORMS.some(function (pl) { var r = page.platforms[pl]; return r && r.posts > 0; });
    return { total: known ? total : null, missing: missing, verdict: best, lastPost: lastPost, anyPosts: anyPosts };
  }
  function pillClass(t) { return t === "فعال" ? "good" : t === "کم‌کار" ? "warn" : t === "غیرفعال" ? "bad" : ""; }

  // -------------------------------------------------------------- views
  var ICON_LOCK = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="10.5" width="16" height="10" rx="2.5"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/><circle cx="12" cy="15.5" r="1.3"/></svg>';

  function homeView() {
    var L = state.latest;
    var html = '<header class="top"><div><h1>پنل پیج‌ها</h1><div class="sub">آخرین بروزرسانی: ' +
      esc(fmtDateTime(L && L.updated_at)) + ' <span class="muted-note nowrap">(' + esc(ago(L && L.updated_at)) + ')</span></div></div>' +
      '<button class="icon-btn" id="reload" aria-label="بارگذاری دوباره">↻</button></header>';

    html += '<a class="vault" href="' + VAULT_URL + '" target="_blank" rel="noopener noreferrer">' +
      '<span class="vi">' + ICON_LOCK + '</span><span><div class="vt">پسوورد منیجر</div>' +
      '<div class="vs">باز کردن Vaultwarden در زبانه‌ی جدید</div></span><span class="arrow">↗</span></a>';

    html += '<div class="section-title">پیج‌ها</div><div class="pages">';
    state.config.pages.forEach(function (cp) {
      var page = (L && L.pages[cp.id]) || { id: cp.id, name: cp.name, platforms: {} };
      var s = pageSummary(page);
      var age = s.lastPost ? "آخرین پست: " + ago(s.lastPost) : (s.anyPosts ? "زمان آخرین پست نامشخص" : "هنوز پستی ثبت نشده");
      html += '<a class="pcard" href="#/p/' + esc(cp.id) + '">' +
        '<div class="row1"><div><div class="pname">' + esc(cp.name) + '</div><div class="topic">' + esc(cp.topic_fa || "") + '</div></div>' +
        '<span class="pill ' + pillClass(s.verdict) + '">' + esc(s.verdict) + '</span></div>' +
        '<div class="big"><span class="num">' + esc(compact(s.total)) + '</span><span class="lbl">مجموع دنبال‌کننده</span></div>' +
        '<div class="chips">' + PLATFORMS.map(function (pl) {
          var r = page.platforms[pl]; if (!r) return "";
          var v = (r.ok || r.stale) && r.followers != null ? compact(r.followers) : "—";
          return '<span class="chip"><span class="dot ' + pl + '"></span>' + PNAME[pl] + " " + esc(v) + "</span>";
        }).join("") + '</div>' +
        '<div class="meta"><span class="age">' + esc(age) + '</span>' +
        (s.missing.length ? '<span class="muted-note">نامشخص: ' + esc(s.missing.join("، ")) + "</span>" : "") + "</div></a>";
    });
    html += "</div>";
    html += '<p class="footnote">داده‌ها هر ساعت به‌طور خودکار از صفحات عمومی خوانده می‌شوند. «—» یعنی آن عدد در دسترس نبود؛ هیچ عددی حدس زده نمی‌شود.</p>';
    app.innerHTML = html;
    var rb = document.getElementById("reload");
    if (rb) rb.onclick = function () { load(true); };
  }

  function chartSVG(series, label) {
    if (!series.length) return '<div class="chart"><div class="empty">هنوز داده‌ی تاریخی ثبت نشده</div></div>';
    var W = 320, H = 120, P = 8;
    var vals = series.map(function (p) { return p.f; });
    var min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
    if (min === max) { min = Math.max(0, min - 1); max = max + 1; }
    var n = series.length;
    var pts = series.map(function (p, i) {
      var x = n === 1 ? W / 2 : P + (i * (W - 2 * P)) / (n - 1);
      var y = H - P - ((p.f - min) * (H - 2 * P)) / (max - min);
      return [x, y];
    });
    // RTL reading: newest on the left
    pts = pts.map(function (q) { return [W - q[0], q[1]]; });
    var line = pts.map(function (q) { return q[0].toFixed(1) + "," + q[1].toFixed(1); }).join(" ");
    var area = "M" + pts[0][0].toFixed(1) + "," + (H - P) + " L" + line.replace(/ /g, " L") + " L" + pts[pts.length - 1][0].toFixed(1) + "," + (H - P) + " Z";
    var svg = '<svg viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="none" role="img" aria-label="' + esc(label) + '">' +
      '<line x1="0" y1="' + (H - P) + '" x2="' + W + '" y2="' + (H - P) + '" stroke="currentColor" stroke-opacity=".12"/>' +
      (n > 1 ? '<path d="' + area + '" fill="currentColor" fill-opacity=".08"/>' +
        '<polyline points="' + line + '" fill="none" stroke="currentColor" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/>' : "") +
      pts.map(function (q, i) { return (i === pts.length - 1 || n === 1) ? '<circle cx="' + q[0].toFixed(1) + '" cy="' + q[1].toFixed(1) + '" r="3.5" fill="currentColor"/>' : ""; }).join("") +
      "</svg>";
    var axis = '<div class="axis"><span>' + esc(fmtDay(series[0].d)) + " · " + esc(fa(series[0].f)) + "</span>" +
      (n > 1 ? "<span>" + esc(fmtDay(series[n - 1].d)) + " · " + esc(fa(series[n - 1].f)) + "</span>" : "") + "</div>";
    var note = n < 3 ? '<div class="muted-note" style="text-align:center;padding-top:4px">با هر روز اجرای خودکار، نمودار کامل‌تر می‌شود</div>' : "";
    return '<div class="chart" style="color:var(--accent)">' + svg + axis + note + "</div>";
  }

  function stat(k, v, n) {
    return '<div class="stat"><div class="k">' + esc(k) + '</div><div class="v">' + esc(v) + "</div>" + (n ? '<div class="n">' + esc(n) + "</div>" : "") + "</div>";
  }

  function errorText(plat, r) {
    if (!r.error) return "";
    if (plat === "instagram") return "اینستاگرام اجازه‌ی خواندن عمومی از سرور را نداد. با افزودن توکن Graph API (راهنما در README) این بخش کامل می‌شود.";
    if (/not found/i.test(r.error)) return "این آیدی در " + PNAME[plat] + " پیدا نشد؛ آیدی را در config.json بررسی کنید.";
    return "دریافت داده از " + PNAME[plat] + " ناموفق بود.";
  }

  function platformCard(page, plat) {
    var r = page.platforms[plat];
    if (!r) return "";
    var m = metrics(page.id, plat, r);
    var has = r.ok || r.stale;
    var h = '<section class="plat" id="pl-' + plat + '">';
    h += '<div class="plat-h"><div class="t"><span class="dot ' + plat + '"></span>' + PNAME[plat] +
      '<span class="handle">' + esc(plat === "youtube" || plat === "tiktok" ? (plat === "tiktok" ? "@" + r.handle : r.handle) : r.handle) + "</span></div>" +
      '<a class="link-btn" href="' + esc(r.url) + '" target="_blank" rel="noopener noreferrer">مشاهده کانال ↗</a></div>';
    if (r.stale) h += '<div class="alert">آخرین تلاش ناموفق بود؛ عددها مربوط به ' + esc(fmtDateTime(r.fetched_at)) + " هستند.</div>";
    else if (!r.ok) h += '<div class="alert bad">' + esc(errorText(plat, r)) + "</div>";

    if (!has) {
      h += '<div class="grid">' + stat(FOLLOW_LABEL[plat], "—") + stat("کل " + POSTS_LABEL[plat] + "‌ها", "—") +
        stat("نرخ تعامل", "—") + stat(plat === "tiktok" ? "کل لایک‌ها" : "کل بازدیدها", "—") + "</div>";
      h += '<h3>ارزیابی فعالیت</h3><div class="eval"><div class="head"><span class="pill">بدون داده</span></div>' +
        '<div class="text">' + esc(m.text) + "</div></div>";
      if (r.last_attempt_at) h += '<div class="muted-note" style="margin-top:10px">آخرین تلاش: ' + esc(fmtDateTime(r.last_attempt_at)) + "</div>";
      return h + "</section>";
    }
    var fNote = !has ? "دریافت نشد" : r.followers == null ? "به‌صورت عمومی نمایش داده نمی‌شود" : r.followers_approx ? "عدد گرد‌شده‌ی خود پلتفرم" : "";
    h += '<div class="grid">' +
      stat(FOLLOW_LABEL[plat], has ? fa(r.followers) : "—", fNote) +
      stat("کل " + POSTS_LABEL[plat] + "‌ها", has ? fa(r.posts) : "—", has ? "" : "دریافت نشد") +
      stat("نرخ تعامل", pct(m.er), has ? m.notes.er : "دریافت نشد") +
      (plat === "tiktok" ? stat("کل لایک‌ها", has ? fa(r.total_likes) : "—", has ? "" : "دریافت نشد")
        : stat("کل بازدیدها", has ? fa(r.total_views) : "—", has && r.total_views == null ? "در دسترس نیست" : (has ? "" : "دریافت نشد"))) +
      "</div>";

    h += "<h3>روند " + FOLLOW_LABEL[plat] + "‌ها</h3>" + chartSVG(m.series, "نمودار " + FOLLOW_LABEL[plat] + " " + PNAME[plat]);

    h += '<h3>ارزیابی فعالیت</h3><div class="eval"><div class="head"><span class="pill ' + pillClass(m.verdict.t) + '">' + esc(m.verdict.t) + "</span></div>" +
      '<div class="text">' + esc(m.text) + "</div>" +
      '<div class="grid">' +
      stat("انتشار ۷ روز", fa(m.p7), m.notes.freq || "") +
      stat("انتشار ۳۰ روز", fa(m.p30), m.notes.p30 || m.notes.freq || "") +
      stat("روز از آخرین پست", m.since == null ? "—" : fa(m.since), m.noPosts ? "پستی نیست" : (m.notes.freq || "")) +
      stat("رشد ۷ روز", signed(m.g7), m.notes.g7 || "") +
      "</div></div>";

    var posts = (r.recent || []).slice(0, 5);
    h += "<h3>آخرین " + POSTS_LABEL[plat] + "‌ها</h3>";
    if (!posts.length) {
      var why = !has ? "دریافت نشد" : r.posts === 0 ? "هنوز " + POSTS_LABEL[plat] + "ی منتشر نشده" :
        plat === "tiktok" ? "تیک‌تاک فهرست ویدیوها را بدون ورود نمی‌دهد" : "فهرست در دسترس نیست";
      h += '<div class="muted-note">— ' + esc(why) + "</div>";
    } else {
      h += '<div class="posts">' + posts.map(function (p) {
        var meta = [];
        meta.push(p.published ? ago(p.published) : "تاریخ نامشخص");
        meta.push("بازدید " + fa(p.views));
        meta.push("لایک " + fa(p.likes));
        meta.push("کامنت " + fa(p.comments));
        return '<a class="post" href="' + esc(p.url) + '" target="_blank" rel="noopener noreferrer">' +
          (p.thumb ? '<img loading="lazy" referrerpolicy="no-referrer" alt="" src="' + esc(p.thumb) + '" onerror="this.remove()">' : "") +
          '<div class="body"><div class="pt">' + esc(p.title || "(بدون عنوان)") + '</div><div class="pm">' +
          meta.map(function (x) { return "<span>" + esc(x) + "</span>"; }).join("") + "</div></div></a>";
      }).join("") + "</div>";
      if (posts.some(function (p) { return p.comments == null || p.likes == null; })) {
        h += '<div class="muted-note" style="margin-top:6px">«—» یعنی این پلتفرم آن عدد را به‌صورت عمومی نمی‌دهد' +
          (plat === "youtube" ? " (برای کامنت‌ها کلید YouTube API لازم است)." : ".") + "</div>";
      }
    }
    h += '<div class="muted-note" style="margin-top:10px">منبع: ' + esc(r.source || "—") + " · " + esc(fmtDateTime(r.fetched_at)) + "</div>";
    return h + "</section>";
  }

  function pageView(id) {
    var cp = state.config.pages.filter(function (p) { return p.id === id; })[0];
    if (!cp) { location.hash = "#/"; return; }
    var page = (state.latest && state.latest.pages[id]) || { id: id, name: cp.name, platforms: {} };
    var s = pageSummary(page);
    var html = '<button class="back" id="back">→ همه‌ی پیج‌ها</button>';
    html += '<div class="dash-head"><h1>' + esc(cp.name) + '</h1><div class="sub">' + esc(cp.topic_fa || "") +
      " · آخرین بروزرسانی: " + esc(fmtDateTime(state.latest && state.latest.updated_at)) + "</div></div>";
    html += '<div class="summary">' +
      '<div class="tile"><div class="k">مجموع دنبال‌کننده</div><div class="v">' + esc(fa(s.total)) + "</div>" +
      (s.missing.length ? '<div class="n">بدون ' + esc(s.missing.join("، ")) + "</div>" : "") + "</div>" +
      '<div class="tile"><div class="k">وضعیت کلی</div><div class="v"><span class="pill ' + pillClass(s.verdict) + '">' + esc(s.verdict) + "</span></div></div>" +
      '<div class="tile"><div class="k">آخرین پست</div><div class="v" style="font-size:16px">' + esc(s.lastPost ? ago(s.lastPost) : "—") + "</div>" +
      (s.lastPost ? "" : '<div class="n">' + (s.anyPosts ? "تاریخ در دسترس نیست" : "هنوز پستی نیست") + "</div>") + "</div>" +
      '<div class="tile"><div class="k">پلتفرم‌های دارای داده</div><div class="v">' + esc(fa(PLATFORMS.filter(function (pl) { var r = page.platforms[pl]; return r && (r.ok || r.stale); }).length)) + " از " + fa(PLATFORMS.length) + "</div></div>" +
      "</div>";
    html += '<nav class="tabs">' + PLATFORMS.map(function (pl) {
      return page.platforms[pl] ? '<button class="tab" data-t="pl-' + pl + '"><span class="dot ' + pl + '"></span>' + PNAME[pl] + "</button>" : "";
    }).join("") + "</nav>";
    PLATFORMS.forEach(function (pl) { html += platformCard(page, pl); });
    app.innerHTML = html;
    window.scrollTo(0, 0);
    document.getElementById("back").onclick = function () { location.hash = "#/"; };
    Array.prototype.forEach.call(document.querySelectorAll(".tab"), function (b) {
      b.onclick = function () { var el = document.getElementById(b.getAttribute("data-t")); if (el) el.scrollIntoView({ behavior: "smooth", block: "start" }); };
    });
  }

  function render() {
    if (state.error && !state.config) {
      app.innerHTML = '<div class="loading">بارگذاری داده‌ها ناموفق بود. اتصال را بررسی کنید.</div>';
      return;
    }
    if (!state.config) return;
    var h = location.hash || "#/";
    var m = h.match(/^#\/p\/([\w-]+)/);
    if (m) pageView(m[1]); else homeView();
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
  load(false);

  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    window.addEventListener("load", function () { navigator.serviceWorker.register("sw.js").catch(function () {}); });
  }
})();
