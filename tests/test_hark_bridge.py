"""Unit tests for the Hark <-> panel bridge crypto (test keys only).

usage: python3 tests/test_hark_bridge.py      (bridge path: $HARK_BRIDGE, default /workspace/work/hark_bridge.py)
The browser side of both directions is covered end to end in tests/v9.test.js.
"""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest

BRIDGE = os.environ.get("HARK_BRIDGE", "/workspace/work/hark_bridge.py")
spec = importlib.util.spec_from_file_location("hark_bridge", BRIDGE)
hb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hb)
from cryptography.hazmat.primitives.asymmetric import ec  # noqa: E402


def keypair(kid):
    k = ec.generate_private_key(ec.SECP256R1()); n = k.private_numbers(); p = n.public_numbers
    b = lambda i: hb.b64u(i.to_bytes(32, "big"))  # noqa: E731
    pub = {"kty": "EC", "crv": "P-256", "x": b(p.x), "y": b(p.y)}
    return {"v": 1, "kid": kid, "jwk": pub}, {"v": 1, "kid": kid, "jwk": dict(pub, d=b(n.private_value))}


class Bridge(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.harkpub, self.harkpriv = keypair("hk")
        self.panpub, self.panpriv = keypair("pk")
        self.keyf = os.path.join(self.dir, "k.json"); json.dump(self.harkpriv, open(self.keyf, "w"))
        self.repo = os.path.join(self.dir, "repo"); os.makedirs(os.path.join(self.repo, "config"))
        json.dump(self.panpub, open(os.path.join(self.repo, "config/inbox_pub.json"), "w"))

    def run_b(self, *args, ok=True):
        r = subprocess.run([sys.executable, BRIDGE, "--local", self.repo, "--key", self.keyf, *args], capture_output=True, text=True)
        if ok: self.assertEqual(r.returncode, 0, r.stderr)
        else: self.assertNotEqual(r.returncode, 0)
        return r.stdout + r.stderr

    def put_request(self, rid, payload):
        env = hb.seal(self.harkpub, hb.REQ_INFO, hb.REQ_INFO + "|" + rid, payload, {"id": rid})
        os.makedirs(os.path.join(self.repo, "hark/requests"), exist_ok=True)
        json.dump(env, open(os.path.join(self.repo, "hark/requests/%s.json" % rid), "w"))
        return env

    def out_files(self, page):
        d = os.path.join(self.repo, "hark/out", page)
        return [os.path.join(d, f) for f in sorted(os.listdir(d))] if os.path.isdir(d) else []

    def test_roundtrip_and_aad(self):
        env = hb.seal(self.harkpub, hb.REQ_INFO, "sp-hark-req-v1|r1", {"a": "سلام"})
        priv = hb.priv_from_jwk(self.harkpriv["jwk"])
        self.assertEqual(hb.open_env(priv, hb.REQ_INFO, "sp-hark-req-v1|r1", env), {"a": "سلام"})
        with self.assertRaises(Exception): hb.open_env(priv, hb.REQ_INFO, "sp-hark-req-v1|r2", env)  # path-bound
        with self.assertRaises(Exception): hb.open_env(priv, hb.OUT_INFO, "sp-hark-req-v1|r1", env)  # direction-bound
        other = hb.priv_from_jwk(self.panpriv["jwk"])
        with self.assertRaises(Exception): hb.open_env(other, hb.REQ_INFO, "sp-hark-req-v1|r1", env)  # wrong key

    def test_list_and_tamper(self):
        self.put_request("r1", {"type": "screen", "id": "r1", "page": "titan-station", "screen_id": "s1", "title": "ایده", "body": "متن"})
        env = self.put_request("r2", {"type": "screen", "id": "r2", "page": "titan-station", "title": "x"})
        import base64
        ct = bytearray(base64.b64decode(env["ct"])); ct[0] ^= 1; env["ct"] = base64.b64encode(bytes(ct)).decode()
        json.dump(env, open(os.path.join(self.repo, "hark/requests/r2.json"), "w"))
        out = json.loads(self.run_b("list-requests", "--json"))
        self.assertEqual([r["id"] for r in out], ["r1"])
        self.assertIn("cannot decrypt", self.run_b("list-requests", "--all"))
        self.assertIn("ایده", self.run_b("list-requests"))

    def test_post_ideas_script_job_done(self):
        self.run_b("post-ideas", "titan-station", json.dumps([{"title": "ایده ۱", "body": "b"}]))
        f = self.out_files("titan-station"); self.assertEqual(len(f), 1)
        env = json.load(open(f[0])); oid = os.path.basename(f[0])[:-5]
        self.assertNotIn("ایده", open(f[0], encoding="utf-8").read())
        pan = hb.priv_from_jwk(self.panpriv["jwk"])
        m = hb.open_env(pan, hb.OUT_INFO, "sp-hark-out-v1|titan-station/" + oid, env)
        self.assertEqual((m["type"], m["ideas"][0]["title"], m["page"]), ("ideas", "ایده ۱", "titan-station"))
        with self.assertRaises(Exception): hb.open_env(pan, hb.OUT_INFO, "sp-hark-out-v1|pretime-tv/" + oid, env)
        self.run_b("post-ideas", "titan-station", json.dumps([{"body": "no title"}]), ok=False)
        self.run_b("post-ideas", "nope", json.dumps([{"title": "t"}]), ok=False)
        # script for a screen request
        self.put_request("r1", {"type": "screen", "id": "r1", "page": "titan-station", "screen_id": "s1"})
        self.put_request("j1", {"type": "produce", "id": "j1", "page": "titan-station", "final_id": "f1", "tool": "claude"})
        self.run_b("post-script", "r1", json.dumps({"hook": "h", "text": "t"}))
        self.run_b("post-script", "j1", json.dumps({"hook": "h"}), ok=False)
        self.run_b("post-job-result", "j1", json.dumps({"state": "done", "gallery_id": "g1", "gallery_kind": "reel"}))
        self.run_b("post-job-result", "j1", json.dumps({"state": "error"}), ok=False)
        self.run_b("post-job-result", "r1", json.dumps({"state": "done"}), ok=False)
        msgs = []
        for p in self.out_files("titan-station"):
            oid = os.path.basename(p)[:-5]
            msgs.append(hb.open_env(pan, hb.OUT_INFO, "sp-hark-out-v1|titan-station/" + oid, json.load(open(p))))
        kinds = sorted(m["type"] for m in msgs)
        self.assertEqual(kinds, ["ideas", "job_result", "script"])
        s = [m for m in msgs if m["type"] == "script"][0]; j = [m for m in msgs if m["type"] == "job_result"][0]
        self.assertEqual((s["screen_id"], s["request_id"]), ("s1", "r1"))
        self.assertEqual((j["final_id"], j["tool"], j["state"], j["gallery_id"]), ("f1", "claude", "done", "g1"))
        self.assertIn("removed", self.run_b("mark-done", "r1", "j1"))
        self.assertEqual(os.listdir(os.path.join(self.repo, "hark/requests")), [])


if __name__ == "__main__":
    unittest.main(verbosity=1)
