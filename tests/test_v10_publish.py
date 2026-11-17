"""v10 publish.py tests: Buffer route (Instagram/TikTok), automatic retries (max 3 -> failed), «manual» targets that got
connected, final job statuses, YouTube via the OAuth store only. Local mocks only (no network).
usage: python3 tests/test_v10_publish.py"""
import http.server
import json
import os
import shutil
import sys
import tempfile
import threading
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "scripts"))
import publish  # noqa: E402

CALLS = []


class Buffer(http.server.BaseHTTPRequestHandler):
    mode = "ok"
    def log_message(self, *a): pass
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        CALLS.append({"auth": self.headers.get("Authorization"), "body": body})
        q = body["query"]
        if Buffer.mode == "autherr":
            out = {"errors": [{"message": "Unauthorized"}]}
            code = 401
        elif "createPost" in q:
            out = {"data": {"createPost": {"post": {"id": "bp1", "status": "sending", "dueAt": None, "externalLink": None}}}}
            code = 200
        else:
            out = {"data": {"post": {"id": "bp1", "status": "sent", "externalLink": "https://www.instagram.com/reel/abc"}}}
            code = 200
        b = json.dumps(out).encode()
        self.send_response(code); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)


class V10(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = http.server.HTTPServer(("127.0.0.1", 0), Buffer)
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()

    def setUp(self):
        CALLS.clear(); Buffer.mode = "ok"
        self.tmp = tempfile.mkdtemp()
        os.makedirs(os.path.join(self.tmp, "config")); os.makedirs(os.path.join(self.tmp, "data"))
        shutil.copy(os.path.join(ROOT, "config.json"), self.tmp)
        json.dump({"pages": {"titan-station": {"status": "ok", "channels": [
            {"id": "chIG", "name": "titanstation", "service": "instagram", "isQueuePaused": False},
            {"id": "chTT", "name": "titan_station", "service": "tiktok", "isQueuePaused": False}]},
            "shode-dige": {"status": "ok", "channels": [{"id": "chX", "name": "someone.else", "service": "instagram"}]},
            "hamrah-seller": {"status": "error", "error": "x"}}}, open(os.path.join(self.tmp, "data", "buffer.json"), "w"))
        self.old = (publish.ROOT, publish.QUEUE, publish.GH_TOKEN, publish.BUFFER_API, publish._CFG, dict(os.environ))
        publish.ROOT, publish.QUEUE, publish.GH_TOKEN, publish._CFG = self.tmp, os.path.join(self.tmp, "queue"), "", None
        publish.BUFFER_API = "http://127.0.0.1:%d/" % self.srv.server_address[1]
        os.makedirs(publish.QUEUE)
        for k in list(os.environ):
            if k.startswith(("IG_", "TIKTOK_", "YT_", "TOKEN_KEY", "APARAT_", "BUFFER_")):
                del os.environ[k]
        os.environ.update({"SP_BUFFER_WAIT": "0", "SP_BUFFER_POLLS": "3"})

    def tearDown(self):
        publish.ROOT, publish.QUEUE, publish.GH_TOKEN, publish.BUFFER_API, publish._CFG = self.old[:5]
        os.environ.clear(); os.environ.update(self.old[5])
        shutil.rmtree(self.tmp)

    def job(self, targets, **kw):
        j = {"id": "j1", "publish_at": "2026-01-01T00:00:00+03:30", "status": "pending", "title": "t", "caption": "کپشن",
             "targets": targets, "media": {"type": "video/mp4"}, "asset_url": "https://example.invalid/x.mp4", "results": {}}
        j.update(kw)
        json.dump(j, open(os.path.join(publish.QUEUE, "j1.json"), "w"))

    def run_once(self):
        publish.main()
        return json.load(open(os.path.join(publish.QUEUE, "j1.json"), encoding="utf-8"))

    def test_buffer_route_instagram_tiktok(self):
        os.environ["BUFFER_KEY_TITAN_STATION"] = "bufkey"
        self.job([{"page": "titan-station", "platform": "instagram", "manual": True}, {"page": "titan-station", "platform": "tiktok"}])
        out = self.run_once()
        ig, tt = out["results"]["titan-station/instagram"], out["results"]["titan-station/tiktok"]
        self.assertEqual((ig["status"], ig["via"], ig["url"]), ("published", "buffer", "https://www.instagram.com/reel/abc"))
        self.assertEqual(tt["status"], "published")
        self.assertEqual(out["status"], "published")
        creates = [c for c in CALLS if "createPost" in c["body"]["query"]]
        self.assertEqual(len(creates), 2)
        inp = creates[0]["body"]["variables"]["input"]
        self.assertEqual((inp["channelId"], inp["mode"], inp["assets"][0]["video"]["url"]), ("chIG", "shareNow", "https://example.invalid/x.mp4"))
        self.assertEqual(inp["metadata"]["instagram"]["type"], "reel")
        self.assertEqual(creates[0]["auth"], "Bearer bufkey")
        self.assertNotIn("metadata", creates[1]["body"]["variables"]["input"])
        caps = json.load(open(os.path.join(self.tmp, "config", "publish_caps.json"), encoding="utf-8"))["channels"]
        self.assertTrue(caps["titan-station/instagram"]["ready"]); self.assertEqual(caps["titan-station/instagram"]["via"], "buffer")
        self.assertFalse(caps["hamrah-seller/instagram"]["ready"])
        self.assertNotIn("bufkey", open(os.path.join(self.tmp, "config", "publish_caps.json"), encoding="utf-8").read())

    def test_buffer_safety(self):
        os.environ["BUFFER_KEY_SHODE_DIGE"] = "k2"
        self.job([{"page": "shode-dige", "platform": "instagram"}])
        out = self.run_once()
        r = out["results"]["shode-dige/instagram"]
        self.assertEqual(r["status"], "needs_setup"); self.assertIn("یکی نیست", r["reason"])
        self.assertEqual(out["status"], "needs_action"); self.assertFalse(CALLS)
        # channel in Buffer but no key reaches the script
        self.job([{"page": "titan-station", "platform": "tiktok"}])
        r = self.run_once()["results"]["titan-station/tiktok"]
        self.assertEqual(r["status"], "needs_setup"); self.assertIn("BUFFER_KEY_TITAN_STATION", r["reason"])
        # a non-ASCII key (the latin-1 error in buffer.json) gets a clear reason
        os.environ["BUFFER_KEY_TITAN_STATION"] = "کلید"
        self.job([{"page": "titan-station", "platform": "tiktok"}])
        self.assertIn("غیرلاتین", self.run_once()["results"]["titan-station/tiktok"]["reason"])
        # an image is skipped on TikTok
        os.environ["BUFFER_KEY_TITAN_STATION"] = "ok"
        self.job([{"page": "titan-station", "platform": "tiktok"}], media={"type": "image/jpeg"})
        self.assertEqual(self.run_once()["results"]["titan-station/tiktok"]["status"], "skipped")

    def test_retries_then_failed(self):
        os.environ["IG_ACCESS_TOKEN_PRETIME_TV"] = "x"; os.environ["IG_USER_ID_PRETIME_TV"] = "1"
        def boom(job, page): raise RuntimeError("شبکه قطع بود")
        old = publish.PUBLISHERS["instagram"]; publish.PUBLISHERS["instagram"] = boom
        try:
            self.job([{"page": "pretime-tv", "platform": "instagram"}])
            o1 = self.run_once(); r1 = o1["results"]["pretime-tv/instagram"]
            self.assertEqual((r1["status"], r1["attempts"], o1["status"]), ("retry", 1, "pending"))
            o2 = self.run_once(); self.assertEqual(o2["results"]["pretime-tv/instagram"]["attempts"], 2)
            o3 = self.run_once(); r3 = o3["results"]["pretime-tv/instagram"]
            self.assertEqual((r3["status"], r3["attempts"], o3["status"]), ("failed", 3, "failed"))
            self.assertIn("بعد از 3 تلاش", r3["reason"]); self.assertIn("شبکه قطع بود", r3["reason"])
            o4 = self.run_once(); self.assertEqual(o4["results"]["pretime-tv/instagram"]["attempts"], 3)  # final: not attempted again
            # the panel's «تلاش دوباره»: status queued, attempts 0, job pending -> 3 more automatic attempts
            o4["results"]["pretime-tv/instagram"] = {"status": "queued", "attempts": 0, "retry_requested_at": "2026-11-17T11:00:00+03:30"}
            o4["status"] = "pending"; json.dump(o4, open(os.path.join(publish.QUEUE, "j1.json"), "w"))
            o5 = self.run_once(); r5 = o5["results"]["pretime-tv/instagram"]
            self.assertEqual((r5["status"], r5["attempts"]), ("retry", 1)); self.assertEqual(r5["retry_requested_at"], "2026-11-17T11:00:00+03:30")
        finally:
            publish.PUBLISHERS["instagram"] = old

    def test_youtube_reason_and_no_legacy_secret(self):
        os.environ.update({"YT_CLIENT_ID": "id", "YT_CLIENT_SECRET": "s", "YT_REFRESH_TOKEN_PRETIME_TV": "legacy"})
        json.dump({"channels": {}}, open(os.path.join(self.tmp, "config", "yt_tokens.enc.json"), "w"))
        self.job([{"page": "pretime-tv", "platform": "youtube"}, {"page": "pretime-tv", "platform": "aparat"}])
        out = self.run_once()
        r = out["results"]["pretime-tv/youtube"]
        self.assertEqual(r["status"], "needs_setup")
        self.assertNotIn("YT_REFRESH_TOKEN", r["reason"])
        self.assertTrue("TOKEN_KEY" in r["reason"] or "اتصال" in r["reason"], r["reason"])
        self.assertEqual(out["status"], "needs_action")

    def test_needs_action_resolved_by_panel(self):
        t = [{"page": "a", "platform": "youtube"}, {"page": "a", "platform": "aparat"}]
        res = {"a/youtube": {"status": "published"}, "a/aparat": {"status": "published", "manual": True}}
        self.assertEqual(publish.aggregate({"targets": t, "results": res}), "published")
        res["a/aparat"] = {"status": "failed", "resolved_by": "panel", "reason": "لغو شد"}
        self.assertEqual(publish.aggregate({"targets": t, "results": res}), "partial")


class BufferData(unittest.TestCase):
    def test_clean_key_and_history(self):
        import buffer_sync
        import fetch_stats
        self.assertEqual(buffer_sync.clean_key(" \u2022abc\u200bdef\u00a0 "), ("abcdef", 2))
        tmp = tempfile.mkdtemp()
        try:
            path = os.path.join(tmp, "buffer.json")
            buf = {"updated": "2026-11-17T08:03:00+03:30", "pages": {"titan-station": {"status": "ok", "channels": [{"id": "c1", "service": "instagram"}],
                   "posts": [{"id": "p1", "text": "عنوان\nبدنه", "dueAt": "2026-11-14T13:23:00Z", "channelId": "c1", "metricsUpdatedAt": "2026-11-16T17:21:00+03:30",
                              "metrics": [{"type": "views", "value": 1943}, {"type": "reactions", "value": 33}, {"type": "comments", "value": 0}, {"type": "reach", "value": 1810}]}]},
                   "pretime-tv": {"status": "no_key"}}}
            json.dump(buf, open(path, "w"))
            from datetime import datetime, timezone
            ph = {"channels": {}}
            fetch_stats.merge_buffer_history(ph, datetime.now(timezone.utc), path)
            fetch_stats.merge_buffer_history(ph, datetime.now(timezone.utc), path)  # same snapshot again: no new row
            ch = ph["channels"]["titan-station/instagram@buffer"]
            e = ch["posts"]["p1"]
            self.assertEqual((len(ch["runs"]), len(e["s"]), e["s"][0][1:], e["title"]), (1, 1, [1943, 33, 0], "عنوان"))
            buf["updated"] = "2026-11-17T11:03:00+03:30"
            buf["pages"]["titan-station"]["posts"][0]["metricsUpdatedAt"] = "2026-11-17T10:00:00+03:30"
            buf["pages"]["titan-station"]["posts"][0]["metrics"][0]["value"] = 2100
            json.dump(buf, open(path, "w"))
            fetch_stats.merge_buffer_history(ph, datetime.now(timezone.utc), path)
            self.assertEqual([r[1] for r in e["s"]], [1943, 2100])
            self.assertEqual(len(ch["runs"]), 2)
            self.assertEqual(e["x"][-1][1], 1810)
        finally:
            shutil.rmtree(tmp)


if __name__ == "__main__":
    unittest.main()
