#!/usr/bin/env python3
"""Gallery inbox: push a file made in an external tool into the panel's «گالری محتوا».

Run by .github/workflows/gallery-ingest.yml (workflow_dispatch). Inputs come from $GITHUB_EVENT_PATH:
  url      (required) direct http(s) link to the image/video file (≤ 70 MB)
  domain   (required) page id from config.json, e.g. "titan-station"
  kind     optional: auto | slide | reel | story | video   (auto = same rules as the panel)
  story    optional "true": the clip is meant as a story (video ≤ 60 s → استوری)
  title    optional title shown in the gallery
  brain_id optional id of a «مغز متفکر» item to link
  req      optional request id (appears in the run name, for callers that poll)
  dry_run  optional "true": download + classify + report only; nothing is uploaded or committed

Steps: download → probe (Pillow for images, ffprobe for videos) → classify → thumbnail (≤ 240 px JPEG) →
upload to the "gallery" release as <id>-1.<ext> → write inbox/<id>.enc.json, ENCRYPTED to the panel's public
key in config/inbox_pub.json (ECDH P-256 ephemeral + HKDF-SHA256 info "sp-inbox-v1" + AES-256-GCM, AAD
"sp-inbox-v1|<id>"). Nothing readable about the item lands in the repo; the panel (once unlocked) decrypts
inbox items, adds them to vault/gallery-<domain>.enc.json and deletes the inbox file.
The media file itself is public to anyone with the release link (same as panel uploads).
Exit code 0 on success, 1 on any error (message printed, Persian + English).
"""
import base64
import io
import json
import os
import random
import re
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta, timezone

import requests

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.environ.get("SP_ROOT") or os.path.dirname(HERE)  # SP_ROOT: tests only
sys.path.insert(0, HERE)
import gallery_classify  # noqa: E402

REPO = os.environ.get("GITHUB_REPOSITORY", "negin1100mohammadi/social-panel")
GH_TOKEN = os.environ.get("GITHUB_TOKEN", "")
TAG = "gallery"
MAX = 70 * 1024 * 1024
TEHRAN = timezone(timedelta(hours=3, minutes=30))
KINDS = ("slide", "reel", "story", "video")
API = os.environ.get("SP_GH_API", "https://api.github.com")
UPLOADS = os.environ.get("SP_GH_UPLOADS", "https://uploads.github.com")


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def fail(fa, en):
    print(f"::error::{en}")
    log(f"✗ {fa} ({en})")
    sys.exit(1)


def b64u(b):
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def unb64u(s):
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def inputs():
    p = os.environ.get("GITHUB_EVENT_PATH")
    if p and os.path.exists(p):
        with open(p, encoding="utf-8") as f:
            return (json.load(f).get("inputs") or {})
    return json.loads(os.environ.get("SP_INPUTS") or "{}")  # local tests


def new_id():
    t = datetime.now(TEHRAN)
    return "g" + t.strftime("%y%m%d-%H%M%S") + "-" + "%04x" % random.getrandbits(16)


def download(url, dest):
    if not re.match(r"^https?://", url or ""):
        fail("لینک فایل باید با http یا https شروع شود", "url must be http(s)")
    with requests.get(url, stream=True, timeout=120, allow_redirects=True) as r:
        if r.status_code != 200:
            fail(f"دانلود فایل ناموفق بود (HTTP {r.status_code})", f"download HTTP {r.status_code}")
        n = 0
        with open(dest, "wb") as f:
            for chunk in r.iter_content(1 << 20):
                n += len(chunk)
                if n > MAX:
                    fail("فایل بزرگ‌تر از ۷۰ مگابایت است", "file larger than 70 MB")
                f.write(chunk)
        return r.headers.get("Content-Type", "").split(";")[0].strip(), n


