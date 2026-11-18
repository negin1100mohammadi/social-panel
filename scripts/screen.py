#!/usr/bin/env python3
"""«غربال‌گری» robot (v25): answers encrypted «screen» requests right away with Gemini.

Run by .github/workflows/screen.yml when Negin presses «شروع غربال‌گری» in «مغز متفکر» › «غربال‌گری».
Works on a checkout of the repo (the workflow commits + pushes what it writes):
  reads   hark/requests/<id>.json      ECIES to config/hark_pub.json  (info "sp-hark-req-v1", AAD "sp-hark-req-v1|<id>")
          hark/identity/<page>.json    brand identity mirror          (info "sp-hark-id-v1",  AAD "sp-hark-id-v1|hark/identity/<page>.json")
  writes  hark/out/<page>/<oid>.json   ECIES to config/inbox_pub.json (info "sp-hark-out-v1", AAD "sp-hark-out-v1|<page>/<oid>")
          = the same {type:"script"} message as hark_bridge.py post-script, or {type:"screen_error", reason} on failure
  deletes the handled request file (= hark_bridge.py mark-done).
Secrets: HARK_PRIV_JWK (Hark's private key doc {kid, jwk}); AI keys, tried in order, empty ones skipped:
  GEMINI_API_KEY, GEMINI_API_KEY_2 (Gemini), GROQ_API_KEY (Groq), OPENROUTER_API_KEY (OpenRouter free models).
The repo and the Actions logs are public: this script never prints decrypted content (titles, ideas, identity, scripts).

  python scripts/screen.py [--root .] [--request-id r…] [--dry-run] [--mock]
--dry-run: decrypt + call the model + build the answer, but write/delete nothing. --mock: no Gemini call (canned script; tests).
"""
import argparse
import base64
import json
import os
import re
import secrets
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

PAGES = ["hamrah-seller", "titan-station", "fancatstic-four", "shode-dige", "pretime-tv"]
REQ_INFO, OUT_INFO, ID_INFO = "sp-hark-req-v1", "sp-hark-out-v1", "sp-hark-id-v1"
ALG = "ECDH-P256+HKDF-SHA256+A256GCM"
TEH = timezone(timedelta(hours=3, minutes=30))
MODELS = ["gemini-2.5-flash", "gemini-2.0-flash"]  # the brief's models; the newest flash models from ListModels and gemini-flash-latest go first
API = "https://generativelanguage.googleapis.com/v1beta/models/%s:generateContent"


# ------------------------------------------------------------------ crypto (same as hark_bridge.py)
def b64u(b): return base64.urlsafe_b64encode(b).rstrip(b"=").decode()
def unb64u(s): return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))
def now_iso(): return datetime.now(TEH).isoformat(timespec="seconds")
def new_id(prefix): return prefix + datetime.now(TEH).strftime("%y%m%d-%H%M%S") + "-" + secrets.token_hex(3)


def pub_from_jwk(jwk):
    return ec.EllipticCurvePublicNumbers(int.from_bytes(unb64u(jwk["x"]), "big"), int.from_bytes(unb64u(jwk["y"]), "big"), ec.SECP256R1()).public_key()


def priv_from_jwk(jwk):
    return ec.derive_private_key(int.from_bytes(unb64u(jwk["d"]), "big"), ec.SECP256R1())


def _key(shared, info):
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=None, info=info.encode()).derive(shared)


def seal(pub_doc, info, aad, payload, extra=None):
    eph = ec.generate_private_key(ec.SECP256R1())
    shared = eph.exchange(ec.ECDH(), pub_from_jwk(pub_doc["jwk"]))
    iv = os.urandom(12)
    ct = AESGCM(_key(shared, info)).encrypt(iv, json.dumps(payload, ensure_ascii=False).encode(), aad.encode())
    n = eph.public_key().public_numbers()
    env = {"v": 1, "kid": pub_doc.get("kid"), "alg": ALG, "info": info,
           "epk": {"kty": "EC", "crv": "P-256", "x": b64u(n.x.to_bytes(32, "big")), "y": b64u(n.y.to_bytes(32, "big"))},
           "iv": base64.b64encode(iv).decode(), "ct": base64.b64encode(ct).decode(), "created_at": now_iso()}
    env.update(extra or {})
    return env


