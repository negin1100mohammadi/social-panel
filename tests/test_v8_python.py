"""v8 server-side tests: classifier rules, publish.py (manual targets, gallery move, capabilities), gallery_ingest.py
(download -> ffprobe/Pillow -> classify -> release upload -> ECIES inbox item). Local mocks only.
usage: NO_PROXY=127.0.0.1,localhost python3 tests/test_v8_python.py <media_dir>     (media: tests/make_media.py)"""
import base64
import http.server
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "scripts"))
import gallery_classify  # noqa: E402
import publish  # noqa: E402

MEDIA = sys.argv.pop(1) if len(sys.argv) > 1 else "/tmp/spmedia"


class Classifier(unittest.TestCase):
    def test_cases(self):
        for c in json.load(open(os.path.join(HERE, "classifier_cases.json"), encoding="utf-8")):
            got = gallery_classify.classify_upload(c["files"], bool(c.get("story")))
            self.assertEqual([[g["kind"], g["files"]] for g in got], c["want"], c["name"])
            for g in got:
                self.assertIn("→", g["rule"])
            if c.get("suggest"):
                self.assertEqual([g["suggest"] for g in got], c["suggest"], c["name"])


class Publish(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        os.makedirs(os.path.join(self.tmp, "config"))
        shutil.copy(os.path.join(ROOT, "config.json"), self.tmp)
        self.old = (publish.ROOT, publish.QUEUE, publish.GH_TOKEN, dict(os.environ))
        publish.ROOT, publish.QUEUE, publish.GH_TOKEN = self.tmp, os.path.join(self.tmp, "queue"), ""
        for k in list(os.environ):
            if k.startswith(("IG_", "TIKTOK_", "YT_", "TOKEN_KEY", "APARAT_")):
                del os.environ[k]

    def tearDown(self):
        publish.ROOT, publish.QUEUE, publish.GH_TOKEN = self.old[0], self.old[1], self.old[2]
        os.environ.clear(); os.environ.update(self.old[3])
        shutil.rmtree(self.tmp)

    def test_manual_targets_and_caps(self):
        os.makedirs(publish.QUEUE)
        job = {"id": "j1", "publish_at": "2026-01-01T00:00:00+03:30", "status": "pending", "title": "t", "caption": "",
               "targets": [{"page": "titan-station", "platform": "aparat", "manual": True}, {"page": "titan-station", "platform": "instagram", "manual": True}],
               "media": {"type": "video/mp4"}, "asset_url": "https://example.invalid/x.mp4", "results": {}}
        json.dump(job, open(os.path.join(publish.QUEUE, "j1.json"), "w"))
        os.environ.update({"YT_CLIENT_ID": "id", "YT_CLIENT_SECRET": "s", "TOKEN_KEY": "k", "TIKTOK_ACCESS_TOKEN_SHODE_DIGE": "t"})
        json.dump({"channels": {"UCa": {"page": "hamrah-seller", "mismatch": False}, "UCb": {"page": "titan-station", "mismatch": True}}},
                  open(os.path.join(self.tmp, "config", "yt_tokens.enc.json"), "w"))
        publish.main()
        out = json.load(open(os.path.join(publish.QUEUE, "j1.json")))
        self.assertEqual(out["status"], "needs_action")  # v10: an unresolved channel waits for the panel (no final status yet)
        self.assertEqual({r["status"] for r in out["results"].values()}, {"manual"})
        self.assertIn("وصل نبود", out["results"]["titan-station/aparat"]["reason"])
        caps = json.load(open(os.path.join(self.tmp, "config", "publish_caps.json"), encoding="utf-8"))
        ch = caps["channels"]
        self.assertEqual(len(ch), 20)
        self.assertTrue(ch["hamrah-seller/youtube"]["ready"])
        self.assertFalse(ch["titan-station/youtube"]["ready"])  # mismatched channel does not count
        self.assertTrue(ch["shode-dige/tiktok"]["ready"])
        self.assertFalse(ch["shode-dige/instagram"]["ready"])
        self.assertTrue(all(not v["ready"] for k, v in ch.items() if k.endswith("/aparat")))
        txt = open(os.path.join(self.tmp, "config", "publish_caps.json"), encoding="utf-8").read()
        for secret in ("\"id\"", "\"s\"", "\"k\""):
            self.assertNotIn(": " + secret, txt)
        mtime = os.path.getmtime(os.path.join(self.tmp, "config", "publish_caps.json"))
        publish.write_caps()  # unchanged -> not rewritten (no commit noise)
        self.assertEqual(mtime, os.path.getmtime(os.path.join(self.tmp, "config", "publish_caps.json")))

    def test_aggregate(self):
        t = [{"page": "a", "platform": "youtube"}, {"page": "a", "platform": "aparat"}]
        A = lambda y, a: publish.aggregate({"targets": t, "results": {"a/youtube": {"status": y}, "a/aparat": {"status": a}}})
        # v10: unresolved channels keep the job in needs_action; once all are resolved the status is final
        self.assertEqual(A("published", "manual"), "needs_action")
        self.assertEqual(A("needs_setup", "manual"), "needs_action")
        self.assertEqual(A("published", "failed"), "partial")
        self.assertEqual(A("published", "published"), "published")
        self.assertEqual(A("failed", "skipped"), "failed")
        self.assertEqual(A("retry", "published"), "pending")
        self.assertEqual(A("queued", "failed"), "pending")

    def test_gallery_move_and_branch_cleanup(self):
        calls = {"uploads": [], "patch": []}
        tree = [{"path": "gallery/g1-1.jpg", "type": "blob", "sha": "s1"}, {"path": "gallery/g1-2.jpg", "type": "blob", "sha": "s2"},
                {"path": "media/q1.mp4", "type": "blob", "sha": "s3"}]

        class Resp:
            def __init__(self, code, data=None):
                self.status_code, self._d, self.text = code, data, json.dumps(data)

            def json(self):
                return self._d

            def raise_for_status(self):
                if self.status_code >= 400:
                    raise RuntimeError(self.status_code)

        def fake_gh(method, p, **kw):
            if p.startswith("/git/ref/heads/"):
                return Resp(200, {"object": {"sha": "head1"}})
            if p.startswith("/git/commits/"):
                return Resp(200, {"tree": {"sha": "t1"}})
            if p.startswith("/git/trees/"):
                return Resp(200, {"tree": tree})
            if p == "/releases/tags/gallery":
                return Resp(200, {"id": 7, "assets": [{"name": "g1-2.jpg"}]})
            if p == "/git/trees":
                calls["tree"] = kw["json"]["tree"]; return Resp(201, {"sha": "t2"})
            if p == "/git/commits":
                return Resp(201, {"sha": "c2"})
            if method == "PATCH":
                calls["patch"].append(kw["json"]); return Resp(200, {})
            return Resp(404, {})

        def fake_post(url, params=None, **kw):
            calls["uploads"].append(params["name"]); return Resp(201, {"browser_download_url": "u"})

        def fake_dl(job, dest):
            open(dest, "wb").write(b"x")

        old = (publish.gh, publish.requests.post, publish.download_staged, publish.GH_TOKEN)
        publish.gh, publish.requests.post, publish.download_staged, publish.GH_TOKEN = fake_gh, fake_post, fake_dl, "tok"
        try:
            moved = publish.migrate_gallery()
            self.assertEqual(calls["uploads"], ["g1-1.jpg"])  # g1-2 already in the release
            self.assertEqual(moved, {"gallery/g1-1.jpg", "gallery/g1-2.jpg"})
            publish.rebuild_media_branch({"media/q1.mp4"}, moved)
            self.assertEqual([x["path"] for x in calls["tree"]], ["media/q1.mp4"])  # moved gallery files dropped, pending queue file kept
            calls["tree"] = None
            publish.rebuild_media_branch({"media/q1.mp4"}, {"gallery/g1-2.jpg"})  # g1-1 not moved -> kept
            self.assertEqual(sorted(x["path"] for x in calls["tree"]), ["gallery/g1-1.jpg", "media/q1.mp4"])
        finally:
            publish.gh, publish.requests.post, publish.download_staged, publish.GH_TOKEN = old

    def test_asset_fallback_to_blob(self):
        job = {"id": "jx", "asset_url": "http://127.0.0.1:9/none.mp4", "media": {"path": "gallery/a.mp4", "blob_sha": "abc"}}
        seen = []
        old = publish.download_staged
        publish.download_staged = lambda j, d: (seen.append(j["media"]["blob_sha"]), open(d, "wb").write(b"z"))
        try:
            p = publish.local_file(job)
            self.assertEqual(seen, ["abc"]); self.assertEqual(open(p, "rb").read(), b"z")
        finally:
            publish.download_staged = old


class Handler(http.server.BaseHTTPRequestHandler):
    state = {}

    def log_message(self, *a):
        pass

    def _send(self, code, obj=None, raw=None):
        body = raw if raw is not None else (json.dumps(obj).encode() if obj is not None else b"")
        self.send_response(code); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/media/"):
            f = os.path.join(MEDIA, self.path[7:])
            return self._send(200, raw=open(f, "rb").read()) if os.path.exists(f) else self._send(404, {})
        if self.path.endswith("/releases/tags/gallery"):
            return self._send(404, {"message": "Not Found"})
        self._send(404, {})

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        data = self.rfile.read(n)
        if self.path.endswith("/releases"):
            port = self.server.server_address[1]
            return self._send(201, {"id": 5, "upload_url": f"http://127.0.0.1:{port}/upload{{?name,label}}", "assets": []})
        if self.path.startswith("/upload"):
            name = self.path.split("name=")[1]
            Handler.state.setdefault("uploads", []).append((name, len(data), self.headers.get("Content-Type")))
            return self._send(201, {"browser_download_url": "https://github.com/o/r/releases/download/gallery/" + name})
        self._send(404, {})


class Ingest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
        cls.base = f"http://127.0.0.1:{cls.srv.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()

    def run_ingest(self, inputs, root, token="tok"):
        env = dict(os.environ, SP_INPUTS=json.dumps(inputs), SP_ROOT=root, GITHUB_TOKEN=token, SP_GH_API=self.base, NO_PROXY="127.0.0.1,localhost", no_proxy="127.0.0.1,localhost")
        env.pop("GITHUB_EVENT_PATH", None)
        return subprocess.run([sys.executable, os.path.join(ROOT, "scripts", "gallery_ingest.py")], env=env, capture_output=True, text=True, timeout=120)

    def make_root(self, with_pub=True):
        from cryptography.hazmat.primitives.asymmetric import ec
        root = tempfile.mkdtemp()
        shutil.copy(os.path.join(ROOT, "config.json"), root)
        os.makedirs(os.path.join(root, "config"))
        priv = ec.generate_private_key(ec.SECP256R1())
        n = priv.public_key().public_numbers()
        b = lambda i: base64.urlsafe_b64encode(i.to_bytes(32, "big")).rstrip(b"=").decode()
        if with_pub:
            json.dump({"v": 1, "kid": "k1", "jwk": {"kty": "EC", "crv": "P-256", "x": b(n.x), "y": b(n.y)}}, open(os.path.join(root, "config", "inbox_pub.json"), "w"))
        return root, priv

    def decrypt(self, priv, obj):
        from cryptography.hazmat.primitives import hashes
        from cryptography.hazmat.primitives.asymmetric import ec
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        from cryptography.hazmat.primitives.kdf.hkdf import HKDF
        ub = lambda s: base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))
        epk = ec.EllipticCurvePublicNumbers(int.from_bytes(ub(obj["epk"]["x"]), "big"), int.from_bytes(ub(obj["epk"]["y"]), "big"), ec.SECP256R1()).public_key()
        key = HKDF(algorithm=hashes.SHA256(), length=32, salt=None, info=b"sp-inbox-v1").derive(priv.exchange(ec.ECDH(), epk))
        return json.loads(AESGCM(key).decrypt(base64.b64decode(obj["iv"]), base64.b64decode(obj["ct"]), ("sp-inbox-v1|" + obj["id"]).encode()))

    def test_dry_run_classifies(self):
        root, _ = self.make_root(with_pub=False)
        want = {"v916_10.webm": "story", "v916_40.webm": "reel", "vH_20.webm": "video", "v916_120.webm": "video", "img45.jpg": "slide", "img916.jpg": "story", "img11.png": "slide"}
        for f, kind in want.items():
            r = self.run_ingest({"url": f"{self.base}/media/{f}", "domain": "titan-station", "dry_run": "true"}, root)
            self.assertEqual(r.returncode, 0, r.stderr)
            out = json.loads(r.stdout.strip().splitlines()[-1])
            self.assertEqual(out["kind"], kind, f)
            self.assertTrue(out["thumb"], f)
        r = self.run_ingest({"url": f"{self.base}/media/v916_40.webm", "domain": "titan-station", "story": "true", "dry_run": "true"}, root)
        self.assertEqual(json.loads(r.stdout.strip().splitlines()[-1])["kind"], "story")
        self.assertFalse(os.path.exists(os.path.join(root, "inbox")))

    def test_errors(self):
        root, _ = self.make_root()
        r = self.run_ingest({"url": f"{self.base}/media/img45.jpg", "domain": "nope"}, root)
        self.assertEqual(r.returncode, 1); self.assertIn("unknown domain", r.stdout)
        r = self.run_ingest({"url": f"{self.base}/media/missing.jpg", "domain": "titan-station"}, root)
        self.assertEqual(r.returncode, 1); self.assertIn("download HTTP 404", r.stdout)
        root2, _ = self.make_root(with_pub=False)
        r = self.run_ingest({"url": f"{self.base}/media/img45.jpg", "domain": "titan-station"}, root2)
        self.assertEqual(r.returncode, 1); self.assertIn("inbox_pub.json missing", r.stdout)

    def test_full_ingest_encrypted_inbox(self):
        root, priv = self.make_root()
        Handler.state.clear()
        r = self.run_ingest({"url": f"{self.base}/media/v916_10.webm", "domain": "shode-dige", "title": "کلیپ بیرونی", "brain_id": "b1", "req": "r1"}, root)
        self.assertEqual(r.returncode, 0, r.stderr + r.stdout)
        files = os.listdir(os.path.join(root, "inbox"))
        self.assertEqual(len(files), 1)
        raw = open(os.path.join(root, "inbox", files[0]), encoding="utf-8").read()
        self.assertNotIn("کلیپ", raw); self.assertNotIn("shode", raw); self.assertNotIn("media/v916", raw)
        item = self.decrypt(priv, json.loads(raw))
        self.assertEqual(item["page"], "shode-dige"); self.assertEqual(item["kind"], "story"); self.assertEqual(item["title"], "کلیپ بیرونی")
        self.assertEqual(item["brain_id"], "b1"); self.assertTrue(item["thumb"].startswith("data:image/jpeg;base64,"))
        m = item["media"][0]
        self.assertEqual((m["w"], m["h"]), (180, 320)); self.assertAlmostEqual(m["dur"], 10, delta=0.5)
        self.assertEqual(Handler.state["uploads"][0][0], m["name"]); self.assertEqual(Handler.state["uploads"][0][2], "video/webm")
        self.assertTrue(m["url"].endswith("/releases/download/gallery/" + m["name"]))


if __name__ == "__main__":
    unittest.main(verbosity=1)
