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
| `data/history.json` | یک اندازه‌گیری در هر اجرا: ۳ روز با جزئیات کامل، تا ۱۴ روز ساعتی، تا ۹۰+ روز روزانه |
| `data/avatars/` | عکس پروفایل هر کانال/شبکه؛ هر اجرا از نو دانلود می‌شود |
| `queue/` | صف انتشار محتوا (یک JSON برای هر پست) |
| `scripts/publish.py`، `.github/workflows/publish.yml` | انتشار پست‌های صف (با push به `queue/` و هر ۱۵ دقیقه) |
| `scripts/fetch_stats.py` | اسکریپت جمع‌آوری آمار (پایتون ۳ + `requests`) |
| `.github/workflows/refresh.yml` | اجرای ساعتی + انتشار روی GitHub Pages |
| `scripts/screen.py`، `.github/workflows/screen.yml` | غربال‌گری فوری (v25): با دکمه‌ی «شروع غربال‌گری» در «مغز متفکر» اجرا می‌شود؛ درخواست رمزشده‌ی `hark/requests/` را با `HARK_PRIV_JWK` باز می‌کند، با اولین سرویس رایگانی که جواب بدهد (`GEMINI_API_KEY` ← `GEMINI_API_KEY_2` ← `GROQ_API_KEY` ← `OPENROUTER_API_KEY`) و شناسنامه‌ی برند اسکریپت وایرال می‌نویسد و جواب رمزشده را در `hark/out/<page>/` می‌گذارد |

دکمه‌ی «پسوورد منیجر» فقط `https://vault.vaultwarden.com/` را در زبانه‌ی جدید باز می‌کند. هیچ رمز یا محتوای گاوصندوقی در این مخزن ذخیره نمی‌شود — و نباید بشود.

### به‌روزرسانی فوری و انتشار محتوا (نسخه‌ی ۴)
- در **تنظیمات** پنل یک *Fine-grained token* گیت‌هاب بگذارید (فقط مخزن `social-panel`؛ دسترسی‌ها: `Actions: Read and write` و `Contents: Read and write`). توکن **فقط در localStorage همان مرورگر** ذخیره می‌شود و هرگز در مخزن نیست.
- با توکن، دکمه‌ی به‌روزرسانی بالای صفحه workflow «Refresh stats & deploy» را اجرا می‌کند، تا پایان انتشار سایت صبر می‌کند و بعد داده‌ها و عکس‌های پروفایل تازه را بارگذاری می‌کند. بدون توکن فقط آخرین داده‌ها دوباره خوانده می‌شوند.
- **انتشار محتوا** (`#/publish`): فایل به‌صورت git blob روی شاخه‌ی `media-upload` آپلود می‌شود (مرورگر نمی‌تواند مستقیم Release asset آپلود کند، چون `uploads.github.com` CORS ندارد؛ حداکثر ۷۰ مگابایت) و `queue/<id>.json` ساخته می‌شود. `publish.py` فایل را به Release با تگ `media-queue` منتقل می‌کند، کارهای سررسیده را منتشر می‌کند و نتیجه‌ی هر مقصد را برمی‌گرداند.
- Secretهای انتشار (`<PAGE>` = شناسه‌ی پیج با حروف بزرگ و `_`، مثل `SHODE_DIGE`):
  - یوتیوب: `YT_CLIENT_ID`، `YT_CLIENT_SECRET`، `YT_REFRESH_TOKEN_<PAGE>` (OAuth با scope `youtube.upload`)
  - اینستاگرام: `IG_ACCESS_TOKEN_<PAGE>`، `IG_USER_ID_<PAGE>` (اکانت Business/Creator، دسترسی `instagram_content_publish`)
  - آپارات: `APARAT_USER_<PAGE>`، `APARAT_PASS_<PAGE>` — API رسمی و مستند فعالی برای آپلود ندارد (`etc/api` پاسخ 503 می‌دهد)؛ عملاً «نیاز به راه‌اندازی».
  - تیک‌تاک: `TIKTOK_ACCESS_TOKEN_<PAGE>` (اپ تأییدشده‌ی Content Posting API؛ اپ تأییدنشده فقط خصوصی منتشر می‌کند)
  - بدون Secret، وضعیت آن مقصد «نیاز به راه‌اندازی» با توضیح فارسی است.