def open_env(priv, info, aad, env):
    shared = priv.exchange(ec.ECDH(), pub_from_jwk(env["epk"]))
    pt = AESGCM(_key(shared, info)).decrypt(base64.b64decode(env["iv"]), base64.b64decode(env["ct"]), aad.encode())
    return json.loads(pt)


def load_priv():
    raw = os.environ.get("HARK_PRIV_JWK", "").strip()
    if not raw and os.environ.get("HARK_KEY") and os.path.isfile(os.environ["HARK_KEY"]): raw = open(os.environ["HARK_KEY"]).read()
    if not raw: raise SystemExit("HARK_PRIV_JWK is not set (repo secret)")
    doc = json.loads(raw)
    jwk = doc.get("jwk", doc)
    if not jwk.get("d"): raise SystemExit("HARK_PRIV_JWK has no private part")
    return doc.get("kid"), priv_from_jwk(jwk)


# ------------------------------------------------------------------ repo files (a checkout)
class Repo:
    def __init__(self, root): self.root = root
    def p(self, rel): return os.path.join(self.root, rel)
    def read(self, rel):
        f = self.p(rel)
        return json.load(open(f, encoding="utf-8")) if os.path.isfile(f) else None
    def list(self, d):
        f = self.p(d)
        return sorted(x for x in os.listdir(f) if x.endswith(".json")) if os.path.isdir(f) else []
    def write(self, rel, obj):
        f = self.p(rel); os.makedirs(os.path.dirname(f), exist_ok=True)
        with open(f, "w", encoding="utf-8") as fh: json.dump(obj, fh, ensure_ascii=False, indent=1); fh.write("\n")
    def delete(self, rel):
        f = self.p(rel)
        if os.path.isfile(f): os.remove(f)


def post_out(repo, page, payload, dry):
    pub = repo.read("config/inbox_pub.json")
    if not pub or not pub.get("jwk"): raise SystemExit("config/inbox_pub.json missing")
    oid = new_id("o")
    payload["id"] = oid; payload["page"] = page; payload.setdefault("created_at", now_iso())
    env = seal(pub, OUT_INFO, "%s|%s/%s" % (OUT_INFO, page, oid), payload, {"id": oid, "page": page})
    if not dry: repo.write("hark/out/%s/%s.json" % (page, oid), env)
    return oid, env


def identity_brief(repo, page, kid, priv):
    path = "hark/identity/%s.json" % page
    env = repo.read(path)
    if not env: return ""
    if env.get("kid") and kid and env["kid"] != kid: return ""
    try:
        doc = open_env(priv, ID_INFO, ID_INFO + "|" + path, env)
    except Exception:
        return ""
    return str(doc.get("brief") or "").strip()


# ------------------------------------------------------------------ prompt
SYSTEM = """تو استراتژیست و فیلم‌نامه‌نویس حرفه‌ی ویدئوهای کوتاه وایرال فارسی هستی (Instagram Reels، YouTube Shorts، TikTok).
کار تو «غربال‌گری» است: ایده‌ای که تیم فرستاده را به یک اسکریپت حرفه‌ای، قابل ضبط و وایرال فارسی برای همین پیج تبدیل کنی.

قواعد:
- مطابق الگوریتم هر پلتفرم و ترندهای همین حالا بنویس: نگه‌داشت مخاطب (watch time / retention)، بازپخش (loop)، ذخیره و اشتراک، و تعامل در کامنت.
- هوک: یک جمله‌ی کوبنده برای ثانیه‌ی ۱ تا ۳ که مخاطب را از اسکرول نگه دارد (سؤال، ادعای غافلگیرکننده، تنش، یا نتیجه‌ی اول).
- بیت‌های نگه‌داشت با زمان‌بندی (مثل 0:03، 0:08، …): هر چند ثانیه یک چیز تازه (پیچ، عدد، تصویر، سؤال) تا مخاطب نرود.
- CTA روشن و طبیعی؛ اگر شناسنامه‌ی برند CTA مشخص دارد از همان‌ها استفاده کن.
- کپشن کوتاه و جذاب، و هشتگ‌ها (فارسی/انگلیسی، مرتبط و مطابق شناسنامه).
- مدت مناسب هر پلتفرم را جدا بنویس (reels، shorts، tiktok) و اگر نکته‌ی خاصی برای یک پلتفرم هست، کنار مدتش بگو.
- اگر ترند یا صدای (sound) مشخصی به این ایده می‌خورد پیشنهاد بده؛ اگر نمی‌خورد، خالی بگذار. ترند ساختگی نساز.
- «متن کامل» یعنی متن آماده‌ی ضبط/وویس‌اور از اول تا آخر، با شکست خط، به همان ترتیب بیت‌ها.
- شناسنامه‌ی برند (هویت) قانون است: لحن، بایدها و نبایدها، کلمات ممنوع (هرگز به کار نبر)، کلیدواژه‌ها، CTAها، هشتگ‌ها و پرامپت پایه را دقیق رعایت کن. اگر با ایده تعارض دارد، شناسنامه مقدم است.
- همه‌ی متن‌ها فارسی روان و طبیعی (به‌جز نام پلتفرم‌ها، برندها و هشتگ‌های انگلیسی).
- اگر درخواست «بازطراحی» است: نسخه‌ی قبلی را بخوان، دلیل بازطراحی را دقیق اجرا کن و نسخه‌ای بهتر بنویس، نه تکرار همان.
- خروجی فقط یک شیء JSON با همین کلیدها: title, hook, beats[{t, text}], cta, text, caption, hashtags[], platforms{reels, shorts, tiktok}, trend."""

SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "title": {"type": "STRING"}, "hook": {"type": "STRING"},
        "beats": {"type": "ARRAY", "items": {"type": "OBJECT", "properties": {"t": {"type": "STRING"}, "text": {"type": "STRING"}}, "required": ["t", "text"]}},
        "cta": {"type": "STRING"}, "text": {"type": "STRING"}, "caption": {"type": "STRING"},
        "hashtags": {"type": "ARRAY", "items": {"type": "STRING"}},
        "platforms": {"type": "OBJECT", "properties": {"reels": {"type": "STRING"}, "shorts": {"type": "STRING"}, "tiktok": {"type": "STRING"}}, "required": ["reels", "shorts", "tiktok"]},
        "trend": {"type": "STRING"}},
    "required": ["title", "hook", "beats", "cta", "text", "caption", "hashtags", "platforms"],
}


def build_prompt(req, brief):
    nets = ", ".join(req.get("networks") or []) or "Instagram Reels, YouTube Shorts, TikTok"
    parts = ["پیج: %s" % (req.get("page_name") or req.get("page") or ""),
             "موضوع پیج: %s" % (req.get("topic") or "")]
    if brief: parts += ["", "=== شناسنامه‌ی برند (هویت) — دقیق رعایت شود ===", brief, "=== پایان شناسنامه ==="]
    else: parts += ["", "(شناسنامه‌ی برند هنوز در دسترس نیست؛ لحن و سبک را از موضوع پیج بگیر.)"]
    parts += ["", "=== ایده ===", "عنوان: %s" % (req.get("title") or ""), "توضیح:", req.get("body") or "(بدون توضیح)",
              "نویسنده‌ی ایده: %s" % (req.get("author") or ""), "شبکه‌ها: %s" % nets, "قالب: %s" % (req.get("format") or "ریل / ویدئوی کوتاه عمودی")]
    if req.get("redo"):
        parts += ["", "=== درخواست بازطراحی ===", "دلیل: %s" % (req.get("reason") or ""), "نسخه‌ی قبلی:", req.get("previous") or "(نسخه‌ی قبلی در دسترس نیست)"]
    if req.get("brief"): parts += ["", "بریف پنل: %s" % req["brief"]]
    parts += ["", "حالا اسکریپت را فقط به‌صورت JSON طبق ساختار خواسته‌شده بنویس."]
    return "\n".join(parts)


class ModelError(Exception):
    def __init__(self, reason, log): Exception.__init__(self, log); self.reason = reason; self.log = log


DEADLINE_S = 225  # the panel waits ~4 min; stop trying before that and report an error it can show
# provider chain (v25): the first one that returns a valid script wins; a provider whose secret is empty is skipped
PROVIDERS = [  # (id, env var, kind, budget seconds)
    ("gemini", "GEMINI_API_KEY", "gemini", 95),
    ("gemini-2", "GEMINI_API_KEY_2", "gemini", 70),
    ("groq", "GROQ_API_KEY", "openai", 45),
    ("openrouter", "OPENROUTER_API_KEY", "openai", 70),
]
OPENAI_COMPAT = {
    "groq": ("https://api.groq.com/openai/v1/chat/completions", ["llama-3.3-70b-versatile", "openai/gpt-oss-120b"], {}),
    "openrouter": ("https://openrouter.ai/api/v1/chat/completions", ["deepseek/deepseek-chat-v3-0324:free", "meta-llama/llama-3.3-70b-instruct:free"],
                   {"HTTP-Referer": "https://negin1100mohammadi.github.io/social-panel/", "X-Title": "social-panel screening"}),
}
JSON_SHAPE = ('{"title": "…", "hook": "…", "beats": [{"t": "0:03", "text": "…"}], "cta": "…", "text": "متن کامل با شکست خط", '
              '"caption": "…", "hashtags": ["#…"], "platforms": {"reels": "…", "shorts": "…", "tiktok": "…"}, "trend": "… یا خالی"}')


