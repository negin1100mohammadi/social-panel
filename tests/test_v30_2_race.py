"""v30.2 publish race guard (incident 2026-11-21: three «تلاش دوباره» presses within 20 s -> Instagram posted twice,
YouTube/TikTok results lost). Real git: a bare "origin" and two runner clones; local Buffer mock; no network.
usage: NO_PROXY=127.0.0.1 python3 tests/test_v30_2_race.py"""
import http.server
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from datetime import timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "scripts"))
import publish  # noqa: E402

CALLS = []


def sh(cwd, *a):
    return subprocess.run(["git", "-C", cwd, *a], check=True, capture_output=True, text=True).stdout.strip()


class Buffer(http.server.BaseHTTPRequestHandler):
    existing = []  # posts the "posts" query returns
    def log_message(self, *a): pass
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        q = body["query"]
        CALLS.append(q)
        if "createPost" in q:
            out = {"data": {"createPost": {"post": {"id": "new1", "status": "sent", "externalLink": "https://www.instagram.com/reel/NEW"}}}}
        elif "organizations" in q:
            out = {"data": {"account": {"organizations": [{"id": "org1"}]}}}
        elif "posts(" in q:
            sts = body["variables"].get("s") or []
            out = {"data": {"posts": {"edges": [{"node": p} for p in Buffer.existing if p["status"] in sts]}}}
        else:
            out = {"data": {"post": {"id": body["variables"]["id"], "status": "sent", "externalLink": "https://www.instagram.com/reel/OLD"}}}
        b = json.dumps(out).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)


JOB = {"id": "j1", "created_at": "2026-11-15T23:17:00+03:30", "publish_at": "2026-11-15T23:17:00+03:30", "status": "pending",
       "title": "t", "caption": "کپشن", "media": {"type": "video/mp4"}, "asset_url": "https://example.invalid/x.mp4",
       "targets": [{"page": "titan-station", "platform": "instagram"}, {"page": "titan-station", "platform": "youtube"},
                   {"page": "titan-station", "platform": "tiktok"}],
       "results": {"titan-station/instagram": {"status": "queued", "attempts": 0},
                   "titan-station/youtube": {"status": "needs_setup", "reason": "x"},
                   "titan-station/tiktok": {"status": "needs_setup", "reason": "x"}}}


