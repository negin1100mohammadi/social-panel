#!/usr/bin/env python3
"""Publish queued posts from queue/<id>.json.

Flow
  1. The panel (browser, with the user's own GitHub token) uploads the file as a git
     blob on the `media-upload` branch and commits queue/<id>.json (status "pending").
     (Browsers cannot upload release assets directly: uploads.github.com has no CORS.)
  2. This script moves every staged file into the GitHub Release "media-queue" as an
     asset (large files OK) and stores its public URL in the job (asset_url).
  3. Jobs whose publish_at (ISO, +03:30) is due are published to each target.
     Every target gets a result: published / failed / needs_setup (with a Persian reason).
  4. The media-upload branch is rebuilt with only files not yet moved (or deleted).

Secrets (all optional; a platform without its secrets => "needs_setup", never a crash).
They are passed one by one as env variables by publish.yml.
<PAGE> = page id upper-cased with "-" -> "_", e.g. shode-dige -> SHODE_DIGE.
  YouTube : YT_CLIENT_ID, YT_CLIENT_SECRET, TOKEN_KEY + the page's connected channel in
            config/yt_tokens.enc.json (connected in the panel with OAuth; no per-page refresh-token secrets)
  Instagram: IG_ACCESS_TOKEN_<PAGE>, IG_USER_ID_<PAGE>   or, when data/buffer.json shows the page's Instagram
            channel in Buffer: BUFFER_KEY_<PAGE> (Buffer GraphQL API, createPost shareNow)
  Aparat  : APARAT_USER_<PAGE>, APARAT_PASS_<PAGE>   (legacy etc/api; currently 503)
  TikTok  : TIKTOK_ACCESS_TOKEN_<PAGE>  or Buffer (same as Instagram)

Resolution of every channel (v10)
  published | failed (final)  · needs_setup / manual = «اتصال برقرار نیست» until the panel resolves it
  (تلاش دوباره -> status "queued", دستی منتشر کردم -> published+manual, لغو / ناموفق -> failed)
  An error is retried automatically on the next runs ("retry") up to MAX_ATTEMPTS, then "failed" with the reason.
  Job status: pending while anything is queued/retrying, needs_action while a channel is unresolved,
  otherwise published / partial / failed.
"""
import glob
import hashlib
import json
import os
import re
import sys
import tempfile
import time
from datetime import datetime, timedelta, timezone

import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
QUEUE = os.path.join(ROOT, "queue")
REPO = os.environ.get("GITHUB_REPOSITORY", "negin1100mohammadi/social-panel")
GH_TOKEN = os.environ.get("GITHUB_TOKEN", "")
RELEASE_TAG = "media-queue"
MEDIA_BRANCH = "media-upload"
TEHRAN = timezone(timedelta(hours=3, minutes=30))  # Iran: no DST since 2022

try:
    SECRETS = json.loads(os.environ.get("ALL_SECRETS") or "{}") or {}
except ValueError:
    SECRETS = {}

FINAL = {"published", "failed", "needs_setup", "skipped", "cancelled", "manual"}  # not attempted again automatically
UNRESOLVED = {"needs_setup", "manual"}  # wait for the panel: تلاش دوباره / دستی منتشر کردم / لغو
MAX_ATTEMPTS = 3
BUFFER_API = os.environ.get("SP_BUFFER_API") or "https://api.buffer.com"
GALLERY_TAG = "gallery"  # «گالری محتوا»: files staged under gallery/ on the media branch move here
GALLERY_PREFIX = "gallery/"


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def now():
    return datetime.now(timezone.utc)


def iso_tehran(dt=None):
    return (dt or now()).astimezone(TEHRAN).replace(microsecond=0).isoformat()


def secret(name):
    v = SECRETS.get(name) or os.environ.get(name) or ""
    return v.strip()


def suffix(page):
    return re.sub(r"[^A-Z0-9]", "_", page.upper())


class NeedsSetup(Exception):
    pass


# --------------------------------------------------------------------------- GitHub
def gh(method, path, **kw):
    url = path if path.startswith("https://") else f"https://api.github.com/repos/{REPO}{path}"
    h = kw.pop("headers", {})
    h.setdefault("Accept", "application/vnd.github+json")
    h["Authorization"] = f"Bearer {GH_TOKEN}"
    h["X-GitHub-Api-Version"] = "2022-11-28"
    r = requests.request(method, url, headers=h, timeout=kw.pop("timeout", 60), **kw)
    return r


def ensure_release(tag=RELEASE_TAG):
    r = gh("GET", f"/releases/tags/{tag}")
    if r.status_code == 200:
        return r.json()
    body = ("Files uploaded from the panel for scheduled publishing. Safe to delete old assets." if tag == RELEASE_TAG else
            "Media of the panel's gallery (metadata is encrypted in vault/). Files are public to anyone with the link.")
    r = gh("POST", "/releases", json={
        "tag_name": tag, "name": "Media queue (panel uploads)" if tag == RELEASE_TAG else "Gallery (panel content store)", "prerelease": True,
        "body": body})
    r.raise_for_status()
    return r.json()


