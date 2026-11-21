"""v29: each brand's own Gemini key goes first (GEMINI_KEY_<PAGE>), then the shared keys, then gpt-oss.
Offline: urllib is mocked, no key ever leaves the process.   python3 -m unittest tests.test_v29_brand_keys"""
import io
import json
import os
import sys
import unittest
import urllib.error
from contextlib import redirect_stdout
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "scripts"))
import screen as S  # noqa: E402
import voscript as V  # noqa: E402

SCRIPT = {"title": "t", "hook": "h", "beats": [{"t": "0:03", "text": "b"}], "cta": "c", "text": "x", "caption": "", "hashtags": [], "platforms": {}}
KEYS = {"brand": "k-brand-SECRET", "g1": "k-shared1-SECRET", "g2": "k-shared2-SECRET", "groq": "k-groq-SECRET"}


class Resp(io.BytesIO):
    status = 200
    def __enter__(self): return self
    def __exit__(self, *a): return False


def http_err(code, body=None, headers=None):
    return urllib.error.HTTPError("u", code, "x", headers or {}, io.BytesIO(json.dumps(body or {"error": {"status": str(code)}}).encode()))


class Fake:
    """behaviour per key: 'ok' | 'refuse' | '429' | '503' ; records (key-label, url) of every call"""
    def __init__(self, beh): self.beh = beh; self.calls = []
    def label(self, key): return next((k for k, v in KEYS.items() if v == key), "?")
    def __call__(self, req, timeout=None):
        h = {k.lower(): v for k, v in req.header_items()}
        key = h.get("x-goog-api-key") or (h.get("authorization") or "").replace("Bearer ", "")
        lab = self.label(key); url = req.full_url
        self.calls.append((lab, "list" if url.endswith("pageSize=200") else "gen"))
        if url.endswith("pageSize=200"):
            return Resp(json.dumps({"models": [{"name": "models/gemini-3.5-flash", "supportedGenerationMethods": ["generateContent"]}]}).encode())
        b = self.beh.get(lab, "ok")
        if b == "refuse": raise http_err(403)
        if b == "429": raise http_err(429, {"error": {"status": "RESOURCE_EXHAUSTED", "message": "Quota exceeded. Please retry in 7.5s."}})
        if b == "503": raise http_err(503)
        if "groq" in url:
            return Resp(json.dumps({"choices": [{"message": {"content": json.dumps(SCRIPT)}, "finish_reason": "stop"}]}).encode())
        return Resp(json.dumps({"candidates": [{"content": {"parts": [{"text": json.dumps(SCRIPT)}]}, "finishReason": "STOP"}]}).encode())


ENV = {"GEMINI_KEY_TITAN_STATION": KEYS["brand"], "GEMINI_API_KEY": KEYS["g1"], "GEMINI_API_KEY_2": KEYS["g2"], "GROQ_API_KEY": KEYS["groq"],
       "OPENROUTER_API_KEY": ""}