def probe(path, ctype, url):
    """returns {type, w, h, dur, mime, ext}"""
    from PIL import Image
    try:
        with Image.open(path) as im:
            im.load()
            fmt = (im.format or "").lower()
            ext = {"jpeg": "jpg", "png": "png", "webp": "webp", "gif": "gif", "heif": "heic", "mpo": "jpg"}.get(fmt, fmt or "jpg")
            mime = Image.MIME.get(im.format or "", ctype or "image/jpeg")
            w, h = im.size
            try:  # EXIF orientation 5-8 swaps the visible width/height
                if im.getexif().get(0x0112) in (5, 6, 7, 8):
                    w, h = h, w
            except Exception:
                pass
            return {"type": "image", "w": w, "h": h, "dur": 0, "mime": mime, "ext": ext}
    except Exception:
        pass
    try:
        out = subprocess.run(["ffprobe", "-v", "error", "-print_format", "json", "-show_streams", "-show_format", path],
                             capture_output=True, text=True, timeout=120)
        info = json.loads(out.stdout or "{}")
    except Exception as e:
        fail("خواندن فایل با ffprobe ممکن نشد", f"ffprobe failed: {e}")
    vs = [s for s in info.get("streams", []) if s.get("codec_type") == "video"]
    if not vs:
        fail("فایل نه عکس قابل‌خواندن است نه ویدئو", "not an image or a video")
    v = vs[0]
    w, h = int(v.get("width") or 0), int(v.get("height") or 0)
    rot = 0
    try:
        rot = int((v.get("tags") or {}).get("rotate") or 0)
    except ValueError:
        rot = 0
    for sd in v.get("side_data_list") or []:
        if "rotation" in sd:
            try:
                rot = int(float(sd["rotation"]))
            except (TypeError, ValueError):
                pass
    if abs(rot) % 180 == 90:
        w, h = h, w
    dur = float((info.get("format") or {}).get("duration") or v.get("duration") or 0)
    fmt = (info.get("format") or {}).get("format_name", "")
    ext = "webm" if "webm" in fmt else "mov" if ("mov" in fmt and str(url).lower().split("?")[0].endswith(".mov")) else "mp4"
    mime = ctype if ctype.startswith("video/") else {"webm": "video/webm", "mov": "video/quicktime"}.get(ext, "video/mp4")
    return {"type": "video", "w": w, "h": h, "dur": round(dur, 1), "mime": mime, "ext": ext}


def thumbnail(path, meta):
    from PIL import Image, ImageOps
    src = path
    tmp = None
    if meta["type"] == "video":
        fd, tmp = tempfile.mkstemp(suffix=".jpg")
        os.close(fd)
        at = min(1.0, (meta["dur"] or 2) / 3)
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", str(at), "-i", path, "-frames:v", "1", tmp], capture_output=True, timeout=120)
        if not os.path.getsize(tmp):
            return ""
        src = tmp
    try:
        with Image.open(src) as im:
            im = ImageOps.exif_transpose(im).convert("RGB")
            im.thumbnail((240, 240))
            buf = io.BytesIO()
            im.save(buf, "JPEG", quality=60)
            return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()
    except Exception:
        return ""
    finally:
        if tmp:
            os.remove(tmp)


def gh(method, path, **kw):
    h = kw.pop("headers", {})
    h.setdefault("Accept", "application/vnd.github+json")
    h["Authorization"] = f"Bearer {GH_TOKEN}"
    h["X-GitHub-Api-Version"] = "2022-11-28"
    url = path if path.startswith("http") else f"{API}/repos/{REPO}{path}"
    return requests.request(method, url, headers=h, timeout=kw.pop("timeout", 60), **kw)


def ensure_release():
    r = gh("GET", f"/releases/tags/{TAG}")
    if r.status_code == 200:
        return r.json()
    r = gh("POST", "/releases", json={"tag_name": TAG, "name": "Gallery (panel content store)", "prerelease": True,
                                       "body": "Media of the panel's «گالری محتوا». Metadata is encrypted in vault/; files here are public to anyone with the link."})
    if r.status_code not in (200, 201):
        fail("ساخت Release گالری ممکن نشد", f"release create HTTP {r.status_code}: {r.text[:200]}")
    return r.json()


def upload_asset(rel, path, name, mime):
    up = rel.get("upload_url", "").split("{")[0] or f"{UPLOADS}/repos/{REPO}/releases/{rel['id']}/assets"
    with open(path, "rb") as f:
        r = requests.post(up, params={"name": name}, data=f, timeout=900,
                          headers={"Authorization": f"Bearer {GH_TOKEN}", "Content-Type": mime, "Accept": "application/vnd.github+json",
                                   "Content-Length": str(os.path.getsize(path))})
    if r.status_code not in (200, 201):
        fail("آپلود فایل به Release ناموفق بود", f"asset upload HTTP {r.status_code}: {r.text[:200]}")
    return r.json()["browser_download_url"]


def encrypt_to_panel(pub, item_id, payload):
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF
    jwk = pub["jwk"]
    pk = ec.EllipticCurvePublicNumbers(int.from_bytes(unb64u(jwk["x"]), "big"), int.from_bytes(unb64u(jwk["y"]), "big"), ec.SECP256R1()).public_key()
    eph = ec.generate_private_key(ec.SECP256R1())
    shared = eph.exchange(ec.ECDH(), pk)
    key = HKDF(algorithm=hashes.SHA256(), length=32, salt=None, info=b"sp-inbox-v1").derive(shared)
    iv = os.urandom(12)
    ct = AESGCM(key).encrypt(iv, json.dumps(payload, ensure_ascii=False).encode(), ("sp-inbox-v1|" + item_id).encode())
    n = eph.public_key().public_numbers()
    return {"v": 1, "id": item_id, "kid": pub.get("kid"), "alg": "ECDH-P256+HKDF-SHA256+A256GCM",
            "epk": {"kty": "EC", "crv": "P-256", "x": b64u(n.x.to_bytes(32, "big")), "y": b64u(n.y.to_bytes(32, "big"))},
            "iv": base64.b64encode(iv).decode(), "ct": base64.b64encode(ct).decode()}