- آمار اینستاگرام بدون توکن از صفحه‌ی عمومی `instagram.com/<user>/embed/` خوانده می‌شود (دنبال‌کننده، تعداد پست، تاریخ/لایک/کامنت پست‌های اخیر).

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
| Instagram | public profile embed page `instagram.com/<user>/embed/` (followers, post count, recent posts with dates/likes/comments), then unofficial fallbacks | Graph API Business Discovery |
| TikTok | profile page embedded JSON (`__UNIVERSAL_DATA_FOR_REHYDRATION__`): followers, total likes, video count. No per-video list/dates. | — |

**v4:** history keeps one snapshot per run (full 3 days, hourly to 14 days, daily to ≥90 days); profile photos are re-downloaded every run into `data/avatars/`; the panel's settings page stores a GitHub fine-grained token in localStorage only (never in the repo) to trigger refreshes and to queue posts (`queue/`, `scripts/publish.py`, `publish.yml`; see the Persian section for secret names).

The vault button only links to `https://vault.vaultwarden.com/`. Never commit passwords, tokens or vault content to this repo — use GitHub Secrets.

## v28 (2026-11-21) — ویس‌اور و ساخت صدا (خط تولید ۸ مرحله‌ای)

Brain line: مغز متفکر › غربال‌گری › اسکریپت نهایی › نوع محتوا › **اسکریپت ویس‌اور** › **ساخت صدا** › ساخت › مشاهده و انتشار.
- «اسکریپت ویس‌اور»: per item «ویس‌اور» or «بدون ویس‌اور (موسیقی)». «نوشتن ویس‌اور» sends an encrypted `voscript` request and dispatches
  `.github/workflows/voscript.yml` (`scripts/voscript.py`, same crypto + provider chain/timing as `screen.py`: GEMINI_API_KEY 5 min →
  GEMINI_API_KEY_2 5 min → openai/gpt-oss-120b via GROQ_API_KEY then OPENROUTER_API_KEY). Output: Persian voice-over with timing per
  slide/scene + tone notes, encrypted to the panel. Music = mood/track note + optional link. Dual approval (نگین + امیرحسین).
- «ساخت صدا»: tools from `config.json` `voice_tools` (preliminary), «ارسال برای ساخت صدا» = encrypted `voice` request for Hark's
  scheduled run (result `voice_result` with `audio_url`); or upload / record (MediaRecorder) an audio file, staged on `media-upload`
  under `gallery/voice-…` and moved into the public `gallery` release by publish.yml. Dual approval; music skips this step.
- `produce` requests now carry `voiceover`, `voice_url` (+ name/source/tool) and `music`.
- Back button is sticky under the top bar on every page; the «در حال به‌روزرسانی» box opens below it.
- Tests: `node tests/v28.test.js <fixture> <media>` (42 checks), `python3 scripts/voscript.py --selftest --mock`.

## v8 (2026-11-16) — مغز متفکر، گالری محتوا، انتشار جدید