def _post(model, body, key, timeout):
    r = urllib.request.Request(API % model, data=json.dumps(body).encode(), method="POST",
                               headers={"Content-Type": "application/json", "x-goog-api-key": key})
    with urllib.request.urlopen(r, timeout=timeout) as resp:
        return json.loads(resp.read())


def _err_of(e):
    try: err = json.loads(e.read()).get("error") or {}
    except Exception: err = {}
    if not isinstance(err, dict): err = {"message": str(err)}
    return str(err.get("status") or err.get("code") or err.get("type") or ""), str(err.get("message", ""))


def call_gemini(prompt, key, budget, tag="gemini"):
    """Gemini with model fallbacks; returns (script, model) or raises ModelError (kind: quota|key|bad|down)."""
    base = {"systemInstruction": {"parts": [{"text": SYSTEM}]},
            "contents": [{"role": "user", "parts": [{"text": prompt}]}],
            "generationConfig": {"responseMimeType": "application/json", "responseSchema": SCHEMA, "temperature": 0.9, "maxOutputTokens": 8192,
                                 "thinkingConfig": {"thinkingBudget": 512}}}
    t0 = time.time(); last = None
    found = list_flash_models(key)
    print("  %s: flash models: %s" % (tag, ", ".join(found[:5]) or "none listed"))
    models = []
    for m in found[:4] + ["gemini-flash-latest"] + MODELS:
        if m not in models: models.append(m)
    for model in models:
        body = json.loads(json.dumps(base))
        tries = 0
        while tries < 3:
            tries += 1
            left = budget - (time.time() - t0)
            if left < 12: break
            t1 = time.time()
            try:
                data = _post(model, body, key, min(60, left))
            except urllib.error.HTTPError as e:
                st, msg = _err_of(e)
                last = (e.code, st)
                print("  %s %s -> HTTP %s %s (%.0fs)" % (tag, model, e.code, st, time.time() - t1))
                if e.code == 400 and "thinking" in msg.lower() and "thinkingConfig" in body["generationConfig"]:
                    del body["generationConfig"]["thinkingConfig"]; tries -= 1; continue
                if e.code == 400 and "schema" in msg.lower() and "responseSchema" in body["generationConfig"]:
                    del body["generationConfig"]["responseSchema"]; tries -= 1; continue
                if (e.code == 400 and ("api key" in msg.lower() or "API_KEY" in msg)) or e.code in (401, 403):
                    raise ModelError("key", "%s key refused (HTTP %s)" % (tag, e.code))
                if e.code in (500, 502, 503, 504) and tries < 2: time.sleep(2); continue
                break  # 400 / 404 / 429 / repeated 5xx -> next model
            except Exception as e:
                last = (0, type(e).__name__); print("  %s %s -> %s (%.0fs)" % (tag, model, type(e).__name__, time.time() - t1)); break
            cands = data.get("candidates") or []
            fin = cands[0].get("finishReason", "") if cands else (data.get("promptFeedback") or {}).get("blockReason", "empty")
            txt = "".join(p.get("text", "") for p in ((cands[0].get("content") or {}).get("parts") or []) if not p.get("thought")) if cands else ""
            print("  %s %s -> 200 %s, %d chars (%.0fs)" % (tag, model, fin, len(txt), time.time() - t1))
            try:
                return parse_script(txt), model
            except ValueError as e:
                last = (200, fin or "unparseable"); print("  %s %s -> %s" % (tag, model, e))
                if fin == "MAX_TOKENS": body["generationConfig"]["maxOutputTokens"] = 16384
                continue
        if budget - (time.time() - t0) < 12: break
    raise ModelError(_kind(last), "%s: %s" % (tag, last))