def main():
    inp = inputs()
    url, domain = (inp.get("url") or "").strip(), (inp.get("domain") or "").strip()
    kind = (inp.get("kind") or "auto").strip().lower()
    story = str(inp.get("story") or "").lower() in ("1", "true", "yes")
    dry = str(inp.get("dry_run") or "").lower() in ("1", "true", "yes")
    with open(os.path.join(ROOT, "config.json"), encoding="utf-8") as f:
        pages = {p["id"] for p in json.load(f)["pages"]}
    if domain not in pages:
        fail(f"دامنه «{domain}» در config.json نیست ({', '.join(sorted(pages))})", "unknown domain")
    if kind not in ("auto",) + KINDS:
        fail("نوع باید auto, slide, reel, story یا video باشد", "bad kind")
    pub_path = os.path.join(ROOT, "config", "inbox_pub.json")
    pub = None
    if os.path.exists(pub_path):
        with open(pub_path, encoding="utf-8") as f:
            pub = json.load(f)
    if not pub and not dry:
        fail("کلید عمومی صندوق ورودی هنوز ساخته نشده: یک بار پنل را باز کن و «مغز متفکر» یا «گالری» را با رمز پنل باز کن",
             "config/inbox_pub.json missing (open the panel's brain/gallery once to create the data key)")
    fd, path = tempfile.mkstemp()
    os.close(fd)
    try:
        ctype, size = download(url, path)
        meta = probe(path, ctype, url)
        auto = gallery_classify.classify_upload([meta], story)[0]
        chosen = auto["kind"] if kind == "auto" else kind
        item_id = new_id()
        name = f"{item_id}-1.{meta['ext']}"
        log(f"file: {size} bytes, {meta['type']} {meta['w']}x{meta['h']} {meta['dur']}s -> auto {auto['kind']} ({auto['rule']}); chosen {chosen}")
        thumb = thumbnail(path, meta)
        if dry:
            log(f"dry run: would upload {name} to release '{TAG}' and write inbox/{item_id}.enc.json"
                f"{'' if pub else ' (inbox_pub.json missing: real runs would fail)'}; thumbnail {len(thumb)} chars")
            print(json.dumps({"ok": True, "dry_run": True, "type": meta["type"], "w": meta["w"], "h": meta["h"], "dur": meta["dur"],
                              "kind_auto": auto["kind"], "kind": chosen, "thumb": bool(thumb), "inbox_pub": bool(pub)}))
            return
        if not GH_TOKEN:
            fail("GITHUB_TOKEN در دسترس نیست", "GITHUB_TOKEN missing")
        rel = ensure_release()
        asset_url = upload_asset(rel, path, name, meta["mime"])
        now = datetime.now(TEHRAN).replace(microsecond=0).isoformat()
        payload = {"id": item_id, "page": domain, "kind": chosen, "kind_auto": auto["kind"], "rule": auto["rule"] + ("" if kind == "auto" else " (نوع از ورودی تعیین شد)"),
                   "override": kind != "auto" and kind != auto["kind"], "title": (inp.get("title") or "").strip()[:120], "caption": "",
                   "media": [{"name": name, "url": asset_url, "type": meta["mime"], "size": size, "w": meta["w"], "h": meta["h"], "dur": meta["dur"]}],
                   "thumb": thumb, "status": "uploaded", "brain_id": (inp.get("brain_id") or "").strip(),
                   "source": {"via": "gallery-ingest", "url": url, "req": inp.get("req") or ""}, "created_at": now, "updated_at": now}
        enc = encrypt_to_panel(pub, item_id, payload)
        os.makedirs(os.path.join(ROOT, "inbox"), exist_ok=True)
        with open(os.path.join(ROOT, "inbox", f"{item_id}.enc.json"), "w", encoding="utf-8") as f:
            json.dump(enc, f)
            f.write("\n")
        log(f"✓ uploaded {name}; inbox/{item_id}.enc.json written (encrypted to kid {pub.get('kid')})")
        print(json.dumps({"ok": True, "id": item_id, "kind": chosen, "kind_auto": auto["kind"]}))
    finally:
        try:
            os.remove(path)
        except OSError:
            pass


if __name__ == "__main__":
    main()