def download_staged(job, dest):
    """Fetch the staged file from the media-upload branch (blob API works for any size up to 100 MB)."""
    m = job["media"]
    r = gh("GET", f"/git/blobs/{m['blob_sha']}", headers={"Accept": "application/vnd.github.raw+json"},
           stream=True, timeout=300)
    if r.status_code != 200:
        raise RuntimeError(f"blob download HTTP {r.status_code}")
    with open(dest, "wb") as f:
        for chunk in r.iter_content(1 << 20):
            f.write(chunk)


def migrate_to_release(job):
    """Move a staged blob into the media-queue release; sets job.asset_url."""
    rel = ensure_release()
    m = job["media"]
    ext = os.path.splitext(m.get("path") or "")[1] or ".bin"
    name = f"{job['id']}{ext}"
    for a in rel.get("assets", []):
        if a["name"] == name:
            job["asset_url"] = a["browser_download_url"]
            job["media"]["asset_id"] = a["id"]
            return
    with tempfile.NamedTemporaryFile(delete=False, suffix=ext) as tmp:
        path = tmp.name
    try:
        download_staged(job, path)
        size = os.path.getsize(path)
        with open(path, "rb") as f:
            r = requests.post(
                f"https://uploads.github.com/repos/{REPO}/releases/{rel['id']}/assets",
                params={"name": name},
                headers={"Authorization": f"Bearer {GH_TOKEN}", "Content-Type": m.get("type") or "application/octet-stream",
                         "Content-Length": str(size), "Accept": "application/vnd.github+json"},
                data=f, timeout=900)
        if r.status_code not in (200, 201):
            raise RuntimeError(f"release upload HTTP {r.status_code}: {r.text[:200]}")
        a = r.json()
        job["asset_url"] = a["browser_download_url"]
        job["media"]["asset_id"] = a["id"]
    finally:
        try:
            os.remove(path)
        except OSError:
            pass


def migrate_gallery():
    """Move every file staged under gallery/ on the media branch into the "gallery" release (same asset name).
    Returns the set of paths that are now in the release (safe to drop from the branch)."""
    moved = set()
    r = gh("GET", f"/git/ref/heads/{MEDIA_BRANCH}")
    if r.status_code != 200:
        return moved
    head = r.json()["object"]["sha"]
    commit = gh("GET", f"/git/commits/{head}").json()
    tree = gh("GET", f"/git/trees/{commit['tree']['sha']}?recursive=1").json()
    files = [t for t in tree.get("tree", []) if t["type"] == "blob" and t["path"].startswith(GALLERY_PREFIX)]
    if not files:
        return moved
    rel = ensure_release(GALLERY_TAG)
    have = {a["name"] for a in rel.get("assets", [])}
    for t in files:
        name = t["path"][len(GALLERY_PREFIX):]
        if name in have:
            moved.add(t["path"])
            continue
        ext = os.path.splitext(name)[1].lower()
        ctype = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif", ".heic": "image/heic",
                 ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".m4v": "video/mp4",
                 # v28: voice-over audio (uploaded / recorded in «ساخت صدا», or posted by Hark) lives in the same release
                 ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".aac": "audio/aac", ".wav": "audio/wav", ".ogg": "audio/ogg", ".oga": "audio/ogg",
                 ".opus": "audio/ogg", ".weba": "audio/webm", ".flac": "audio/flac"}.get(ext, "application/octet-stream")
        fd, path = tempfile.mkstemp(suffix=ext)
        os.close(fd)
        try:
            download_staged({"media": {"blob_sha": t["sha"]}}, path)
            with open(path, "rb") as f:
                u = requests.post(f"https://uploads.github.com/repos/{REPO}/releases/{rel['id']}/assets", params={"name": name},
                                  headers={"Authorization": f"Bearer {GH_TOKEN}", "Content-Type": ctype, "Content-Length": str(os.path.getsize(path)),
                                           "Accept": "application/vnd.github+json"}, data=f, timeout=900)
            if u.status_code in (200, 201):
                moved.add(t["path"])
                log(f"gallery: {name} -> release {GALLERY_TAG}")
            else:
                log(f"gallery: {name} upload HTTP {u.status_code}: {u.text[:200]}")
        except Exception as e:
            log(f"gallery: {name} move failed: {e}")
        finally:
            try:
                os.remove(path)
            except OSError:
                pass
    return moved