def call_openai(pid, prompt, key, budget):
    url, models, extra = OPENAI_COMPAT[pid]
    t0 = time.time(); last = None
    for model in models:
        body = {"model": model, "temperature": 0.9, "max_tokens": 4096, "response_format": {"type": "json_object"},
                "messages": [{"role": "system", "content": SYSTEM + "\n\nفقط یک شیء JSON معتبر با این شکل برگردان (بدون هیچ متن دیگری):\n" + JSON_SHAPE},
                             {"role": "user", "content": prompt}]}
        tries = 0
        while tries < 2:
            tries += 1
            left = budget - (time.time() - t0)
            if left < 8: break
            h = {"Content-Type": "application/json", "Authorization": "Bearer " + key, "User-Agent": "social-panel-screen"}
            h.update(extra)
            t1 = time.time()
            try:
                with urllib.request.urlopen(urllib.request.Request(url, data=json.dumps(body).encode(), method="POST", headers=h), timeout=min(60, left)) as resp:
                    data = json.loads(resp.read())
            except urllib.error.HTTPError as e:
                st, msg = _err_of(e)
                last = (e.code, st)
                print("  %s %s -> HTTP %s %s (%.0fs)" % (pid, model, e.code, st, time.time() - t1))
                if e.code == 400 and "response_format" in body and ("response_format" in msg or "json" in msg.lower()):
                    del body["response_format"]; tries -= 1; continue
                if e.code in (401, 403): raise ModelError("key", "%s key refused (HTTP %s)" % (pid, e.code))
                if e.code in (500, 502, 503, 504) and tries < 2: time.sleep(2); continue
                break
            except Exception as e:
                last = (0, type(e).__name__); print("  %s %s -> %s (%.0fs)" % (pid, model, type(e).__name__, time.time() - t1)); break
            ch = (data.get("choices") or [{}])[0]
            txt = str((ch.get("message") or {}).get("content") or "")
            print("  %s %s -> 200 %s, %d chars (%.0fs)" % (pid, model, ch.get("finish_reason", ""), len(txt), time.time() - t1))
            try:
                return parse_script(txt), model
            except ValueError as e:
                last = (200, "unparseable"); print("  %s %s -> %s" % (pid, model, e)); continue
        if budget - (time.time() - t0) < 8: break
    raise ModelError(_kind(last), "%s: %s" % (pid, last))


def _kind(last):
    if not last: return "down"
    if last[0] == 429: return "quota"
    if last[0] == 200: return "bad"
    return "down"


FAIL_FA = {"quota": "سهمیه‌ی رایگان همه‌ی سرویس‌ها فعلاً تمام شده؛ چند دقیقه بعد «دوباره» را بزن.",
           "key": "کلید سرویس‌های هوش مصنوعی در Secrets گیت‌هاب نامعتبر است.",
           "bad": "پاسخ سرویس‌های هوش مصنوعی قابل خواندن نبود؛ «دوباره» را بزن.",
           "down": "سرویس‌های هوش مصنوعی به‌موقع جواب ندادند؛ «دوباره» را بزن.",
           "none": "هیچ کلید هوش مصنوعی (GEMINI_API_KEY و …) در Secrets گیت‌هاب تنظیم نشده."}
PROVIDER_FA = {"gemini": "Gemini", "gemini-2": "Gemini (کلید دوم)", "groq": "Groq", "openrouter": "OpenRouter"}


def call_model(prompt):
    """walk the provider chain; returns (script, provider, model); raises ModelError(reason_fa) only when all failed"""
    t0 = time.time(); kinds = []; tried = []
    chain = [(pid, os.environ.get(env, "").strip(), kind, bud) for pid, env, kind, bud in PROVIDERS]
    active = [c for c in chain if c[1]]
    print("  providers: %s" % (", ".join(c[0] for c in active) or "none"))
    for i, (pid, key, kind, bud) in enumerate(active):
        left = DEADLINE_S - (time.time() - t0)
        # keep room for the providers after this one (fast ones answer in seconds)
        reserve = sum(min(25, c[3]) for c in active[i + 1:])
        budget = max(15, min(bud, left - reserve)) if i < len(active) - 1 else left
        if left < 10: break
        tried.append(pid)
        try:
            sc, model = call_gemini(prompt, key, budget, pid) if kind == "gemini" else call_openai(pid, prompt, key, budget)
            return sc, pid, model
        except ModelError as e:
            print("  %s failed (%s); next provider" % (pid, e.log)); kinds.append(e.reason)
    if not active: raise ModelError(FAIL_FA["none"], "no provider keys")
    k = "quota" if kinds and all(x == "quota" for x in kinds) else "key" if kinds and all(x == "key" for x in kinds) else \
        "bad" if "bad" in kinds else "down"
    raise ModelError(FAIL_FA[k] + " (امتحان‌شده: %s)" % "، ".join(PROVIDER_FA.get(p, p) for p in tried), "all providers failed: %s" % ",".join(kinds))


