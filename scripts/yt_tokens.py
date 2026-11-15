#!/usr/bin/env python3
"""Encrypted store of YouTube OAuth refresh tokens: config/yt_tokens.enc.json.

The repository is public, so only ciphertext is committed. Each refresh token is sealed with
AES-256-GCM using TOKEN_KEY (repo secret: 32 random bytes, base64). The channel id is bound as
associated data, so a ciphertext cannot be moved to another channel's entry.

File layout (everything except iv/ct is public metadata about public channels):
{
  "v": 1,
  "updated_at": "2026-11-15T20:00:00Z",
  "channels": {
    "UC...": {
      "page": "shode-dige",            # panel page key the user connected it from
      "channel_id": "UC...",
      "title": "...", "handle": "@...", "thumb": "https://...",
      "expected_channel_id": "UC..." | null,   # channel configured for that page at connect time
      "mismatch": false,                # authorized channel != the page's configured channel
      "scopes": ["https://www.googleapis.com/auth/youtube.upload", ...],
      "connected_at": "...", "status": "ok",
      "iv": "<b64>", "ct": "<b64>"      # AES-GCM(refresh_token)
    }
  }
}

Secrets never reach a log: every token value is registered with ::add-mask:: before anything else
happens, and no function here prints a token.
"""
import base64
import json
import os
import sys
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STORE_PATH = os.path.join(ROOT, "config", "yt_tokens.enc.json")
# overridable only so the tests can point at a mock Google server
TOKEN_URL = os.environ.get("SP_GOOGLE_TOKEN_URL") or "https://oauth2.googleapis.com/token"
API = os.environ.get("SP_YT_API") or "https://www.googleapis.com/youtube/v3"
REDIRECT_URI = "https://negin1100mohammadi.github.io/social-panel/oauth.html"


class StoreError(Exception):
    pass


_MASKED = set()


def mask(value):
    """Register a secret with the GitHub Actions log masker (stdout workflow command; the runner does not echo it)."""
    if value:
        for line in str(value).splitlines():
            line = line.strip()
            if line and line not in _MASKED:
                _MASKED.add(line)
                sys.stdout.write(f"::add-mask::{line}\n")
        sys.stdout.flush()


def now_iso():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _key():
    raw = (os.environ.get("TOKEN_KEY") or "").strip()
    if not raw:
        raise StoreError("TOKEN_KEY secret is missing")
    mask(raw)
    try:
        key = base64.b64decode(raw, validate=True)
    except Exception:
        raise StoreError("TOKEN_KEY is not valid base64")
    if len(key) != 32:
        raise StoreError("TOKEN_KEY must decode to 32 bytes")
    return key


def encrypt(plaintext, channel_id):
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    iv = os.urandom(12)
    ct = AESGCM(_key()).encrypt(iv, plaintext.encode("utf-8"), channel_id.encode("utf-8"))
    return base64.b64encode(iv).decode(), base64.b64encode(ct).decode()


def decrypt(entry):
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    try:
        pt = AESGCM(_key()).decrypt(base64.b64decode(entry["iv"]), base64.b64decode(entry["ct"]),
                                    entry["channel_id"].encode("utf-8"))
    except StoreError:
        raise
    except Exception:
        raise StoreError("could not decrypt the stored token (wrong TOKEN_KEY?)")
    tok = pt.decode("utf-8")
    mask(tok)
    return tok


def load(path=None):
    path = path or STORE_PATH
    try:
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
    except (FileNotFoundError, ValueError):
        d = {}
    d.setdefault("v", 1)
    d.setdefault("channels", {})
    return d


def save(store, path=None):
    path = path or STORE_PATH
    os.makedirs(os.path.dirname(path), exist_ok=True)
    store["updated_at"] = now_iso()
    with open(path, "w", encoding="utf-8") as f:
        json.dump(store, f, ensure_ascii=False, indent=1, sort_keys=True)
        f.write("\n")


def entries_for_page(store, page):
    return [e for e in store.get("channels", {}).values() if e.get("page") == page and e.get("ct")]


def entry_for_page(store, page, allow_mismatch=False):
    """Best connection for a page: a matching channel first, newest first. Mismatched channels only on request."""
    es = entries_for_page(store, page)
    es.sort(key=lambda e: (not e.get("mismatch"), e.get("connected_at") or ""), reverse=True)
    for e in es:
        if allow_mismatch or not e.get("mismatch"):
            return e
    return None


def client_creds():
    cid = (os.environ.get("YT_CLIENT_ID") or "").strip()
    csec = (os.environ.get("YT_CLIENT_SECRET") or "").strip()
    mask(csec)
    if not cid:
        try:
            with open(os.path.join(ROOT, "config.json"), encoding="utf-8") as f:
                cid = ((json.load(f).get("youtube_oauth") or {}).get("client_id") or "").strip()
        except Exception:
            cid = ""
    if not (cid and csec):
        raise StoreError("YT_CLIENT_ID / YT_CLIENT_SECRET secrets are missing")
    return cid, csec


def access_token(refresh_token, session=None):
    """Exchange a refresh token for an access token. Raises StoreError('revoked') on invalid_grant."""
    import requests
    s = session or requests
    cid, csec = client_creds()
    r = s.post(TOKEN_URL, data={"client_id": cid, "client_secret": csec, "refresh_token": refresh_token,
                                "grant_type": "refresh_token"}, timeout=30)
    try:
        body = r.json()
    except ValueError:
        body = {}
    if r.status_code != 200 or not body.get("access_token"):
        err = body.get("error") or f"HTTP {r.status_code}"
        if err == "invalid_grant":
            raise StoreError("revoked")
        raise StoreError(f"token refresh failed: {err}")
    mask(body["access_token"])
    return body["access_token"]