def rebuild_media_branch(keep_paths, gallery_moved=frozenset()):
    """Keep files that still need moving (queue files of pending jobs, gallery files not in the release yet);
    delete the branch when nothing is left."""
    r = gh("GET", f"/git/ref/heads/{MEDIA_BRANCH}")
    if r.status_code == 404:
        return
    r.raise_for_status()
    head = r.json()["object"]["sha"]
    commit = gh("GET", f"/git/commits/{head}").json()
    tree = gh("GET", f"/git/trees/{commit['tree']['sha']}?recursive=1").json()
    files = [t for t in tree.get("tree", []) if t["type"] == "blob"]
    remain = [t for t in files if t["path"] in keep_paths or (t["path"].startswith(GALLERY_PREFIX) and t["path"] not in gallery_moved)]
    if len(remain) == len(files):
        return
    # the panel may have staged a new file while this run worked: never drop what we did not look at
    again = gh("GET", f"/git/ref/heads/{MEDIA_BRANCH}")
    if again.status_code == 200 and again.json()["object"]["sha"] != head:
        log("media branch moved during this run; cleanup left for the next run")
        return
    if not remain:
        d = gh("DELETE", f"/git/refs/heads/{MEDIA_BRANCH}")
        log("media branch deleted" if d.status_code == 204 else f"media branch delete HTTP {d.status_code}")
        return
    t = gh("POST", "/git/trees", json={"tree": [{"path": x["path"], "mode": "100644", "type": "blob", "sha": x["sha"]} for x in remain]}).json()
    c = gh("POST", "/git/commits", json={"message": "media: keep pending files", "tree": t["sha"], "parents": []}).json()
    u = gh("PATCH", f"/git/refs/heads/{MEDIA_BRANCH}", json={"sha": c["sha"], "force": True})
    log(f"media branch rebuilt with {len(remain)} file(s): HTTP {u.status_code}")


# --------------------------------------------------------------------------- file cache
_FILES = {}


def local_file(job):
    if job["id"] in _FILES:
        return _FILES[job["id"]]
    ext = os.path.splitext((job.get("media") or {}).get("path") or "")[1] or ".bin"
    fd, path = tempfile.mkstemp(suffix=ext)
    os.close(fd)
    if job.get("asset_url"):
        try:
            with requests.get(job["asset_url"], stream=True, timeout=600) as r:
                r.raise_for_status()
                with open(path, "wb") as f:
                    for chunk in r.iter_content(1 << 20):
                        f.write(chunk)
        except Exception:
            # a gallery file that is not in its release yet: read the staged blob instead
            if not (job.get("media") or {}).get("blob_sha"):
                raise
            download_staged(job, path)
    else:
        download_staged(job, path)
    _FILES[job["id"]] = path
    return path


def is_video(job):
    return str((job.get("media") or {}).get("type", "")).startswith("video/")


# --------------------------------------------------------------------------- YouTube
def youtube_refresh_token(page):
    """Refresh token of the page's connected channel (config/yt_tokens.enc.json, decrypted with TOKEN_KEY).
    Only the OAuth connection made in the panel is used (no per-page refresh-token secrets)."""
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import yt_tokens
    try:
        store = yt_tokens.load()
        ent = yt_tokens.entry_for_page(store, page)
        if ent:
            return yt_tokens, yt_tokens.decrypt(ent)
        if yt_tokens.entry_for_page(store, page, allow_mismatch=True):
            raise NeedsSetup("حساب یوتیوبِ متصل به این پیج با کانال تعریف‌شده‌ی پیج یکی نیست؛ برای امنیت منتشر نشد. "
                             "در پنل «اتصال» را دوباره بزن و کانال درست را انتخاب کن.")
    except yt_tokens.StoreError as e:
        if "TOKEN_KEY" in str(e):
            raise NeedsSetup("Secret مخزن TOKEN_KEY (کلید باز کردن توکن‌های یوتیوب) در publish.yml نیست یا نامعتبر است.")
        raise NeedsSetup(f"خواندن توکن یوتیوب ممکن نشد: {e}")
    raise NeedsSetup("حساب یوتیوب این پیج به پنل وصل نیست؛ در پنل (کانال‌ها ← یوتیوب) «اتصال» را بزن.")