def list_flash_models(key):
    """text 'flash' models that support generateContent, newest version first (no previews/lite/tts/image when others exist)"""
    try:
        r = urllib.request.Request("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", headers={"x-goog-api-key": key})
        with urllib.request.urlopen(r, timeout=30) as resp: data = json.loads(resp.read())
    except Exception as e:
        print("  ListModels -> %s" % type(e).__name__); return []
    out = []
    for m in data.get("models") or []:
        n = str(m.get("name", "")).replace("models/", "")
        if "generateContent" not in (m.get("supportedGenerationMethods") or []) or "flash" not in n: continue
        if re.search(r"tts|image|audio|live|embed|thinking|exp", n): continue
        out.append(n)
    def rank(n):
        v = re.search(r"gemini-(\d+(?:\.\d+)?)", n)
        return (0 if re.search(r"preview|lite", n) else 1, float(v.group(1)) if v else 0, "latest" in n)
    return sorted(out, key=rank, reverse=True)


def parse_script(txt):
    t = txt.strip()
    t = re.sub(r"^```(?:json)?\s*|\s*```$", "", t)
    try: s = json.loads(t)
    except Exception:
        m = re.search(r"\{.*\}", t, re.S)
        if not m: raise ValueError("answer is not JSON")
        try: s = json.loads(m.group(0))
        except Exception: raise ValueError("answer is not JSON")
    if isinstance(s, list) and s and isinstance(s[0], dict): s = s[0]
    if not isinstance(s, dict): raise ValueError("answer is not a JSON object")
    out = {"title": str(s.get("title") or "").strip(), "hook": str(s.get("hook") or "").strip()}
    beats = []
    for b in s.get("beats") or []:
        if isinstance(b, dict):
            tx = str(b.get("text") or b.get("line") or "").strip()
            if tx: beats.append({"t": str(b.get("t") or b.get("time") or "").strip(), "text": tx})
        elif str(b).strip(): beats.append(str(b).strip())
    out["beats"] = beats
    for k in ("cta", "text", "caption", "trend"): out[k] = str(s.get(k) or "").strip()
    h = s.get("hashtags") or []
    if isinstance(h, str): h = h.split()
    out["hashtags"] = [x if x.startswith("#") else "#" + x for x in (str(y).strip().replace(" ", "_") for y in h) if x]
    pl = s.get("platforms") or {}
    out["platforms"] = {k: (v if isinstance(v, (str, dict)) else str(v)) for k, v in pl.items() if k in ("reels", "shorts", "tiktok") and v} if isinstance(pl, dict) else {}
    if not out["trend"]: del out["trend"]
    if not (out["text"] or out["hook"]): raise ValueError("answer has no text/hook")
    return out


MOCK = {"title": "اسکریپت آزمایشی", "hook": "هوک آزمایشی", "beats": [{"t": "0:03", "text": "بیت ۱"}], "cta": "فالو کن", "text": "متن\nآزمایشی",
        "caption": "کپشن", "hashtags": ["#تست"], "platforms": {"reels": "25–30 s", "shorts": "30–45 s", "tiktok": "21–34 s"}}