### فارسی
- صفحه‌ی اصلی: بعد از «کانال‌ها» → «مغز متفکر» (نیلی تیره) → «گالری محتوا» (فیروزه‌ای-یاسی) → «انتشار محتوا» → «ابزارها».
- «مغز متفکر» (`#/brain`): ۵ پیج؛ هر پیج سه زبانه‌ی ایده‌ها / سناریوها / اسکریپت‌ها. هر آیتم: عنوان، متن بلند (خط‌ها حفظ می‌شود)، شبکه‌ها و فرمت (اختیاری)، وضعیت. ارتقا ایده → سناریو → اسکریپت با پیوند دوطرفه.
- «گالری محتوا» (`#/gallery`): ۵ پیج؛ زیرمنوهای اسلاید / ریل / استوری / ویدئو. بارگذاری چندفایلی (کشیدن و رها کردن، هر فایل تا ۷۰ مگابایت) با دسته‌بندی خودکار در مرورگر؛ قانون نمایش داده می‌شود و قابل تغییر است. فایل‌ها روی شاخه‌ی `media-upload` زیر `gallery/` گذاشته می‌شوند و `publish.py` آن‌ها را به Release «gallery» منتقل می‌کند.
- انتشار (`#/publish`): آپلود دستی یا انتخاب از گالری؛ جدول ۲۰ کانال با تیک گروهی برای هر پیج و هر شبکه و «همه»؛ همین حالا یا زمان‌بندی؛ صف با فیلتر وضعیت و تقویم ماه/هفته. کانالی که برای انتشار خودکار وصل نیست «نیاز به اتصال / انتشار دستی» می‌گیرد و در صف یادآوری می‌ماند تا «دستی منتشر کردم ✓» زده شود.
- وضعیت‌ها با برچسب رنگی و نوار نقطه‌ای؛ هیچ آیتمی پنهان یا بایگانی نمی‌شود (فیلتر پیش‌فرض: همه). وضعیت از صف → گالری → مغز متفکر بالا می‌رود.
- حریم خصوصی: متن‌ها و اطلاعات گالری/انتشار رمزگذاری‌شده در `vault/*.enc.json` (AES-256-GCM با کلید داده‌ای که با رمز پنل در `config/data_key.enc.json` پیچیده شده). صف انتشار (`queue/*.json`) برای GitHub Action خوانا و حداقلی است. فایل‌های رسانه در Release عمومی‌اند.
- صندوق ورودی برای ابزارهای بیرونی: `gallery-ingest.yml` (پایین را ببینید).

### English
- Data key: random 256-bit DK + ECDH P-256 inbox key pair, wrapped with the panel password (PBKDF2-SHA256 310k → AES-GCM, AAD `sp-keyring-v1|<kid>`) in `config/data_key.enc.json`; created by the first unlocked panel. Public inbox key: `config/inbox_pub.json`.
- Encrypted files: `vault/brain-<page>.enc.json`, `vault/gallery-<page>.enc.json`, `vault/publish.enc.json` = `{v, kid, alg, iv, ct, updated_at}`, AES-256-GCM(DK), AAD `sp-data-v1|<path>`. Written with the contents API, re-read + re-applied on a 409/422 sha conflict.
- Queue entries stay plain and minimal (media URL, targets incl. `manual`, time, title, caption) so `publish.py` needs no extra secret; no `DATA_KEY` secret is used. `publish.py` also writes `config/publish_caps.json` (booleans only: which channel can publish automatically).
- Gallery inbox: `POST /repos/negin1100mohammadi/social-panel/actions/workflows/gallery-ingest.yml/dispatches` with `{"ref":"main","inputs":{"url":"<direct file link>","domain":"<page id>","kind":"auto|slide|reel|story|video","story":"false","title":"","brain_id":"","req":"<id>","dry_run":"false"}}`. The run downloads (≤ 70 MB), probes (Pillow/ffprobe), classifies (`scripts/gallery_classify.py`, same rules as the panel), uploads to the `gallery` release and commits `inbox/<id>.enc.json` encrypted to the inbox public key (ECDH P-256 ephemeral + HKDF-SHA256 `sp-inbox-v1` + AES-256-GCM). The panel merges inbox items into the gallery when the gallery is opened. Needs the data key to exist (open the brain/gallery once).
- Tests: `python3 tests/make_media.py /tmp/spmedia && python3 tests/make_fixture.py /tmp/fx $(date +%s000) && node tests/v8.test.js /tmp/fx /tmp/spmedia`; `python3 tests/test_v8_python.py /tmp/spmedia`.

## v7 (2026-11-15) — اتصال رسمی یوتیوب