def publish_youtube(job, page):
    yt_tokens, rt = youtube_refresh_token(page)
    if not is_video(job):
        return {"status": "skipped", "reason": "یوتیوب فقط ویدیو می‌پذیرد؛ عکس منتشر نشد."}
    try:
        access = yt_tokens.access_token(rt)
    except yt_tokens.StoreError as e:
        if str(e) == "revoked":
            raise NeedsSetup("دسترسی پنل به این کانال لغو یا منقضی شده؛ در پنل «اتصال» را دوباره بزن.")
        if "missing" in str(e):
            raise NeedsSetup(f"Secretهای اپ گوگل (YT_CLIENT_ID / YT_CLIENT_SECRET) در publish.yml نیست ({e}).")
        raise RuntimeError(f"توکن یوتیوب تمدید نشد: {e}")
    path = local_file(job)
    size = os.path.getsize(path)
    meta = {"snippet": {"title": (job.get("title") or "ویدیو")[:100], "description": job.get("caption") or "",
                        "categoryId": "22"},
            "status": {"privacyStatus": "public", "selfDeclaredMadeForKids": False}}
    init = requests.post(os.environ.get("SP_YT_UPLOAD") or "https://www.googleapis.com/upload/youtube/v3/videos",
                         params={"uploadType": "resumable", "part": "snippet,status"},
                         headers={"Authorization": f"Bearer {access}", "Content-Type": "application/json; charset=UTF-8",
                                  "X-Upload-Content-Length": str(size),
                                  "X-Upload-Content-Type": job["media"].get("type") or "video/*"},
                         data=json.dumps(meta), timeout=60)
    if init.status_code != 200 or "Location" not in init.headers:
        raise RuntimeError(f"شروع آپلود یوتیوب ناموفق (HTTP {init.status_code}): {init.text[:200]}")
    with open(path, "rb") as f:
        up = requests.put(init.headers["Location"], data=f, timeout=1800,
                          headers={"Authorization": f"Bearer {access}", "Content-Length": str(size),
                                   "Content-Type": job["media"].get("type") or "video/*"})
    if up.status_code not in (200, 201):
        raise RuntimeError(f"آپلود یوتیوب ناموفق (HTTP {up.status_code}): {up.text[:200]}")
    vid = up.json().get("id")
    return {"status": "published", "url": f"https://www.youtube.com/watch?v={vid}", "remote_id": vid}


# --------------------------------------------------------------------------- Instagram
def publish_instagram(job, page):
    token = secret(f"IG_ACCESS_TOKEN_{suffix(page)}")
    uid = secret(f"IG_USER_ID_{suffix(page)}")
    if not (token and uid):
        raise NeedsSetup(f"برای اینستاگرام Secretهای IG_ACCESS_TOKEN_{suffix(page)} و IG_USER_ID_{suffix(page)} لازم است (اکانت Business/Creator).")
    if not job.get("asset_url"):
        raise RuntimeError("آدرس عمومی فایل آماده نیست")
    api = "https://graph.facebook.com/v21.0"
    params = {"caption": job.get("caption") or job.get("title") or "", "access_token": token}
    if is_video(job):
        params.update({"media_type": "REELS", "video_url": job["asset_url"], "share_to_feed": "true"})
    else:
        if not re.search(r"\.jpe?g$", job["asset_url"], re.I):
            return {"status": "failed", "reason": "اینستاگرام از طریق API فقط عکس JPEG می‌پذیرد."}
        params["image_url"] = job["asset_url"]
    r = requests.post(f"{api}/{uid}/media", data=params, timeout=120)
    if r.status_code != 200:
        raise RuntimeError(f"ساخت پست اینستاگرام ناموفق (HTTP {r.status_code}): {r.text[:200]}")
    cid = r.json()["id"]
    for _ in range(60):  # video processing can take a few minutes
        s = requests.get(f"{api}/{cid}", params={"fields": "status_code,status", "access_token": token}, timeout=30).json()
        code = s.get("status_code")
        if code == "FINISHED":
            break
        if code in ("ERROR", "EXPIRED"):
            raise RuntimeError(f"پردازش ویدیو در اینستاگرام ناموفق: {s.get('status')}")
        time.sleep(10)
    else:
        raise RuntimeError("پردازش ویدیو در اینستاگرام بیش از ۱۰ دقیقه طول کشید")
    p = requests.post(f"{api}/{uid}/media_publish", data={"creation_id": cid, "access_token": token}, timeout=60)
    if p.status_code != 200:
        raise RuntimeError(f"انتشار اینستاگرام ناموفق (HTTP {p.status_code}): {p.text[:200]}")
    mid = p.json().get("id")
    link = None
    try:
        link = requests.get(f"{api}/{mid}", params={"fields": "permalink", "access_token": token}, timeout=30).json().get("permalink")
    except Exception:
        pass
    return {"status": "published", "remote_id": mid, "url": link}


