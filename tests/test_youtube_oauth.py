#!/usr/bin/env python3
"""v7 tests: YouTube official connection (all Google endpoints mocked on localhost).

usage: python3 tests/test_youtube_oauth.py        (needs: requests, cryptography)

Covers
  * yt_tokens: AES-GCM round trip, channel id bound as associated data, wrong key refused, key validation
  * yt_connect.py (as the workflow runs it: inputs from GITHUB_EVENT_PATH): success, channel mismatch,
    invalid_grant, missing refresh token, account without channel, bad input; result file; encrypted store;
    no secret ever printed except inside ::add-mask:: commands
  * fetch_stats.py: connected channel -> exact stats + comments.json (newest first), revoked token ->
    public fallback with oauth.status=revoked, mismatched connection ignored for stats
  * yt_reply.py: comments.insert payload, result file, no connection -> needs_setup
  * publish.py: refresh token read from the encrypted store (not per-page secrets), upload uses it,
    mismatched connection refused, nothing connected -> needs_setup
"""
import base64
import importlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

# the mock Google server is on localhost: never send it through a proxy
os.environ["NO_PROXY"] = os.environ["no_proxy"] = "127.0.0.1,localhost"

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)

CLIENT_ID = "test-client.apps.googleusercontent.com"
CLIENT_SECRET = "TEST-CLIENT-SECRET-zz9"
KEY = base64.b64encode(bytes(range(32))).decode()
GOOD_CODE = "4/0GOOD-AUTH-CODE-xyz"
REFRESH = "1//REFRESH-TOKEN-SECRET-abc"
ACCESS = "ya29.ACCESS-TOKEN-SECRET-def"
REFRESH_OTHER = "1//REFRESH-OTHER-SECRET"
ACCESS_OTHER = "ya29.ACCESS-OTHER-SECRET"
REVOKED = "1//REVOKED-SECRET"
CH = "UCAAAAAAAAAAAAAAAAAAAAAA"      # the page's configured channel (24 chars)
CH_OTHER = "UCBBBBBBBBBBBBBBBBBBBBBB"
SECRETS = [CLIENT_SECRET, KEY, GOOD_CODE, REFRESH, ACCESS, REFRESH_OTHER, ACCESS_OTHER, REVOKED, "4/0OTHER-CODE"]