### فارسی
- کنار هر ردیف یوتیوب در «کانال‌ها»، در صفحه‌ی آمار یوتیوب و در «تنظیمات ← حساب‌های متصل» دکمه‌ی **«اتصال»** هست. با آن صفحه‌ی رسمی گوگل باز می‌شود (حساب/کانال را انتخاب کن و همه‌ی دسترسی‌ها را تأیید کن). اگر گوگل نوشت «این برنامه تأیید نشده»، Advanced ← Go to social-panel-app.
- گوگل به `oauth.html` برمی‌گردد؛ این صفحه کد یک‌بارمصرف را با توکن گیت‌هاب همین دستگاه به گردش‌کار `yt-connect.yml` می‌دهد و نتیجه را نشان می‌دهد. توکن دائمی فقط رمزگذاری‌شده (AES-GCM با Secret `TOKEN_KEY`) در `config/yt_tokens.enc.json` ذخیره می‌شود.
- اگر کانالِ تأییدشده با کانال تعریف‌شده‌ی پیج یکی نباشد، باز هم ذخیره می‌شود ولی با برچسب «کانال دیگری متصل شده»؛ آمار و انتشار از آن استفاده نمی‌کنند.
- برای کانال متصل: آمار دقیق از API (بازدید/لایک/کامنت هر ویدیو، مشترک‌ها)، صندوق کامنت‌ها (جدیدترین بالا) با جعبه‌ی پاسخ؛ پاسخ‌ها در صف می‌روند و `yt-reply.yml` با `comments.insert` منتشرشان می‌کند. صف انتشار هم توکن یوتیوب را از همین فایل می‌خواند.

### English
- Secrets: `YT_CLIENT_ID`, `YT_CLIENT_SECRET`, `TOKEN_KEY` (32 random bytes, base64). Public client id also in `config.json → youtube_oauth`.
- Flow: app → Google (`response_type=code`, `access_type=offline`, `prompt=consent select_account`, `include_granted_scopes=true`, `state=<page>.<nonce>` kept in sessionStorage, with a 30-min single-use localStorage copy for home-screen apps) → `oauth.html` (state check, URL cleared) → `workflow_dispatch yt-connect.yml {code,page,req}` → `scripts/yt_connect.py` reads inputs from `$GITHUB_EVENT_PATH`, `::add-mask::`s the code first, exchanges it, reads `channels?mine=true`, stores the AES-GCM-encrypted refresh token (channel id as AAD) keyed by channel id, writes `config/yt_connect_last.json` (no secrets).
- `scripts/fetch_stats.py`: connected (non-mismatched) channels use the owner's token → exact stats + `data/comments.json`; on failure falls back to public pages and records `oauth.status` (`revoked`/`error`/`mismatch`) in `latest.json`.
- `yt-reply.yml` + `scripts/yt_reply.py` → `config/yt_replies.json`. `scripts/publish.py` reads YouTube refresh tokens from the store (per-page `YT_REFRESH_TOKEN_*` secrets no longer needed).
- Tests: `python3 tests/test_youtube_oauth.py` (mock Google on localhost) and `FIXTURE_NOW=$NOW node tests/v7.test.js /tmp/fx`.

## v6 (2026-11-15)