# --------------------------------------------------------------------------- Aparat
def publish_aparat(job, page):
    user, pw = secret(f"APARAT_USER_{suffix(page)}"), secret(f"APARAT_PASS_{suffix(page)}")
    if not (user and pw):
        raise NeedsSetup("آپارات API عمومی و مستند برای آپلود ندارد (API قدیمی etc/api از کار افتاده). "
                         f"با Secretهای APARAT_USER_{suffix(page)} و APARAT_PASS_{suffix(page)} روش قدیمی امتحان می‌شود.")
    if not is_video(job):
        return {"status": "skipped", "reason": "آپارات فقط ویدیو می‌پذیرد."}
    # legacy documented flow: login -> uploadform -> multipart POST
    lpass = hashlib.sha1(hashlib.md5(pw.encode()).hexdigest().encode()).hexdigest()
    r = requests.get(f"https://www.aparat.com/etc/api/login/luser/{user}/lpass/{lpass}", timeout=30)
    if r.status_code != 200:
        raise NeedsSetup(f"API ورود آپارات در دسترس نیست (HTTP {r.status_code})؛ انتشار خودکار آپارات فعلاً ممکن نیست.")
    ltoken = (r.json().get("login") or {}).get("ltoken")
    if not ltoken:
        raise RuntimeError("ورود به آپارات ناموفق؛ نام کاربری/رمز را بررسی کن")
    f = requests.get(f"https://www.aparat.com/etc/api/uploadform/luser/{user}/ltoken/{ltoken}", timeout=30).json()
    form = f.get("uploadform") or {}
    if not form.get("formAction"):
        raise RuntimeError("فرم آپلود آپارات دریافت نشد")
    with open(local_file(job), "rb") as fh:
        up = requests.post(form["formAction"], files={"video": fh}, timeout=1800, data={
            "frm-id": form.get("frm-id"), "data[title]": (job.get("title") or "ویدیو")[:100],
            "data[category]": "7", "data[tags]": "شده-دیگه", "data[comment]": "yes",
            "data[descr]": job.get("caption") or ""})
    if up.status_code != 200:
        raise RuntimeError(f"آپلود آپارات ناموفق (HTTP {up.status_code})")
    return {"status": "published", "reason": "ویدیو برای آپارات ارسال شد (پس از بازبینی آپارات نمایش داده می‌شود)."}