class Race(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = http.server.HTTPServer(("127.0.0.1", 0), Buffer)
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()

    def setUp(self):
        CALLS.clear(); Buffer.existing = []
        self.tmp = tempfile.mkdtemp()
        self.origin = os.path.join(self.tmp, "origin.git")
        subprocess.run(["git", "init", "-q", "--bare", "-b", "main", self.origin], check=True)
        seed = os.path.join(self.tmp, "seed")
        subprocess.run(["git", "clone", "-q", self.origin, seed], check=True, capture_output=True)
        for d in ("queue", "data", "config"):
            os.makedirs(os.path.join(seed, d))
        shutil.copy(os.path.join(ROOT, "config.json"), seed)
        json.dump({"pages": {"titan-station": {"status": "ok", "channels": [
            {"id": "chIG", "name": "titanstation", "service": "instagram"}, {"id": "chTT", "name": "titan_station", "service": "tiktok"}]}}},
            open(os.path.join(seed, "data", "buffer.json"), "w"))
        self.put(seed, JOB, "seed")
        sh(seed, "push", "-q", "origin", "HEAD:main")
        self.seed = seed
        self.a, self.b = self.clone("a"), self.clone("b")
        self.saved = (publish.ROOT, publish.QUEUE, publish.GH_TOKEN, publish.BUFFER_API, publish._CFG, publish.GIT_SYNC, publish.RUN_ID,
                      dict(publish.PUBLISHERS), publish.run_active, publish.write_job, dict(os.environ))
        publish.GH_TOKEN, publish.GIT_SYNC = "", True
        publish.BUFFER_API = "http://127.0.0.1:%d/" % self.srv.server_address[1]
        for k in list(os.environ):
            if k.startswith(("IG_", "TIKTOK_", "YT_", "TOKEN_KEY", "APARAT_", "BUFFER_")):
                del os.environ[k]
        os.environ.update({"SP_BUFFER_WAIT": "0", "SP_BUFFER_POLLS": "2", "BUFFER_KEY_TITAN_STATION": "k"})
        self.published = []

        def fake(platform):
            def run(job, page):
                self.published.append((publish.RUN_ID, platform))
                return {"status": "published", "url": f"https://x/{platform}/{len(self.published)}", "remote_id": f"r{len(self.published)}"}
            return run
        for p in ("youtube", "tiktok", "aparat"):
            publish.PUBLISHERS[p] = fake(p)

    def tearDown(self):
        (publish.ROOT, publish.QUEUE, publish.GH_TOKEN, publish.BUFFER_API, publish._CFG, publish.GIT_SYNC, publish.RUN_ID,
         pubs, publish.run_active, publish.write_job, env) = self.saved
        publish.PUBLISHERS.clear(); publish.PUBLISHERS.update(pubs)
        os.environ.clear(); os.environ.update(env)
        shutil.rmtree(self.tmp)

    # helpers
    def clone(self, name):
        d = os.path.join(self.tmp, name)
        subprocess.run(["git", "clone", "-q", self.origin, d], check=True, capture_output=True)
        sh(d, "config", "user.name", "t"); sh(d, "config", "user.email", "t@t")
        return d

    def put(self, repo, job, msg):
        sh(repo, "config", "user.name", "t"); sh(repo, "config", "user.email", "t@t")
        json.dump(job, open(os.path.join(repo, "queue", "j1.json"), "w"), ensure_ascii=False, indent=1)
        sh(repo, "add", "-A"); sh(repo, "commit", "-q", "-m", msg)

    def panel_retry(self, keys):
        """The panel: requeue targets on the newest main (one commit)."""
        sh(self.seed, "pull", "-q", "--rebase", "origin", "main")
        j = json.load(open(os.path.join(self.seed, "queue", "j1.json")))
        for k in keys:
            j["results"][k] = {"status": "queued", "attempts": 0}
        j["status"] = "pending"
        self.put(self.seed, j, "retry"); sh(self.seed, "push", "-q", "origin", "HEAD:main")

    def run_in(self, repo, run_id):
        publish.ROOT, publish.QUEUE, publish._CFG, publish.RUN_ID = repo, os.path.join(repo, "queue"), None, run_id
        try:
            publish.main()
        except SystemExit:
            pass

    def origin_job(self):
        sh(self.seed, "pull", "-q", "--rebase", "origin", "main")
        return json.load(open(os.path.join(self.seed, "queue", "j1.json"), encoding="utf-8"))

    # tests
    def test_incident_replay_stale_checkout_does_not_double_post(self):
        # run 1 (clone a) publishes Instagram; the panel then requeues YouTube + TikTok
        self.run_in(self.a, "101")
        self.assertEqual(sum("createPost" in q for q in CALLS), 1)
        self.panel_retry(["titan-station/youtube", "titan-station/tiktok"])
        # run 2 starts from a STALE checkout (Instagram still "queued" there), like actions/checkout of the old SHA
        stale = sh(self.b, "rev-parse", "HEAD")
        self.assertEqual(json.load(open(os.path.join(self.b, "queue", "j1.json")))["results"]["titan-station/instagram"]["status"], "queued")
        self.run_in(self.b, "102")
        self.assertNotEqual(sh(self.b, "rev-parse", "HEAD"), stale)
        self.assertEqual(sum("createPost" in q for q in CALLS), 1, "Instagram must not be posted a second time")
        self.assertEqual(sorted(p for _, p in self.published), ["tiktok", "youtube"])
        j = self.origin_job()
        r = j["results"]
        self.assertEqual([r[k]["status"] for k in ("titan-station/instagram", "titan-station/youtube", "titan-station/tiktok")], ["published"] * 3)
        self.assertEqual((r["titan-station/youtube"]["url"], r["titan-station/youtube"]["run_id"]), ("https://x/youtube/1", "102"))
        self.assertEqual(j["status"], "published")
        # a third run has nothing to do
        self.run_in(self.a, "103")
        self.assertEqual(len(self.published), 2); self.assertEqual(sum("createPost" in q for q in CALLS), 1)

    def test_live_lock_of_another_run_is_respected(self):
        j = json.loads(json.dumps(JOB))
        j["results"]["titan-station/instagram"] = {"status": "publishing", "run_id": "900", "started_at": publish.iso_tehran()}
        self.put(self.seed, j, "lock"); sh(self.seed, "push", "-q", "origin", "HEAD:main")
        publish.run_active = lambda rid: True
        self.run_in(self.b, "200")
        self.assertFalse([q for q in CALLS if "createPost" in q])
        self.assertEqual(self.origin_job()["results"]["titan-station/instagram"]["run_id"], "900")

    def test_stale_lock_becomes_manual_never_republished(self):
        j = json.loads(json.dumps(JOB))
        old = (publish.now() - timedelta(minutes=publish.LOCK_STALE_MIN + 5)).astimezone(publish.TEHRAN).isoformat()
        j["results"]["titan-station/instagram"] = {"status": "publishing", "run_id": "901", "started_at": old}
        self.put(self.seed, j, "lock"); sh(self.seed, "push", "-q", "origin", "HEAD:main")
        self.run_in(self.b, "201")
        self.assertFalse([q for q in CALLS if "createPost" in q])
        r = self.origin_job()["results"]["titan-station/instagram"]
        self.assertEqual((r["status"], r["stale_run_id"]), ("manual", "901"))
        # finished holder run (not old) is also treated as stale
        j["results"]["titan-station/instagram"] = {"status": "publishing", "run_id": "902", "started_at": publish.iso_tehran()}
        self.put(self.seed, j, "lock2"); sh(self.seed, "push", "-q", "origin", "HEAD:main")
        publish.run_active = lambda rid: False
        self.run_in(self.b, "202")
        self.assertEqual(self.origin_job()["results"]["titan-station/instagram"]["status"], "manual")
        self.assertFalse([q for q in CALLS if "createPost" in q])

    def test_lock_push_conflict_rereads_and_backs_off(self):
        # between run b's read and its lock push, run a's lock lands on main -> b's push is rejected, b re-reads, sees a live lock, skips
        publish.run_active = lambda rid: True
        orig = publish.write_job
        state = {"done": False}

        def racing_write(job):
            if not state["done"] and publish.RUN_ID == "301":
                state["done"] = True
                j = json.loads(json.dumps(JOB))
                j["results"]["titan-station/instagram"] = {"status": "publishing", "run_id": "300", "started_at": publish.iso_tehran()}
                self.put(self.a, j, "a lock"); sh(self.a, "push", "-q", "origin", "HEAD:main")
            orig(job)
        publish.write_job = racing_write
        self.run_in(self.b, "301")
        self.assertTrue(state["done"])
        self.assertFalse([q for q in CALLS if "createPost" in q], "b must not publish after losing the lock race")
        self.assertEqual(self.origin_job()["results"]["titan-station/instagram"]["run_id"], "300")

    def test_buffer_dedupe(self):
        # an earlier Buffer post id on the target: followed, never a second createPost
        j = json.loads(json.dumps(JOB))
        j["results"]["titan-station/instagram"] = {"status": "retry", "attempts": 1, "remote_id": "bp-old", "via": "buffer"}
        self.put(self.seed, j, "retry with id"); sh(self.seed, "push", "-q", "origin", "HEAD:main")
        self.run_in(self.b, "401")
        self.assertFalse([q for q in CALLS if "createPost" in q])
        r = self.origin_job()["results"]["titan-station/instagram"]
        self.assertEqual((r["status"], r["remote_id"], r["url"]), ("published", "bp-old", "https://www.instagram.com/reel/OLD"))
        # same text already sent on the channel since the job was made: adopted
        CALLS.clear()
        Buffer.existing = [{"id": "bp-same", "text": "کپشن ", "status": "sent", "dueAt": "2026-11-21T16:33:00+03:30", "channelId": "chIG",
                            "externalLink": "https://www.instagram.com/reel/SAME"},
                           {"id": "bp-other", "text": "کپشن", "status": "sent", "dueAt": "2026-11-21T16:33:00+03:30", "channelId": "chTT"}]
        j["results"]["titan-station/instagram"] = {"status": "queued", "attempts": 0}
        self.put(self.seed, j, "retry again"); sh(self.seed, "push", "-q", "origin", "HEAD:main")
        self.run_in(self.a, "402")
        self.assertFalse([q for q in CALLS if "createPost" in q])
        r = self.origin_job()["results"]["titan-station/instagram"]
        self.assertEqual((r["status"], r["remote_id"]), ("published", "bp-same"))
        self.assertIn("ساخته نشد", r["reason"])


class YT(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        if self.path.startswith("/channels"):
            out = {"items": [{"contentDetails": {"relatedPlaylists": {"uploads": "UU1"}}}]}
        else:
            out = {"items": [{"snippet": {"title": "جهان به هیچ نمی‌ارزد", "publishedAt": "2026-11-21T13:06:00Z", "resourceId": {"videoId": "cqj5Rt7m9I0"}}},
                             {"snippet": {"title": "old", "publishedAt": "2026-11-01T10:00:00Z", "resourceId": {"videoId": "o1"}}}]}
        b = json.dumps(out).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)


class YouTubeDedupe(unittest.TestCase):
    def test_same_title_since_job_is_adopted(self):
        srv = http.server.HTTPServer(("127.0.0.1", 0), YT)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        os.environ["SP_YT_API"] = "http://127.0.0.1:%d" % srv.server_address[1]
        try:
            job = {"title": "جهان به هیچ نمی‌ارزد", "created_at": "2026-11-15T23:17:00+03:30"}
            r = publish.youtube_existing("tok", job)
            self.assertEqual((r["status"], r["remote_id"]), ("published", "cqj5Rt7m9I0"))
            self.assertIsNone(publish.youtube_existing("tok", {"title": "جهان به هیچ نمی‌ارزد", "created_at": "2026-11-22T00:00:00+03:30"}))
            self.assertIsNone(publish.youtube_existing("tok", {"title": "دیگری", "created_at": "2026-11-15T23:17:00+03:30"}))
        finally:
            os.environ.pop("SP_YT_API", None); srv.shutdown()


if __name__ == "__main__":
    unittest.main()
