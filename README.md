# پنل پیج‌ها · Social Pages Panel

یک وب‌اپ سبک و نصب‌شدنی (PWA) برای دیدن آمار پنج پیج — Hamrah Seller، Titan Station، FanCATstic Four، Shode Dige و PreTime TV — در اینستاگرام، یوتیوب، آپارات و تیک‌تاک. روی GitHub Pages میزبانی می‌شود و یک GitHub Action رایگان هر ساعت آمار را تازه می‌کند.

A lightweight, installable PWA (Persian, RTL) that shows stats for five pages across Instagram, YouTube, Aparat and TikTok. Hosted on GitHub Pages; a free scheduled GitHub Action refreshes the numbers every hour.

---

## فارسی

### ساختار
| مسیر | کاربرد |
|---|---|
| `index.html`, `app.js`, `styles.css` | خود اپ (بدون فریم‌ورک، مسیریابی با `#`) |
| `manifest.json`, `sw.js`, `icons/` | نصب روی صفحه‌ی اصلی گوشی و کار آفلاین |
| `config.json` | نام پیج‌ها و آیدی هر پلتفرم — برای تغییر آیدی فقط همین فایل را ویرایش کنید |
| `data/latest.json` | آخرین آمار |
| `data/history.json` | یک نقطه در روز برای هر پلتفرم، ۹۰ روز آخر (برای نمودار و «رشد ۷ روز») |
| `scripts/fetch_stats.py` | اسکریپت جمع‌آوری آمار (پایتون ۳ + `requests`) |
| `.github/workflows/refresh.yml` | اجرای ساعتی + انتشار روی GitHub Pages |

دکمه‌ی «پسوورد منیجر» فقط `https://vault.vaultwarden.com/` را در زبانه‌ی جدید باز می‌کند. هیچ رمز یا محتوای گاوصندوقی در این مخزن ذخیره نمی‌شود — و نباید بشود.

### راه‌اندازی GitHub Pages
1. مخزن را روی گیت‌هاب بسازید و این پوشه را push کنید (شاخه‌ی `main`).
2. در مخزن: **Settings → Pages → Build and deployment → Source = GitHub Actions**.
3. **Settings → Actions → General → Workflow permissions** را روی **Read and write permissions** بگذارید (برای commit کردن داده‌ها).
4. به تب **Actions** بروید، workflow «Refresh stats & deploy» را باز کنید و **Run workflow** را بزنید. بعد از چند دقیقه آدرس سایت (مثل `https://<user>.github.io/<repo>/`) در خروجی مرحله‌ی deploy نمایش داده می‌شود.

> چرا Source = GitHub Actions؟ commitهایی که خود Action با `GITHUB_TOKEN` می‌زند ممکن است ساخت خودکار «Deploy from branch» را راه نیندازند؛ برای همین همان workflow بعد از هر بروزرسانی سایت را هم منتشر می‌کند. اگر ترجیح می‌دهید «Deploy from a branch → main / root» را انتخاب کنید، اپ همچنان کار می‌کند (فایل `.nojekyll` هم هست)، فقط ممکن است داده‌ها با تأخیر روی سایت بیایند.

### اجرای دستی
- **Actions → Refresh stats & deploy → Run workflow**.
- یا روی کامپیوتر خودتان: `pip install requests` و بعد `python3 scripts/fetch_stats.py` (برای فقط یک پلتفرم: `python3 scripts/fetch_stats.py youtube`).

### Secretهای اختیاری (داده‌ی کامل‌تر)
در **Settings → Secrets and variables → Actions → New repository secret**:

| نام | چه چیزی اضافه می‌شود | چطور بگیریم |
|---|---|---|
| `YT_API_KEY` | تعداد کامنت‌ها، آمار دقیق ویدیوها، تعداد ویدیو حتی وقتی صفحه‌ی کانال چیزی نشان نمی‌دهد | رایگان: در [Google Cloud Console](https://console.cloud.google.com/) یک پروژه بسازید ← «YouTube Data API v3» را Enable کنید ← Credentials ← Create credentials ← API key. سهمیه‌ی رایگان روزانه (۱۰٬۰۰۰ واحد) برای اجرای ساعتی کافی است. |
| `IG_ACCESS_TOKEN` و `IG_USER_ID` | آمار اینستاگرام (دنبال‌کننده، تعداد پست، لایک و کامنت پست‌های اخیر). **بدون این‌ها اینستاگرام از سرور گیت‌هاب معمولاً مسدود است.** | دست‌کم یکی از اکانت‌ها باید Business یا Creator باشد و به یک Facebook Page وصل باشد. در [Meta for Developers](https://developers.facebook.com/) یک اپ بسازید، محصول Instagram Graph API را اضافه کنید، با Graph API Explorer یک توکن طولانی‌مدت با دسترسی‌های `instagram_basic`, `pages_show_list`, `business_management` بگیرید. `IG_USER_ID` شناسه‌ی عددی همان اکانت اینستاگرام بیزینسی شماست. با Business Discovery، اسکریپت می‌تواند آمار عمومی هر پنج اکانت را بخواند — به شرطی که آن اکانت‌ها هم Business/Creator باشند. توکن طولانی‌مدت حدود ۶۰ روز اعتبار دارد و باید تمدید شود. |

### قوانین داده
- هر پلتفرم جدا امتحان می‌شود؛ اگر یکی شکست بخورد، آخرین عدد موفق با برچسب «قدیمی» نگه داشته می‌شود.
- عددی که خوانده نشود `null` ذخیره و در اپ «—» با توضیح نمایش داده می‌شود. هیچ عددی حدس زده نمی‌شود.
- بین درخواست‌ها مکث می‌شود (`request_delay_seconds` در `config.json`).
- ارزیابی فعالیت: «فعال» = آخرین انتشار ≤ ۷ روز و دست‌کم ۲ انتشار در ۷ روز؛ «کم‌کار» = آخرین انتشار ≤ ۲۱ روز؛ «غیرفعال» = بیشتر از آن یا بدون پست؛ «نامشخص» = تاریخ انتشار در دسترس نیست (مثلاً تیک‌تاک).
- نرخ تعامل = میانگین (لایک + کامنت) ÷ دنبال‌کننده روی پست‌های اخیری که لایکشان در دسترس است.

### نصب روی آیفون
سایت را در Safari باز کنید ← دکمه‌ی Share ← **Add to Home Screen**.

---

## English

### Setup
1. Create a GitHub repo and push this folder to `main`.
2. **Settings → Pages → Source = GitHub Actions.**
3. **Settings → Actions → General → Workflow permissions = Read and write.**
4. **Actions → "Refresh stats & deploy" → Run workflow.** The site URL appears in the deploy step.

The workflow runs hourly (`cron: 17 * * * *`; GitHub can delay scheduled runs, and disables schedules after 60 days without repo activity — the hourly data commits keep it active). It runs `scripts/fetch_stats.py`, commits `data/` if it changed, then deploys the site with `actions/deploy-pages`. A push to `main` (outside `data/`) redeploys without fetching.

"Deploy from a branch (main / root)" also works if you prefer it, but commits made with `GITHUB_TOKEN` may not trigger a branch build, so data could lag — that's why the Actions source is recommended.

### Optional secrets
- `YT_API_KEY` — free YouTube Data API v3 key (Google Cloud Console → enable *YouTube Data API v3* → Credentials → API key). Adds comment counts and exact per-video stats. Without it the script uses the channel page + RSS feed (views and likes for the last ≤15 videos, no comments).
- `IG_ACCESS_TOKEN` + `IG_USER_ID` — Instagram Graph API via Business Discovery. Requires an Instagram Business/Creator account linked to a Facebook Page, a Meta developer app, and a long-lived token (~60 days, must be renewed). Business Discovery can read other public Business/Creator accounts. Without it the script tries the unofficial public web endpoint, which is usually blocked (HTTP 429/302) from cloud IPs.

### Run manually
- GitHub: **Actions → Refresh stats & deploy → Run workflow**.
- Locally: `pip install requests && python3 scripts/fetch_stats.py` (optionally pass platform names: `python3 scripts/fetch_stats.py youtube aparat`).
- Preview: `python3 -m http.server 8000` then open `http://localhost:8000/`.

### Editing handles
All handles live in `config.json` (`pages[].accounts`). Page order on the Home screen follows that file.

### Sources per platform
| Platform | Without secrets | With secrets |
|---|---|---|
| YouTube | channel `/about` page (subscribers, video count, total views) + RSS feed (recent videos, views, likes) | Data API v3 (`channels?forHandle=`, uploads playlist, `videos` stats incl. comments) |
| Aparat | public `api/fa/v1/user/user/information` (followers, videos, total views) + `api/fa/v1/user/video/list` (recent videos, views). Legacy `etc/api/profile` used as fallback; legacy `videobyuser` returns 503. No likes/comments. | — |
| Instagram | unofficial `web_profile_info`, then profile-page meta — usually blocked | Graph API Business Discovery |
| TikTok | profile page embedded JSON (`__UNIVERSAL_DATA_FOR_REHYDRATION__`): followers, total likes, video count. No per-video list/dates. | — |

The vault button only links to `https://vault.vaultwarden.com/`. Never commit passwords, tokens or vault content to this repo — use GitHub Secrets.