# --------------------------------------------------------------------------- TikTok
def publish_tiktok(job, page):
    token = secret(f"TIKTOK_ACCESS_TOKEN_{suffix(page)}")
    if not token:
        raise NeedsSetup(f"تیک‌تاک برای انتشار به اپ تأییدشده‌ی Content Posting API و Secret TIKTOK_ACCESS_TOKEN_{suffix(page)} نیاز دارد.")
    if not is_video(job):
        return {"status": "skipped", "reason": "انتشار عکس در تیک‌تاک از این مسیر پشتیبانی نمی‌شود."}
    h = {"Authorization": f"Bearer {token}", "Content-Type": "application/json; charset=UTF-8"}
    info = requests.post("https://open.tiktokapis.com/v2/post/publish/creator_info/query/", headers=h, timeout=30)
    if info.status_code != 200:
        raise RuntimeError(f"تیک‌تاک توکن را نپذیرفت (HTTP {info.status_code}): {info.text[:150]}")
    opts = (info.json().get("data") or {}).get("privacy_level_options") or ["SELF_ONLY"]
    privacy = "PUBLIC_TO_EVERYONE" if "PUBLIC_TO_EVERYONE" in opts else opts[0]
    path = local_file(job)
    size = os.path.getsize(path)
    chunk = size if size <= 64 * 1024 * 1024 else 10 * 1024 * 1024
    count = max(1, size // chunk)
    init = requests.post("https://open.tiktokapis.com/v2/post/publish/video/init/", headers=h, timeout=60, json={
        "post_info": {"title": ((job.get("caption") or job.get("title") or "")[:2200]), "privacy_level": privacy},
        "source_info": {"source": "FILE_UPLOAD", "video_size": size, "chunk_size": chunk, "total_chunk_count": count}})
    d = init.json() if init.headers.get("content-type", "").startswith("application/json") else {}
    if init.status_code != 200 or not (d.get("data") or {}).get("upload_url"):
        raise RuntimeError(f"شروع انتشار تیک‌تاک ناموفق (HTTP {init.status_code}): {init.text[:200]}")
    url, pub_id = d["data"]["upload_url"], d["data"]["publish_id"]
    with open(path, "rb") as fh:
        for i in range(count):
            start = i * chunk
            end = size - 1 if i == count - 1 else start + chunk - 1
            fh.seek(start)
            body = fh.read(end - start + 1)
            u = requests.put(url, data=body, timeout=900, headers={
                "Content-Type": job["media"].get("type") or "video/mp4", "Content-Length": str(len(body)),
                "Content-Range": f"bytes {start}-{end}/{size}"})
            if u.status_code not in (200, 201, 206):
                raise RuntimeError(f"آپلود تیک‌تاک ناموفق (HTTP {u.status_code})")
    for _ in range(30):
        s = requests.post("https://open.tiktokapis.com/v2/post/publish/status/fetch/", headers=h,
                          json={"publish_id": pub_id}, timeout=30).json()
        st = (s.get("data") or {}).get("status")
        if st == "PUBLISH_COMPLETE":
            note = "" if privacy == "PUBLIC_TO_EVERYONE" else " (اپ تأیید نشده: فقط برای خودت قابل مشاهده است)"
            return {"status": "published", "remote_id": pub_id, "reason": ("منتشر شد" + note) if note else None}
        if st == "FAILED":
            raise RuntimeError(f"تیک‌تاک انتشار را رد کرد: {(s.get('data') or {}).get('fail_reason')}")
        time.sleep(10)
    return {"status": "published", "remote_id": pub_id, "reason": "ارسال شد؛ تیک‌تاک هنوز در حال پردازش است."}


# --------------------------------------------------------------------------- Buffer (Instagram / TikTok)
def _norm_handle(h):
    return re.sub(r"^@", "", str(h or "").strip()).lower()


def buffer_channel(page, platform):
    """The page's Buffer channel for this platform, from data/buffer.json (written by buffer_sync.py), or None."""
    try:
        with open(os.path.join(ROOT, "data", "buffer.json"), encoding="utf-8") as f:
            d = json.load(f)
    except (OSError, ValueError):
        return None
    p = (d.get("pages") or {}).get(page) or {}
    if p.get("status") != "ok":
        return None
    for ch in p.get("channels") or []:
        if ch.get("service") == platform:
            return ch
    return None


def buffer_key(page):
    """Printable ASCII only (a pasted bullet / NBSP / zero-width char breaks the latin-1 HTTP header)."""
    raw = secret(f"BUFFER_KEY_{suffix(page)}")
    key = "".join(c for c in raw if 33 <= ord(c) < 127)
    if raw and not key:
        raise NeedsSetup(f"Secret BUFFER_KEY_{suffix(page)} کاراکتر غیرلاتین دارد؛ کلید API را دوباره از تنظیمات بافر کپی کن.")
    return key


def buffer_gql(key, query, variables=None):
    r = requests.post(BUFFER_API, json={"query": query, "variables": variables or {}}, timeout=60,
                      headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"})
    try:
        d = r.json()
    except ValueError:
        raise RuntimeError(f"پاسخ نامعتبر از بافر (HTTP {r.status_code})")
    if d.get("errors"):
        msg = "; ".join(x.get("message", "") for x in d["errors"])
        if r.status_code in (401, 403) or "auth" in msg.lower():
            raise NeedsSetup(f"بافر کلید API را نپذیرفت ({msg[:120]})؛ کلید تازه بساز و در Secret بگذار.")
        raise RuntimeError(f"خطای بافر: {msg[:250]}")
    return d.get("data") or {}


Q_BUFFER_CREATE = """mutation($input: CreatePostInput!){ createPost(input: $input){
  ... on PostActionSuccess { post { id status dueAt externalLink } }
  ... on MutationError { message } } }"""
Q_BUFFER_POST = "query($id: PostId!){ post(input: {id: $id}){ id status externalLink } }"


def publish_buffer(job, page, platform, ch, key):
    expected = _norm_handle(((cpage(page) or {}).get("accounts") or {}).get(platform))
    got = {_norm_handle(ch.get("name")), _norm_handle(ch.get("displayName"))}
    if expected and expected not in got:
        raise NeedsSetup(f"کانال بافر ({ch.get('name')}) با اکانت این پیج ({expected}) یکی نیست؛ برای امنیت منتشر نشد.")
    if ch.get("isQueuePaused"):
        raise NeedsSetup("صف این کانال در بافر متوقف (Paused) است؛ در بافر صف را فعال کن.")
    if not job.get("asset_url"):
        raise RuntimeError("آدرس عمومی فایل آماده نیست")
    video = is_video(job)
    if platform == "tiktok" and not video:
        return {"status": "skipped", "reason": "انتشار عکس در تیک‌تاک از این مسیر پشتیبانی نمی‌شود."}
    inp = {"channelId": ch["id"], "text": job.get("caption") or job.get("title") or "", "schedulingType": "automatic", "mode": "shareNow",
           "assets": [{"video": {"url": job["asset_url"]}} if video else {"image": {"url": job["asset_url"]}}]}
    if platform == "instagram":
        inp["metadata"] = {"instagram": {"type": "reel" if video else "post", "shouldShareToFeed": True}}
    res = buffer_gql(key, Q_BUFFER_CREATE, {"input": inp}).get("createPost") or {}
    if res.get("message") and not res.get("post"):
        raise RuntimeError(f"بافر پست را نساخت: {res['message'][:250]}")
    post = res.get("post") or {}
    pid = post.get("id")
    if not pid:
        raise RuntimeError("بافر شناسه‌ی پست را برنگرداند")
    st, link = post.get("status"), post.get("externalLink")
    for _ in range(int(os.environ.get("SP_BUFFER_POLLS", "20"))):  # ~5 min
        if st in ("sent", "error"):
            break
        time.sleep(float(os.environ.get("SP_BUFFER_WAIT", "15")))
        try:
            p = buffer_gql(key, Q_BUFFER_POST, {"id": pid}).get("post") or {}
            st, link = p.get("status") or st, p.get("externalLink") or link
        except RuntimeError:
            break
    if st == "error":
        raise RuntimeError("بافر انتشار را انجام نداد (وضعیت error در بافر؛ جزئیات در صفحه‌ی بافر)")
    out = {"status": "published", "remote_id": pid, "via": "buffer", "url": link}
    if st != "sent":
        out["reason"] = "به بافر سپرده شد؛ بافر در حال انتشار است."
    return out


_CFG = None


def cpage(page):
    global _CFG
    if _CFG is None:
        with open(os.path.join(ROOT, "config.json"), encoding="utf-8") as f:
            _CFG = json.load(f)
    return next((p for p in _CFG["pages"] if p["id"] == page), None)


def official_ready(page, platform):
    sfx = suffix(page)
    if platform == "instagram":
        return bool(secret(f"IG_ACCESS_TOKEN_{sfx}") and secret(f"IG_USER_ID_{sfx}"))
    if platform == "tiktok":
        return bool(secret(f"TIKTOK_ACCESS_TOKEN_{sfx}"))
    return False


def via_buffer(fn, platform):
    """Instagram/TikTok: the official API when its secrets exist, otherwise the page's Buffer channel."""
    def run(job, page):
        if official_ready(page, platform):
            return fn(job, page)
        ch = buffer_channel(page, platform)
        if ch:
            key = buffer_key(page)
            if not key:
                raise NeedsSetup(f"کانال {PLATFORM_FA[platform]} در بافر وصل است ولی Secret BUFFER_KEY_{suffix(page)} در publish.yml به اسکریپت نمی‌رسد.")
            return publish_buffer(job, page, platform, ch, key)
        raise NeedsSetup(f"{PLATFORM_FA[platform]} این پیج نه کلید API رسمی دارد نه در بافر وصل است؛ کانال را در بافر وصل کن "
                         f"(و Secret BUFFER_KEY_{suffix(page)} را بگذار) یا دستی منتشر کن.")
    return run


PLATFORM_FA = {"instagram": "اینستاگرام", "tiktok": "تیک‌تاک", "youtube": "یوتیوب", "aparat": "آپارات"}


PUBLISHERS = {"youtube": publish_youtube, "instagram": via_buffer(publish_instagram, "instagram"),
              "aparat": publish_aparat, "tiktok": via_buffer(publish_tiktok, "tiktok")}


def route_ready(page, platform):
    """Can this channel publish automatically right now? (used for targets queued as «manual»)"""
    if platform == "youtube":
        try:
            sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
            import yt_tokens
            return bool(yt_tokens.entry_for_page(yt_tokens.load(), page)) and bool(secret("TOKEN_KEY"))
        except Exception:
            return False
    if platform in ("instagram", "tiktok"):
        return official_ready(page, platform) or bool(buffer_channel(page, platform) and secret(f"BUFFER_KEY_{suffix(page)}"))
    return False


# --------------------------------------------------------------------------- capabilities (for the panel)
def caps():
    """Which channels can publish automatically. Booleans + Persian reasons only, never a secret value."""
    with open(os.path.join(ROOT, "config.json"), encoding="utf-8") as f:
        cfg = json.load(f)
    store = {}
    try:
        with open(os.path.join(ROOT, "config", "yt_tokens.enc.json"), encoding="utf-8") as f:
            store = (json.load(f) or {}).get("channels") or {}
    except (OSError, ValueError):
        store = {}
    yt_app = bool(secret("YT_CLIENT_ID") and secret("YT_CLIENT_SECRET") and secret("TOKEN_KEY"))
    out = {}
    for p in cfg["pages"]:
        pid, sfx = p["id"], suffix(p["id"])
        acc = p.get("accounts") or {}
        if acc.get("youtube"):
            conn = any(e.get("page") == pid and not e.get("mismatch") for e in store.values())
            out[f"{pid}/youtube"] = {"ready": yt_app and conn, "reason_fa": None if yt_app and conn else
                                     ("یوتیوب این پیج هنوز متصل نیست" if yt_app else "Secretهای OAuth یوتیوب کامل نیست")}
        for pl in ("instagram", "tiktok"):
            if not acc.get(pl):
                continue
            off = official_ready(pid, pl)
            bch = buffer_channel(pid, pl)
            bkey = secret(f"BUFFER_KEY_{sfx}")
            ok = off or bool(bch and bkey)
            reason = None
            if not ok:
                reason = ("کانال در بافر وصل است ولی کلید بافر به انتشار نمی‌رسد" if bch else
                          f"نه کلید API رسمی {PLATFORM_FA[pl]} هست نه اتصال بافر")
            out[f"{pid}/{pl}"] = {"ready": ok, "via": "official" if off else "buffer" if ok else None, "reason_fa": reason}
        if acc.get("aparat"):
            out[f"{pid}/aparat"] = {"ready": False, "reason_fa": "آپارات API انتشار عمومی ندارد"}
    return out


def write_caps():
    path = os.path.join(ROOT, "config", "publish_caps.json")
    ch = caps()
    try:
        with open(path, encoding="utf-8") as f:
            if (json.load(f) or {}).get("channels") == ch:
                return  # unchanged: no commit
    except (OSError, ValueError):
        pass
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"v": 1, "updated_at": iso_tehran(), "note": "written by scripts/publish.py: whether each channel can publish automatically (no secret values)",
                   "channels": ch}, f, ensure_ascii=False, indent=1)
        f.write("\n")