### فارسی — تغییرات نسخه‌ی ۶
- **اتصال توکن روی همه‌ی دستگاه‌ها:** اگر روی این دستگاه وارد پنل هستی ولی توکن نداری و نسخه‌ی رمزگذاری‌شده در مخزن هست، روی هر صفحه پنجره‌ی «برای فعال‌سازی اتصال، رمز پنل را یک بار وارد کن» باز می‌شود (در «انتشار» و «تنظیمات» همان فرم داخل صفحه است). بعد از ورود دوباره هم خودکار باز می‌شود.
- **آمار دقیق هر پست:** `data/posts_history.json` در هر اجرا بازدید/لایک/کامنت تک‌تک پست‌ها را ثبت می‌کند (۹۵ روز). صفحه‌ی آمار یک فیلتر زمانی واحد دارد (۳ ساعت، ۲۴ ساعت، ۳۰ روز، ۹۰ روز): جمع بازدید/لایک/کامنت تازه با بازه‌ی دقیق «از … تا …» به وقت تهران و پوشش داده، نمودار روند، و فهرست پست‌ها به ترتیب بازدید تازه.
- **دکمه‌ی آمار:** لینک واقعی با محدوده‌ی جدا؛ ترتیب کانال‌ها در طول بازدید ثابت است و هیچ چیزی در پس‌زمینه ردیف‌ها را جابه‌جا نمی‌کند.
- **«ورود»** حالا بخش مدیریت اکانت را باز می‌کند (داشبورد حرفه‌ای اینستاگرام و Meta Business Suite، YouTube Studio، داشبورد آپارات، TikTok Studio).
- **ابزارها:** جعبه‌ی طوسی «ابزارها» در صفحه‌ی اصلی؛ هر هوش مصنوعی دو دکمه‌ی «نگین» و «امیرحسین» دارد که صفحه‌ی معمولی آن را باز می‌کنند. لینک Muse در همان صفحه قابل ویرایش است.

### English — v6
- `data/posts_history.json` (written by `scripts/fetch_stats.py` every run): per account `runs` (every successful read) and per post `s: [[iso, views, likes, comments], ...]` stored on change, plus title/url/thumb/published/first/last. Pruned like history.json (all 3 d, hourly to 14 d, daily to 95 d). Rounded counts ("1.2K") are stored as null. `scripts/backfill_posts_history.py` rebuilt it from every committed `data/latest.json`.
- Window math (app.js `computeWindow`/`postGain`): gain = value at window end − value at window start; posts published inside the window count from 0; posts first seen inside the window count from their first reading (labelled). Bucket gains sum exactly to the window total.
- YouTube: RSS feed (intermittently 404) → fallback to channel Videos/Shorts tabs + each video's watch page for exact views/likes/date.
- Scheduled refresh cron `7,22,37,52 * * * *` (GitHub drops/delays many runs; aims at ~30 min).
- Service worker v6: skipWaiting + clients.claim; the page reloads once when a new version takes over.
- Tools config: `config.json` → `tools.items[]` (`id`, `name`, `url`, `editable`), `tools.accounts[]` (`id`, `name`).

## Tests (v6)
```
npm i playwright@1.48 && npx playwright install chromium
NOW=$(date +%s%3N); python3 tests/make_fixture.py /tmp/fx $NOW
FIXTURE_NOW=$NOW node tests/v6.test.js /tmp/fx .     # ~13 000 checks
node tests/token_sync.test.js /tmp/fx                 # settings sync / delete flows
```
`tests/v6.test.js`: every route at 390 px and 1280 px in light and dark; per-post window math against an independent implementation and a hand-computed account; every chart and admin link by `elementFromPoint` and a real click/tap (each group alone and all open, after a background data reload); tools; unlock modal (mocked GitHub API, real WebCrypto, real committed `config/token.enc.json` format); SW update → exactly one reload.

## Tests (v5, superseded)

Headless Chromium at iPhone width (390px). Setup once: `npm i playwright && npx playwright install chromium`.

- Chart filters on a synthetic 92-day history (pruned exactly like the refresh job):
  `NOW=$(node -e 'console.log(Date.now())'); python tests/make_fixture.py /tmp/spfix $NOW && FIXTURE_NOW=$NOW node tests/charts.test.js /tmp/spfix --fixture`
- Same test against the real data: `node tests/charts.test.js .` (or the live URL)
- Encrypted token sync (GitHub API mocked, real WebCrypto, throwaway login): `node tests/token_sync.test.js .`

Token sync: `config/token.enc.json` = `{v, salt, iv, ct, created_at}`; PBKDF2-SHA256 (310000 iterations, 16-byte salt) → AES-GCM-256 (12-byte IV), keyed by the panel login password. The password is kept only in memory/sessionStorage of the tab; the plain token only in each device's localStorage.
