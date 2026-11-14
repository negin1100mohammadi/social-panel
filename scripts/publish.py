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
They arrive as one JSON object in ALL_SECRETS (toJSON(secrets) in the workflow).
<PAGE> = page id upper-cased with "-" -> "_", e.g. shode-dige -> SHODE_DIGE.
  YouTube : YT_CLIENT_ID, YT_CLIENT_SECRET, YT_REFRESH_TOKEN_<PAGE>
  Instagram: IG_ACCESS_TOKEN_<PAGE>, IG_USER_ID_<PAGE>
  Aparat  : APARAT_USER_<PAGE>, APARAT_PASS_<PAGE>   (legacy etc/api; currently 503)
  TikTok  : TIKTOK_ACCESS_TOKEN_<PAGE>               (Content Posting API, approved app)
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

FINAL = {"published", "failed", "needs_setup", "skipped", "cancelled"}


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


def ensure_release():
    r = gh("GET", f"/releases/tags/{RELEASE_TAG}")
    if r.status_code == 200:
        return r.json()
    r = gh("POST", "/releases", json={
        "tag_name": RELEASE_TAG, "name": "Media queue (panel uploads)", "prerelease": True,
        "body": "Files uploaded from the panel for scheduled publishing. Safe to delete old assets."})
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


def rebuild_media_branch(keep_paths):
    """Keep only files that still need moving; delete the branch when nothing is left."""
    r = gh("GET", f"/git/ref/heads/{MEDIA_BRANCH}")
    if r.status_code == 404:
        return
    r.raise_for_status()
    head = r.json()["object"]["sha"]
    commit = gh("GET", f"/git/commits/{head}").json()
    tree = gh("GET", f"/git/trees/{commit['tree']['sha']}?recursive=1").json()
    files = [t for t in tree.get("tree", []) if t["type"] == "blob"]
    remain = [t for t in files if t["path"] in keep_paths]
    if len(remain) == len(files):
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
        with requests.get(job["asset_url"], stream=True, timeout=600) as r:
            r.raise_for_status()
            with open(path, "wb") as f:
                for chunk in r.iter_content(1 << 20):
                    f.write(chunk)
    else:
        download_staged(job, path)
    _FILES[job["id"]] = path
    return path


def is_video(job):
    return str((job.get("media") or {}).get("type", "")).startswith("video/")


# --------------------------------------------------------------------------- YouTube
def publish_youtube(job, page):
    cid, csec = secret("YT_CLIENT_ID"), secret("YT_CLIENT_SECRET")
    rt = secret(f"YT_REFRESH_TOKEN_{suffix(page)}")
    if not (cid and csec and rt):
        raise NeedsSetup(f"برای یوتیوب Secretهای YT_CLIENT_ID، YT_CLIENT_SECRET و YT_REFRESH_TOKEN_{suffix(page)} لازم است.")
    if not is_video(job):
        return {"status": "skipped", "reason": "یوتیوب فقط ویدیو می‌پذیرد؛ عکس منتشر نشد."}
    tok = requests.post("https://oauth2.googleapis.com/token", data={
        "client_id": cid, "client_secret": csec, "refresh_token": rt, "grant_type": "refresh_token"}, timeout=30)
    if tok.status_code != 200:
        raise RuntimeError(f"توکن یوتیوب تمدید نشد (HTTP {tok.status_code}): {tok.text[:150]}")
    access = tok.json()["access_token"]
    path = local_file(job)
    size = os.path.getsize(path)
    meta = {"snippet": {"title": (job.get("title") or "ویدیو")[:100], "description": job.get("caption") or "",
                        "categoryId": "22"},
            "status": {"privacyStatus": "public", "selfDeclaredMadeForKids": False}}
    init = requests.post("https://www.googleapis.com/upload/youtube/v3/videos",
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


PUBLISHERS = {"youtube": publish_youtube, "instagram": publish_instagram,
              "aparat": publish_aparat, "tiktok": publish_tiktok}


# --------------------------------------------------------------------------- main
def parse_time(v):
    try:
        return datetime.fromisoformat(str(v).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None


def aggregate(job):
    res = job.get("results") or {}
    sts = [(res.get(f"{t['page']}/{t['platform']}") or {}).get("status") for t in job.get("targets", [])]
    if any(s not in FINAL for s in sts):
        return "pending"
    if all(s == "published" for s in sts):
        return "published"
    if any(s == "published" for s in sts):
        return "partial"
    if all(s in ("needs_setup", "skipped") for s in sts):
        return "needs_setup"
    return "failed"


def main():
    if not GH_TOKEN:
        log("GITHUB_TOKEN missing; cannot move media or read blobs")
    os.makedirs(QUEUE, exist_ok=True)
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
                try:
                    if not fn:
                        raise NeedsSetup("این شبکه پشتیبانی نمی‌شود")
                    out = fn(job, t["page"])
                except NeedsSetup as e:
                    out = {"status": "needs_setup", "reason": str(e)}
                except Exception as e:
                    out = {"status": "failed", "reason": str(e)[:300]}
                out = {k: v for k, v in out.items() if v is not None}
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
            rebuild_media_branch(keep_paths)
        except Exception as e:
            log(f"media branch cleanup failed: {e}")
    log(f"done: {changed} job file(s) updated")


if __name__ == "__main__":
    main()