# --------------------------------------------------------------------------- main
def parse_time(v):
    try:
        return datetime.fromisoformat(str(v).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None


def aggregate(job):
    """pending (something queued / retrying) -> needs_action (a channel waits for the panel) -> published | partial | failed."""
    res = job.get("results") or {}
    sts = [(res.get(f"{t['page']}/{t['platform']}") or {}).get("status") for t in job.get("targets", [])]
    if any(s not in FINAL for s in sts):
        return "pending"
    if any(s in UNRESOLVED for s in sts):
        return "needs_action"
    if all(s == "published" for s in sts):
        return "published"
    if any(s == "published" for s in sts):
        return "partial"
    return "failed"


def main():
    if not GH_TOKEN:
        log("GITHUB_TOKEN missing; cannot move media or read blobs")
    os.makedirs(QUEUE, exist_ok=True)
    gallery_moved = set()
    if GH_TOKEN:
        try:
            gallery_moved = migrate_gallery()
        except Exception as e:
            log(f"gallery move failed: {e}")
    changed = 0
    keep_paths = set()
    for path in sorted(glob.glob(os.path.join(QUEUE, "*.json"))):
        try:
            with open(path, encoding="utf-8") as f:
                job = json.load(f)
        except Exception as e:
            log(f"skip {path}: {e}")
            continue
        before = json.dumps(job, sort_keys=True, ensure_ascii=False)
        media = job.get("media") or {}
        status = job.get("status", "pending")

        if status == "pending" and media.get("blob_sha") and not job.get("asset_url"):
            try:
                migrate_to_release(job)
                log(f"{job['id']}: media moved to release -> {job['asset_url']}")
            except Exception as e:
                log(f"{job['id']}: media move failed: {e}")
                job["media_error"] = str(e)[:200]
        if status == "pending" and media.get("path") and not job.get("asset_url"):
            keep_paths.add(media["path"])

        due = parse_time(job.get("publish_at")) or now()
        if status == "pending" and due <= now():
            job.setdefault("results", {})
            for t in job.get("targets", []):
                key = f"{t['page']}/{t['platform']}"
                if (job["results"].get(key) or {}).get("status") in FINAL:
                    continue
                fn = PUBLISHERS.get(t["platform"])
                prev = job["results"].get(key) or {}
                attempts = int(prev.get("attempts") or 0)
                if t.get("manual") and route_ready(t["page"], t["platform"]):
                    t.pop("manual", None)  # connected since it was queued: publish automatically
                if t.get("manual"):
                    # chosen in the panel while the channel had no automatic connection: a reminder, not an attempt
                    job["results"][key] = {"status": "manual", "reason": "این کانال موقع ثبت به انتشار خودکار وصل نبود", "at": iso_tehran()}
                    log(f"{job['id']}: {key} -> manual")
                    continue
                try:
                    if not fn:
                        raise NeedsSetup("این شبکه پشتیبانی نمی‌شود")
                    out = fn(job, t["page"])
                except NeedsSetup as e:
                    out = {"status": "needs_setup", "reason": str(e)}
                except Exception as e:
                    attempts += 1
                    reason = str(e)[:300]
                    if attempts < MAX_ATTEMPTS:
                        out = {"status": "retry", "reason": reason, "attempts": attempts}
                    else:
                        out = {"status": "failed", "reason": f"بعد از {MAX_ATTEMPTS} تلاش ناموفق ماند: {reason}", "attempts": attempts}
                out = {k: v for k, v in out.items() if v is not None}
                if out.get("status") == "published":
                    out["attempts"] = attempts + 1
                if prev.get("retry_requested_at"):
                    out["retry_requested_at"] = prev["retry_requested_at"]
                out["at"] = iso_tehran()
                job["results"][key] = out
                log(f"{job['id']}: {key} -> {out['status']} {out.get('reason', '')}")
            job["status"] = aggregate(job)
            if job["status"] != "pending":
                job["finished_at"] = iso_tehran()

        if json.dumps(job, sort_keys=True, ensure_ascii=False) != before:
            with open(path, "w", encoding="utf-8") as f:
                json.dump(job, f, ensure_ascii=False, indent=1)
                f.write("\n")
            changed += 1

    for p in _FILES.values():
        try:
            os.remove(p)
        except OSError:
            pass
    if GH_TOKEN:
        try:
            rebuild_media_branch(keep_paths, gallery_moved)
        except Exception as e:
            log(f"media branch cleanup failed: {e}")
    try:
        write_caps()
    except Exception as e:
        log(f"publish_caps.json not written: {e}")
    log(f"done: {changed} job file(s) updated")


if __name__ == "__main__":
    main()