class BrandKeys(unittest.TestCase):
    def run_chain(self, beh, page="titan-station", env=None):
        fake = Fake(beh); out = io.StringIO(); sleeps = []
        S._last_call.clear()
        with mock.patch.dict(os.environ, env or ENV, clear=False), mock.patch("urllib.request.urlopen", fake), \
                mock.patch("time.sleep", lambda s: sleeps.append(s)), redirect_stdout(out):
            try: res = S.call_model("p", page)
            except S.ModelError as e: res = e
        log = out.getvalue()
        for v in KEYS.values(): self.assertNotIn(v, log, "a key leaked into the log")
        return res, fake.calls, log, sleeps

    def test_env_name(self):
        self.assertEqual(S.brand_env("titan-station"), "GEMINI_KEY_TITAN_STATION")
        self.assertEqual(S.brand_env("fancatstic-four"), "GEMINI_KEY_FANCATSTIC_FOUR")
        self.assertEqual({S.brand_env(p) for p in S.PAGES}, {"GEMINI_KEY_TITAN_STATION", "GEMINI_KEY_SHODE_DIGE", "GEMINI_KEY_FANCATSTIC_FOUR",
                                                             "GEMINI_KEY_HAMRAH_SELLER", "GEMINI_KEY_PRETIME_TV"})

    def test_brand_key_first(self):
        (sc, prov, model), calls, log, _ = self.run_chain({})
        self.assertEqual(prov, "gemini-brand"); self.assertEqual(S.PROVIDER_FA[prov], "Gemini (کلید برند)")
        self.assertTrue(all(c[0] == "brand" for c in calls), calls)
        self.assertIn("providers: gemini-brand, gemini, gemini-2, groq", log)

    def test_other_brand_has_no_key_uses_shared(self):
        (sc, prov, model), calls, log, _ = self.run_chain({}, page="shode-dige")
        self.assertEqual(prov, "gemini"); self.assertNotIn("brand", [c[0] for c in calls])

    def test_no_page_no_brand(self):
        with mock.patch.dict(os.environ, ENV):
            self.assertEqual([c[0] for c in S.provider_chain(None)], ["gemini", "gemini-2", "groq"])
            self.assertEqual([c[0] for c in S.provider_chain("titan-station")], ["gemini-brand", "gemini", "gemini-2", "groq"])

    def test_duplicate_key_skipped(self):
        env = dict(ENV, GEMINI_API_KEY=KEYS["brand"])
        with mock.patch.dict(os.environ, env):
            self.assertEqual([c[0] for c in S.provider_chain("titan-station")], ["gemini-brand", "gemini-2", "groq"])

    def test_brand_refused_falls_back(self):
        (sc, prov, model), calls, log, _ = self.run_chain({"brand": "refuse"})
        self.assertEqual(prov, "gemini"); self.assertIn("gemini-brand key refused (HTTP 403)", log)

    def test_brand_and_shared_429_reach_groq_with_backoff(self):
        (sc, prov, model), calls, log, sleeps = self.run_chain({"brand": "429", "g1": "429", "g2": "429"})
        self.assertEqual(prov, "groq")
        gen = [c[0] for c in calls if c[1] == "gen"]
        self.assertEqual(gen.count("brand"), S.MAX_429_PER_KEY)  # gives the key up after 3 × 429
        self.assertTrue(any(s >= 7.5 for s in sleeps), "waits at least the API's retry delay: %s" % sleeps)

    def test_pacing_on_same_key(self):
        _, calls, log, sleeps = self.run_chain({"brand": "503"})
        self.assertTrue(sleeps and min(sleeps) > 0)

    def test_all_fail(self):
        res, calls, log, _ = self.run_chain({"brand": "refuse", "g1": "refuse", "g2": "refuse", "groq": "refuse"})
        self.assertIsInstance(res, S.ModelError); self.assertIn("Gemini (کلید برند)", res.reason)

    def test_result_carries_label_screen_and_voscript(self):
        out = io.StringIO()
        with mock.patch.dict(os.environ, {"SELFTEST_PAGE": "titan-station"}), redirect_stdout(out):
            S.selftest(mock=True); V.selftest(mock=True)
        self.assertIn("for titan-station", out.getvalue())
        self.assertIn("self-test ok (provider: mock)", out.getvalue())

    def test_keycheck_logs_status_only(self):
        fake = Fake({}); out = io.StringIO()
        env = dict(ENV, GEMINI_KEY_SHODE_DIGE="", GEMINI_KEY_FANCATSTIC_FOUR="", GEMINI_KEY_HAMRAH_SELLER="", GEMINI_KEY_PRETIME_TV="")
        with mock.patch.dict(os.environ, env), mock.patch("urllib.request.urlopen", fake), mock.patch("time.sleep", lambda s: None), redirect_stdout(out):
            S.keycheck()
        log = out.getvalue()
        self.assertIn("titan-station    HTTP 200", log); self.assertIn("shode-dige       missing", log)
        for v in KEYS.values(): self.assertNotIn(v, log)


if __name__ == "__main__":
    unittest.main()