class Google(BaseHTTPRequestHandler):
    calls = []

    def log_message(self, *a):
        pass

    def _send(self, code, obj, headers=None):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def _auth(self):
        a = self.headers.get("Authorization", "")
        return a[7:] if a.startswith("Bearer ") else ""

    def do_POST(self):
        u = urlparse(self.path)
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b""
        Google.calls.append(("POST", u.path, raw))
        if u.path == "/token":
            f = {k: v[0] for k, v in parse_qs(raw.decode()).items()}
            if f.get("client_secret") != CLIENT_SECRET or f.get("client_id") != CLIENT_ID:
                return self._send(401, {"error": "invalid_client"})
            if f.get("grant_type") == "authorization_code":
                if f.get("redirect_uri") != "https://negin1100mohammadi.github.io/social-panel/oauth.html":
                    return self._send(400, {"error": "redirect_uri_mismatch"})
                c = f.get("code")
                scope = ("https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.force-ssl "
                         "https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/yt-analytics.readonly")
                if c == GOOD_CODE:
                    return self._send(200, {"access_token": ACCESS, "refresh_token": REFRESH, "expires_in": 3599, "scope": scope})
                if c == "4/0OTHER-CODE":
                    return self._send(200, {"access_token": ACCESS_OTHER, "refresh_token": REFRESH_OTHER, "scope": scope})
                if c == "4/0NOREFRESH":
                    return self._send(200, {"access_token": ACCESS, "scope": scope})
                if c == "4/0NOCHANNEL":
                    return self._send(200, {"access_token": "ya29.NOCHANNEL", "refresh_token": "1//NOCH", "scope": scope})
                return self._send(400, {"error": "invalid_grant"})
            if f.get("grant_type") == "refresh_token":
                rt = f.get("refresh_token")
                if rt == REFRESH:
                    return self._send(200, {"access_token": ACCESS, "expires_in": 3599})
                if rt == REFRESH_OTHER:
                    return self._send(200, {"access_token": ACCESS_OTHER})
                return self._send(400, {"error": "invalid_grant"})
        if u.path == "/yt/comments":
            if self._auth() != ACCESS:
                return self._send(401, {"error": {"errors": [{"reason": "authError"}]}})
            body = json.loads(raw)
            if body["snippet"]["parentId"] == "Ugx-disabled":
                return self._send(403, {"error": {"errors": [{"reason": "commentsDisabled"}]}})
            return self._send(200, {"id": "Ugx-reply-1", "snippet": {"publishedAt": "2026-11-15T20:00:00Z", **body["snippet"]}})
        if u.path == "/upload":
            if self._auth() != ACCESS:
                return self._send(401, {})
            port = self.server.server_address[1]
            return self._send(200, {}, {"Location": f"http://127.0.0.1:{port}/upload-session"})
        self._send(404, {})

    def do_PUT(self):
        n = int(self.headers.get("Content-Length") or 0)
        self.rfile.read(n)
        Google.calls.append(("PUT", self.path, b""))
        if self.path == "/upload-session" and self._auth() == ACCESS:
            return self._send(200, {"id": "VIDEO123"})
        self._send(400, {})

    def do_GET(self):
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        Google.calls.append(("GET", u.path, u.query.encode()))
        tok = self._auth()
        chan = {ACCESS: CH, ACCESS_OTHER: CH_OTHER}.get(tok)
        if u.path == "/yt/channels":
            if tok == "ya29.NOCHANNEL":
                return self._send(200, {"items": []})
            if not chan or q.get("mine") != "true":
                return self._send(401, {"error": {"errors": [{"reason": "authError"}]}})
            return self._send(200, {"items": [{"id": chan, "snippet": {"title": "Test Channel " + chan[-1], "customUrl": "@test",
                                                                          "thumbnails": {"default": {"url": "https://yt3.example/a.jpg"}}},
                                                "statistics": {"subscriberCount": "37", "videoCount": "3", "viewCount": "1234"},
                                                "contentDetails": {"relatedPlaylists": {"uploads": "UU" + chan[2:]}}}]})
        if not chan:
            return self._send(401, {"error": {"errors": [{"reason": "authError"}]}})
        if u.path == "/yt/playlistItems":
            return self._send(200, {"items": [{"contentDetails": {"videoId": v}} for v in ("v3", "v2", "vPriv")]})
        if u.path == "/yt/videos":
            def v(i, views, likes, com, when, priv="public"):
                return {"id": i, "snippet": {"title": "Video " + i, "publishedAt": when, "thumbnails": {}},
                        "statistics": {"viewCount": str(views), "likeCount": str(likes), "commentCount": str(com)},
                        "status": {"privacyStatus": priv}}
            return self._send(200, {"items": [v("v2", 101, 7, 1, "2026-11-10T10:00:00Z"), v("v3", 57, 3, 2, "2026-11-14T10:00:00Z"),
                                              v("vPriv", 1, 0, 0, "2026-11-15T10:00:00Z", "private")]})
        if u.path == "/yt/commentThreads":
            assert q.get("allThreadsRelatedToChannelId") == chan
            def th(i, vid, text, when, reps=()):
                return {"id": i, "snippet": {"videoId": vid, "canReply": True, "totalReplyCount": len(reps),
                                             "topLevelComment": {"id": i, "snippet": {"authorDisplayName": "fan " + i, "textDisplay": text,
                                                                                     "likeCount": 2, "publishedAt": when, "videoId": vid}}},
                        "replies": {"comments": [{"id": i + ".r", "snippet": {"authorDisplayName": "owner", "textDisplay": r,
                                                                               "publishedAt": "2026-11-15T12:00:00Z"}} for r in reps]}}
            return self._send(200, {"items": [th("Ugx-old", "v2", "قدیمی", "2026-11-11T09:00:00Z", ("ممنون",)),
                                              th("Ugx-new", "v3", "عالی بود 👏", "2026-11-15T09:00:00Z")]})
        self._send(404, {})


def start_server():
    srv = ThreadingHTTPServer(("127.0.0.1", 0), Google)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


class Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = start_server()
        cls.base = f"http://127.0.0.1:{cls.srv.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()

    def setUp(self):
        Google.calls.clear()
        self.root = tempfile.mkdtemp(prefix="sp-yt-")
        shutil.copytree(os.path.join(REPO, "scripts"), os.path.join(self.root, "scripts"),
                        ignore=shutil.ignore_patterns("__pycache__"))
        os.makedirs(os.path.join(self.root, "data"))
        os.makedirs(os.path.join(self.root, "config"))
        cfg = {"timezone": "Asia/Tehran", "request_delay_seconds": 0, "recent_posts": 12,
               "pages": [{"id": "test-page", "name": "Test", "accounts": {"youtube": "@test"}},
                         {"id": "second", "name": "Second", "accounts": {"youtube": "@second"}}]}
        self.write("config.json", cfg)
        self.write("data/latest.json", {"pages": {"test-page": {"platforms": {"youtube": {"channel_id": CH}}}}})
        self.env = dict(os.environ, YT_CLIENT_ID=CLIENT_ID, YT_CLIENT_SECRET=CLIENT_SECRET, TOKEN_KEY=KEY,
                        SP_GOOGLE_TOKEN_URL=self.base + "/token", SP_YT_API=self.base + "/yt", SP_YT_UPLOAD=self.base + "/upload")

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def write(self, rel, obj):
        with open(os.path.join(self.root, rel), "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False)

    def read(self, rel):
        with open(os.path.join(self.root, rel), encoding="utf-8") as f:
            return json.load(f)

    def run_script(self, name, inputs):
        ev = os.path.join(self.root, "event.json")
        with open(ev, "w") as f:
            json.dump({"inputs": inputs}, f)
        env = dict(self.env, GITHUB_EVENT_PATH=ev)
        p = subprocess.run([sys.executable, os.path.join(self.root, "scripts", name)], env=env,
                           capture_output=True, text=True, timeout=60)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assert_no_leak(p.stdout, p.stderr)
        return p

    def assert_no_leak(self, out, err):
        for line in out.splitlines():
            if line.startswith("::add-mask::"):
                continue
            for s in SECRETS:
                self.assertNotIn(s, line, f"secret printed on stdout: {line[:60]}")
        for s in SECRETS:
            self.assertNotIn(s, err, "secret printed on stderr")

    def mods(self):
        sys.path.insert(0, os.path.join(self.root, "scripts"))
        for m in ("yt_tokens", "fetch_stats", "publish"):
            sys.modules.pop(m, None)
        os.environ.update({k: v for k, v in self.env.items() if k.startswith(("YT_", "TOKEN_KEY", "SP_"))})
        return importlib.import_module("yt_tokens")

    def connect(self, code=GOOD_CODE, page="test-page", req="c1"):
        return self.run_script("yt_connect.py", {"code": code, "page": page, "req": req})


class TokenStore(Base):
    def test_roundtrip_and_aad(self):
        T = self.mods()
        iv, ct = T.encrypt(REFRESH, CH)
        self.assertNotIn(REFRESH, ct)
        self.assertEqual(T.decrypt({"iv": iv, "ct": ct, "channel_id": CH}), REFRESH)
        with self.assertRaises(T.StoreError):  # a ciphertext moved to another channel's entry is refused
            T.decrypt({"iv": iv, "ct": ct, "channel_id": CH_OTHER})
        os.environ["TOKEN_KEY"] = base64.b64encode(b"x" * 32).decode()
        with self.assertRaises(T.StoreError):
            T.decrypt({"iv": iv, "ct": ct, "channel_id": CH})
        os.environ["TOKEN_KEY"] = base64.b64encode(b"short").decode()
        with self.assertRaises(T.StoreError):
            T.encrypt("x", CH)
        os.environ["TOKEN_KEY"] = KEY


class Connect(Base):
    def test_success(self):
        p = self.connect()
        self.assertIn(f"::add-mask::{GOOD_CODE}", p.stdout)
        self.assertIn(f"::add-mask::{REFRESH}", p.stdout)
        self.assertIn(f"::add-mask::{ACCESS}", p.stdout)
        # the code was masked before any request was made
        self.assertLess(p.stdout.index(GOOD_CODE), p.stdout.index(REFRESH))
        res = self.read("config/yt_connect_last.json")
        self.assertTrue(res["ok"]); self.assertEqual(res["req"], "c1"); self.assertEqual(res["channel_id"], CH)
        self.assertFalse(res["mismatch"]); self.assertNotIn("missing_scopes", res)
        raw = open(os.path.join(self.root, "config/yt_tokens.enc.json")).read()
        for s in SECRETS:
            self.assertNotIn(s, raw)
        st = json.loads(raw)
        e = st["channels"][CH]
        self.assertEqual(e["page"], "test-page"); self.assertEqual(e["expected_channel_id"], CH); self.assertFalse(e["mismatch"])
        T = self.mods()
        self.assertEqual(T.decrypt(e), REFRESH)
        tokcall = [c for c in Google.calls if c[1] == "/token"][0][2].decode()
        self.assertIn("grant_type=authorization_code", tokcall)

    def test_mismatch_is_stored_and_flagged(self):
        self.connect(code="4/0OTHER-CODE", req="c2")
        res = self.read("config/yt_connect_last.json")
        self.assertTrue(res["ok"]); self.assertTrue(res["mismatch"]); self.assertEqual(res["channel_id"], CH_OTHER)
        e = self.read("config/yt_tokens.enc.json")["channels"][CH_OTHER]
        self.assertTrue(e["mismatch"]); self.assertEqual(e["expected_channel_id"], CH)
        T = self.mods()
        st = T.load()
        self.assertIsNone(T.entry_for_page(st, "test-page"))
        self.assertEqual(T.entry_for_page(st, "test-page", allow_mismatch=True)["channel_id"], CH_OTHER)

    def test_unknown_expected_channel_is_not_mismatch(self):
        self.connect(code="4/0OTHER-CODE", page="second", req="c3")
        self.assertFalse(self.read("config/yt_connect_last.json")["mismatch"])

    def test_failures_write_result_and_no_store(self):
        for code, err in (("4/0EXPIRED", "invalid_grant"), ("4/0NOREFRESH", "no_refresh_token"), ("4/0NOCHANNEL", "no_channel")):
            self.connect(code=code, req="x")
            res = self.read("config/yt_connect_last.json")
            self.assertFalse(res["ok"]); self.assertEqual(res["error"], err); self.assertTrue(res["error_fa"])
        self.assertFalse(os.path.exists(os.path.join(self.root, "config/yt_tokens.enc.json")))
        self.connect(page="no-such-page", req="y")
        self.assertEqual(self.read("config/yt_connect_last.json")["error"], "bad_input")
        self.connect(req="bad req!")
        self.assertEqual(self.read("config/yt_connect_last.json")["error"], "bad_input")

    def test_missing_secret(self):
        self.env["YT_CLIENT_SECRET"] = ""
        self.connect(req="z")
        res = self.read("config/yt_connect_last.json")
        self.assertEqual(res["error"], "setup")


class FetchStats(Base):
    def run_fetch(self):
        self.mods()
        fs = importlib.import_module("fetch_stats")
        fs.CONFIG_PATH = os.path.join(self.root, "config.json")
        fs.DATA_DIR = os.path.join(self.root, "data")
        fs.LATEST_PATH = os.path.join(fs.DATA_DIR, "latest.json")
        fs.HISTORY_PATH = os.path.join(fs.DATA_DIR, "history.json")
        fs.POSTS_HISTORY_PATH = os.path.join(fs.DATA_DIR, "posts_history.json")
        fs.COMMENTS_PATH = os.path.join(fs.DATA_DIR, "comments.json")
        fs.store_avatar = lambda pid, plat, src: (None, None, "test")
        public = []

        def fake_public(handle, prev):
            public.append(handle)
            out = fs.blank("youtube", handle, "https://www.youtube.com/" + handle)
            out.update({"ok": True, "followers": 1, "posts": 0, "source": "public", "channel_id": CH})
            return out
        fs.FETCHERS = dict(fs.FETCHERS, youtube=fake_public)
        from io import StringIO
        buf, old = StringIO(), sys.stdout
        sys.stdout = buf
        try:
            fs.main()
        finally:
            sys.stdout = old
        self.assert_no_leak(buf.getvalue(), "")
        return self.read("data/latest.json"), public

    def test_connected_channel_exact_stats_and_comments(self):
        self.connect()
        latest, public = self.run_fetch()
        y = latest["pages"]["test-page"]["platforms"]["youtube"]
        self.assertEqual(public, ["@second"])  # only the unconnected page used public pages
        self.assertEqual(y["oauth"], {"channel_id": CH, "status": "ok"})
        self.assertEqual(y["followers"], 37); self.assertFalse(y["followers_approx"])
        self.assertEqual(y["total_views"], 1234)
        self.assertEqual([p["id"] for p in y["recent"]], ["v3", "v2"])  # private upload not listed
        self.assertEqual(y["recent"][1]["views"], 101); self.assertEqual(y["recent"][1]["likes"], 7); self.assertEqual(y["recent"][1]["comments"], 1)
        c = self.read("data/comments.json")["channels"]["test-page/youtube"]
        self.assertEqual([t["id"] for t in c["threads"]], ["Ugx-new", "Ugx-old"])  # newest first
        self.assertEqual(c["threads"][0]["video_title"], "Video v3")
        self.assertEqual(c["threads"][1]["replies"][0]["text"], "ممنون")
        self.assertNotIn("second/youtube", self.read("data/comments.json")["channels"])

    def test_revoked_falls_back_to_public(self):
        self.connect()
        T = self.mods()
        st = T.load()
        iv, ct = T.encrypt(REVOKED, CH)
        st["channels"][CH].update(iv=iv, ct=ct)
        T.save(st, os.path.join(self.root, "config/yt_tokens.enc.json"))
        latest, public = self.run_fetch()
        y = latest["pages"]["test-page"]["platforms"]["youtube"]
        self.assertIn("@test", public)
        self.assertEqual(y["oauth"]["status"], "revoked"); self.assertEqual(y["source"], "public")

    def test_mismatch_not_used_for_stats(self):
        self.connect(code="4/0OTHER-CODE")
        latest, public = self.run_fetch()
        y = latest["pages"]["test-page"]["platforms"]["youtube"]
        self.assertIn("@test", public)
        self.assertEqual(y["oauth"], {"channel_id": CH_OTHER, "status": "mismatch"})


class Reply(Base):
    def test_reply_posts_and_records(self):
        self.connect()
        self.run_script("yt_reply.py", {"page": "test-page", "parent_id": "Ugx-new", "text": "ممنون از تو 🌟", "req": "r1"})
        post = [c for c in Google.calls if c[1] == "/yt/comments"][0]
        body = json.loads(post[2])
        self.assertEqual(body, {"snippet": {"parentId": "Ugx-new", "textOriginal": "ممنون از تو 🌟"}})
        it = self.read("config/yt_replies.json")["items"][-1]
        self.assertEqual(it["status"], "sent"); self.assertEqual(it["reply_id"], "Ugx-reply-1"); self.assertEqual(it["req"], "r1")
        self.run_script("yt_reply.py", {"page": "test-page", "parent_id": "Ugx-disabled", "text": "x", "req": "r2"})
        it = self.read("config/yt_replies.json")["items"][-1]
        self.assertEqual(it["status"], "failed"); self.assertEqual(it["error"], "commentsDisabled")

    def test_reply_without_connection(self):
        self.run_script("yt_reply.py", {"page": "second", "parent_id": "Ugx-new", "text": "hi", "req": "r3"})
        self.assertEqual(self.read("config/yt_replies.json")["items"][-1]["status"], "needs_setup")


class Publish(Base):
    def pub(self):
        self.mods()
        P = importlib.import_module("publish")
        f = os.path.join(self.root, "v.mp4")
        open(f, "wb").write(b"\0" * 1024)
        P.local_file = lambda job: f
        return P

    def test_publish_uses_store(self):
        self.connect()
        P = self.pub()
        self.assertFalse(any(k.startswith("YT_REFRESH_TOKEN") for k in os.environ))
        out = P.publish_youtube({"id": "j1", "title": "t", "media": {"type": "video/mp4", "path": "x.mp4"}}, "test-page")
        self.assertEqual(out["status"], "published"); self.assertEqual(out["remote_id"], "VIDEO123")
        tok = [c for c in Google.calls if c[1] == "/token"][-1][2].decode()
        self.assertIn("grant_type=refresh_token", tok)

    def test_publish_refuses_mismatch_and_unconnected(self):
        self.connect(code="4/0OTHER-CODE")
        P = self.pub()
        with self.assertRaises(P.NeedsSetup):
            P.publish_youtube({"id": "j2", "media": {"type": "video/mp4"}}, "test-page")
        with self.assertRaises(P.NeedsSetup):
            P.publish_youtube({"id": "j3", "media": {"type": "video/mp4"}}, "second")


class Workflows(unittest.TestCase):
    def test_workflow_files(self):
        import re
        for name, inputs in (("yt-connect.yml", ("code", "page", "req")), ("yt-reply.yml", ("page", "parent_id", "text", "req"))):
            s = open(os.path.join(REPO, ".github/workflows", name), encoding="utf-8").read()
            for i in inputs:
                self.assertRegex(s, rf"\n      {i}:\n")
            # inputs are read from the event file only: never interpolated into a run script or env
            self.assertNotRegex(s, r"\$\{\{\s*(github\.event\.)?inputs\.(code|text|parent_id)")
            self.assertIn("run-name:", s)
            self.assertIn("${{ inputs.req }}", s)
            self.assertIn("TOKEN_KEY: ${{ secrets.TOKEN_KEY }}", s)
        pub = open(os.path.join(REPO, ".github/workflows/publish.yml"), encoding="utf-8").read()
        self.assertNotIn("YT_REFRESH_TOKEN_", pub)
        self.assertIn("TOKEN_KEY: ${{ secrets.TOKEN_KEY }}", pub)
        ref = open(os.path.join(REPO, ".github/workflows/refresh.yml"), encoding="utf-8").read()
        self.assertIn("oauth.html", ref)
        self.assertTrue(re.search(r"pip install .*cryptography", ref))


if __name__ == "__main__":
    unittest.main(verbosity=2)