# ------------------------------------------------------------------ self-test (synthetic request, throwaway keys, nothing written to the repo)
def selftest(mock=False):
    import tempfile
    def jwk(k, priv=False):
        n = (k.public_key() if priv else k).public_numbers()
        d = {"kty": "EC", "crv": "P-256", "x": b64u(n.x.to_bytes(32, "big")), "y": b64u(n.y.to_bytes(32, "big"))}
        if priv: d["d"] = b64u(k.private_numbers().private_value.to_bytes(32, "big"))
        return d
    hk, ik = ec.generate_private_key(ec.SECP256R1()), ec.generate_private_key(ec.SECP256R1())
    root = tempfile.mkdtemp(); R = Repo(root)
    R.write("config/inbox_pub.json", {"kid": "selftest-inbox", "jwk": jwk(ik.public_key())})
    hpub = {"kid": "selftest", "jwk": jwk(hk.public_key())}
    req = {"type": "screen", "id": "rselftest", "page": "shode-dige", "page_name": "Self test", "topic": "سرگرمی و طنز روزمره", "screen_id": "sselftest",
           "title": "سه اشتباه رایج صبح‌ها که روزت را خراب می‌کند", "body": "ویدئوی کوتاه طنز", "networks": ["instagram", "tiktok", "youtube"], "format": "ریل"}
    R.write("hark/requests/rselftest.json", seal(hpub, REQ_INFO, REQ_INFO + "|rselftest", req, {"id": "rselftest"}))
    os.environ["HARK_PRIV_JWK"] = json.dumps({"kid": "selftest", "jwk": jwk(hk, True)})
    print("self-test: synthetic request, throwaway keys, dry run")
    summ = main(["--root", root, "--dry-run"] + (["--mock"] if mock else []))
    if not summ["done"]: raise SystemExit("self-test failed")
    print("self-test ok")


# ------------------------------------------------------------------ main
def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=".")
    ap.add_argument("--request-id", default=os.environ.get("REQUEST_ID", ""))
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--mock", action="store_true")
    ap.add_argument("--out-summary", default=os.environ.get("SCREEN_SUMMARY", ""), help="write a non-secret JSON summary here")
    a = ap.parse_args(argv)
    repo = Repo(a.root)
    kid, priv = load_priv()
    rid_in = a.request_id.strip()
    if rid_in and not re.fullmatch(r"[A-Za-z0-9_.-]{1,80}", rid_in): raise SystemExit("bad request_id")
    names = [rid_in + ".json"] if rid_in else repo.list("hark/requests")
    summary = {"done": [], "error": [], "skipped": []}
    for name in names:
        rid = name[:-5]
        env = repo.read("hark/requests/" + name)
        if not env:
            print("%s: not found (already handled?)" % rid); summary["skipped"].append(rid); continue
        if env.get("kid") and kid and env["kid"] != kid:
            print("%s: for another key, skipped" % rid); summary["skipped"].append(rid); continue
        try:
            req = open_env(priv, REQ_INFO, REQ_INFO + "|" + rid, env)
        except Exception as e:
            print("%s: cannot decrypt (%s), left in place" % (rid, type(e).__name__)); summary["skipped"].append(rid); continue
        if req.get("type") != "screen":
            print("%s: type %s, not for this robot" % (rid, req.get("type"))); summary["skipped"].append(rid); continue
        page = req.get("page")
        if page not in PAGES:
            print("%s: unknown page, left in place" % rid); summary["skipped"].append(rid); continue
        print("%s: screen%s for %s" % (rid, " (redo)" if req.get("redo") else "", page))
        brief = identity_brief(repo, page, kid, priv)
        print("  identity brief: %s" % ("yes (%d chars)" % len(brief) if brief else "no, using page topic"))
        try:
            if a.mock: sc, provider, model = dict(MOCK), "mock", "mock"
            else: sc, provider, model = call_model(build_prompt(req, brief))
            oid, _ = post_out(repo, page, {"type": "script", "request_id": rid, "screen_id": req.get("screen_id"), "script": sc, "by": "screen-robot",
                                           "provider": provider, "model": model}, a.dry_run)
            print("  ok: %s/%s, %d beats -> hark/out/%s/%s.json%s" % (provider, model, len(sc.get("beats") or []), page, oid, " (dry run, not written)" if a.dry_run else ""))
            summary["done"].append(rid)
        except ModelError as e:
            oid, _ = post_out(repo, page, {"type": "screen_error", "request_id": rid, "screen_id": req.get("screen_id"), "reason": e.reason}, a.dry_run)
            print("  error: %s -> hark/out/%s/%s.json" % (e.log, page, oid))
            summary["error"].append(rid)
        if not a.dry_run: repo.delete("hark/requests/" + name)
    print("done: %d ok, %d error, %d skipped" % (len(summary["done"]), len(summary["error"]), len(summary["skipped"])))
    if a.out_summary:
        json.dump(summary, open(a.out_summary, "w"))
    return summary


if __name__ == "__main__":
    if "--selftest" in sys.argv: selftest(mock="--mock" in sys.argv)
    else: main()
