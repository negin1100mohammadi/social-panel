#!/usr/bin/env python3
"""«اسکریپت ویس‌اور» robot (v28): answers encrypted «voscript» requests right away.

Run by .github/workflows/voscript.yml when the team presses «نوشتن ویس‌اور» in «مغز متفکر» › ۵ «اسکریپت ویس‌اور».
Same channel, crypto, provider chain and timing as scripts/screen.py (it imports it):
  Gemini (کلید برند = GEMINI_KEY_<PAGE>, v29, ≤5 min) → Gemini ۱ (GEMINI_API_KEY, ≤5 min) → Gemini ۲ (GEMINI_API_KEY_2, ≤5 min) →
  ChatGPT = openai/gpt-oss-120b (GROQ_API_KEY, then OPENROUTER_API_KEY); empty secrets skipped; whole chain ≤ ~18 min (screen.DEADLINE_S).
  reads   hark/requests/<id>.json   (type "voscript": approved final script + content_type + comments [+ redo note/previous text])
          hark/identity/<page>.json (brand identity brief, if the panel saved one)
  writes  hark/out/<page>/<oid>.json  {type:"voscript", request_id, final_id, vo:{title, tone, pace, duration, segments[{t, scene, text, note}], text, notes},
                                       by:"voscript-robot", provider, model}  or  {type:"voscript_error", request_id, final_id, reason}
  deletes the handled request file.
The repo and the Actions logs are public: nothing decrypted is ever printed.

  python scripts/voscript.py [--root .] [--request-id r…] [--dry-run] [--mock]
  python scripts/voscript.py --selftest [--mock]     synthetic request, throwaway keys, nothing written
"""
import argparse
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import screen as S  # noqa: E402  (crypto, repo helpers, provider chain)

VO_SYSTEM = """تو نویسنده‌ی حرفه‌ی متن «ویس‌اور» (صداگذاری روی تصویر) برای محتوای کوتاه شبکه‌های اجتماعی فارسی هستی (Instagram، YouTube Shorts، TikTok).
از روی اسکریپت تأییدشده‌ی تیم، متنی می‌نویسی که گوینده (یا ابزار ساخت صدا مثل ElevenLabs) دقیقاً همان را بخواند.

قواعد:
- فارسی گفتاری، روان و طبیعی برای شنیدن (نه نوشتاری و کتابی)؛ جمله‌های کوتاه، بدون هشتگ، ایموجی، لینک یا علامت‌هایی که خوانده نمی‌شوند.
- اگر نوع محتوا «اسلاید» است: برای هر اسلاید یک بخش بنویس (scene = «اسلاید ۱»، «اسلاید ۲»، …) با زمان تقریبی هر اسلاید (مثلاً 0:00–0:04).
- اگر نوع محتوا «ویدیو» است: برای هر صحنه/بیت اسکریپت یک بخش با بازه‌ی زمانی دقیق (مثلاً 0:00–0:03) و توضیح کوتاه صحنه بنویس.
- ۱ تا ۳ ثانیه‌ی اول باید همان هوک اسکریپت باشد، کوبنده و بدون مقدمه. آخرش CTA طبیعی.
- سرعت خواندن واقع‌بینانه: حدود ۲ تا ۳ کلمه در ثانیه؛ متن هر بخش باید در زمان همان بخش جا شود.
- برای هر بخش در note راهنمای اجرا بده: لحن، تأکید روی کلمه، مکث (مثلاً «مکث کوتاه بعد از …»)، بالا/پایین بردن انرژی.
- tone = لحن کلی گوینده (مثلاً صمیمی و پرانرژی، آرام و مطمئن)؛ pace = سرعت؛ duration = مدت کل.
- text = متن کامل و پیوسته‌ی ویس‌اور از اول تا آخر، فقط همان جمله‌هایی که خوانده می‌شوند، هر بخش در یک خط.
- notes = نکته‌های کلی برای ضبط یا ابزار ساخت صدا (جنس صدا، موسیقی زیر صدا با صدای کم، تلفظ اسم‌های خاص و انگلیسی).
- شناسنامه‌ی برند قانون است: لحن، بایدها و نبایدها، کلمات ممنوع (هرگز به کار نبر) و CTAها را دقیق رعایت کن.
- اگر کامنت یا یادداشت تیم هست، اجرا کن. اگر «بازنویسی» خواسته شده، نسخه‌ی قبلی را بخوان و یادداشت را دقیق اجرا کن.
- خروجی فقط یک شیء JSON با همین کلیدها: title, tone, pace, duration, segments[{t, scene, text, note}], text, notes."""

VO_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "title": {"type": "STRING"}, "tone": {"type": "STRING"}, "pace": {"type": "STRING"}, "duration": {"type": "STRING"},
        "segments": {"type": "ARRAY", "items": {"type": "OBJECT", "properties": {"t": {"type": "STRING"}, "scene": {"type": "STRING"},
                                                                                "text": {"type": "STRING"}, "note": {"type": "STRING"}},
                                                "required": ["t", "text"]}},
        "text": {"type": "STRING"}, "notes": {"type": "STRING"}},
    "required": ["tone", "segments", "text"],
}
VO_JSON_SHAPE = ('{"title": "…", "tone": "لحن کلی", "pace": "سرعت", "duration": "مدت کل", '
                 '"segments": [{"t": "0:00–0:03", "scene": "اسلاید ۱ یا صحنه", "text": "جمله‌ای که خوانده می‌شود", "note": "راهنمای اجرا"}], '
                 '"text": "متن کامل ویس‌اور، هر بخش یک خط", "notes": "نکته‌های ضبط"}')
CT_FA = {"slide": "اسلاید (کاروسل تصویر ثابت؛ ویس‌اور روی ویدیوی اسلایدشو یا ریلِ اسلایدی)", "video": "ویدیو (عمودی ۹:۱۶، Reels / Shorts / TikTok)"}


def parse_vo(txt):
    t = re.sub(r"^```(?:json)?\s*|\s*```$", "", (txt or "").strip())
    try: s = json.loads(t)
    except Exception:
        m = re.search(r"\{.*\}", t, re.S)
        if not m: raise ValueError("answer is not JSON")
        try: s = json.loads(m.group(0))
        except Exception: raise ValueError("answer is not JSON")
    if isinstance(s, list) and s and isinstance(s[0], dict): s = s[0]
    if not isinstance(s, dict): raise ValueError("answer is not a JSON object")
    segs = []
    for b in s.get("segments") or s.get("beats") or []:
        if isinstance(b, dict):
            tx = str(b.get("text") or b.get("line") or "").strip()
            if tx: segs.append({"t": str(b.get("t") or b.get("time") or "").strip(), "scene": str(b.get("scene") or "").strip(),
                                "text": tx, "note": str(b.get("note") or "").strip()})
        elif str(b).strip(): segs.append({"t": "", "scene": "", "text": str(b).strip(), "note": ""})
    out = {k: str(s.get(k) or "").strip() for k in ("title", "tone", "pace", "duration", "text", "notes")}
    out["segments"] = segs
    if not out["text"] and segs: out["text"] = "\n".join(x["text"] for x in segs)
    if not out["text"]: raise ValueError("answer has no voice-over text")
    return out


def build_prompt(req, brief):
    ct = req.get("content_type") or "video"
    parts = ["پیج: %s" % (req.get("page_name") or req.get("page") or ""), "موضوع پیج: %s" % (req.get("topic") or ""),
             "نوع محتوا: %s" % CT_FA.get(ct, ct)]
    if brief: parts += ["", "=== شناسنامه‌ی برند (هویت) — دقیق رعایت شود ===", brief, "=== پایان شناسنامه ==="]
    else: parts += ["", "(شناسنامه‌ی برند در دسترس نیست؛ لحن را از اسکریپت و موضوع پیج بگیر.)"]
    parts += ["", "=== اسکریپت تأییدشده ===", "عنوان: %s" % (req.get("title") or ""), req.get("script_text") or "(متن اسکریپت خالی است)"]
    cm = [c for c in (req.get("comments") or []) if isinstance(c, dict) and c.get("text")]
    if cm: parts += ["", "=== کامنت‌های تیم ==="] + ["- %s: %s" % (c.get("by") or "", c.get("text")) for c in cm[-20:]]
    if req.get("redo"):
        parts += ["", "=== درخواست بازنویسی ===", "چی باید عوض بشه: %s" % (req.get("note") or ""), "نسخه‌ی قبلی:", req.get("previous") or "(در دسترس نیست)"]
    parts += ["", "حالا متن ویس‌اور را فقط به‌صورت JSON طبق ساختار خواسته‌شده بنویس."]
    return "\n".join(parts)


def use_vo_prompt():
    """screen.py's provider chain reads these module globals at call time: point them at the voice-over prompt"""
    S.SYSTEM, S.SCHEMA, S.JSON_SHAPE, S.parse_script = VO_SYSTEM, VO_SCHEMA, VO_JSON_SHAPE, parse_vo


MOCK = {"title": "ویس‌اور آزمایشی", "tone": "صمیمی", "pace": "متوسط", "duration": "۱۵ ثانیه",
        "segments": [{"t": "0:00–0:03", "scene": "صحنه ۱", "text": "هوک آزمایشی", "note": "پرانرژی"}], "text": "هوک آزمایشی", "notes": ""}


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=".")
    ap.add_argument("--request-id", default=os.environ.get("REQUEST_ID", ""))
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--mock", action="store_true")
    a = ap.parse_args(argv)
    use_vo_prompt()
    repo = S.Repo(a.root)
    kid, priv = S.load_priv()
    rid_in = a.request_id.strip()
    if rid_in and not re.fullmatch(r"[A-Za-z0-9_.-]{1,80}", rid_in): raise SystemExit("bad request_id")
    names = [rid_in + ".json"] if rid_in else repo.list("hark/requests")
    summary = {"done": [], "error": [], "skipped": [], "provider": ""}
    for name in names:
        rid = name[:-5]
        env = repo.read("hark/requests/" + name)
        if not env:
            print("%s: not found (already handled?)" % rid); summary["skipped"].append(rid); continue
        if env.get("kid") and kid and env["kid"] != kid:
            print("%s: for another key, skipped" % rid); summary["skipped"].append(rid); continue
        try:
            req = S.open_env(priv, S.REQ_INFO, S.REQ_INFO + "|" + rid, env)
        except Exception as e:
            print("%s: cannot decrypt (%s), left in place" % (rid, type(e).__name__)); summary["skipped"].append(rid); continue
        if req.get("type") != "voscript":
            print("%s: type %s, not for this robot" % (rid, req.get("type"))); summary["skipped"].append(rid); continue
        page = req.get("page")
        if page not in S.PAGES:
            print("%s: unknown page, left in place" % rid); summary["skipped"].append(rid); continue
        print("%s: voscript%s for %s (%s)" % (rid, " (redo)" if req.get("redo") else "", page, req.get("content_type") or "?"))
        brief = S.identity_brief(repo, page, kid, priv)
        print("  identity brief: %s" % ("yes (%d chars)" % len(brief) if brief else "no"))
        try:
            if a.mock: vo, provider, model = dict(MOCK), "mock", "mock"
            else: vo, provider, model = S.call_model(build_prompt(req, brief), page)
            oid, _ = S.post_out(repo, page, {"type": "voscript", "request_id": rid, "final_id": req.get("final_id"), "vo": vo, "by": "voscript-robot",
                                             "provider": provider, "provider_label": S.PROVIDER_FA.get(provider, provider), "model": model}, a.dry_run)
            print("  ok: %s/%s, %d segments, %d chars -> hark/out/%s/%s.json%s" % (provider, model, len(vo.get("segments") or []), len(vo.get("text") or ""),
                                                                                 page, oid, " (dry run, not written)" if a.dry_run else ""))
            summary["done"].append(rid); summary["provider"] = provider
        except S.ModelError as e:
            oid, _ = S.post_out(repo, page, {"type": "voscript_error", "request_id": rid, "final_id": req.get("final_id"), "reason": e.reason}, a.dry_run)
            print("  error: %s -> hark/out/%s/%s.json" % (e.log, page, oid))
            summary["error"].append(rid)
        if not a.dry_run: repo.delete("hark/requests/" + name)
    print("done: %d ok, %d error, %d skipped" % (len(summary["done"]), len(summary["error"]), len(summary["skipped"])))
    return summary


def selftest(mock=False):
    import tempfile
    from cryptography.hazmat.primitives.asymmetric import ec

    def jwk(k, priv=False):
        n = (k.public_key() if priv else k).public_numbers()
        d = {"kty": "EC", "crv": "P-256", "x": S.b64u(n.x.to_bytes(32, "big")), "y": S.b64u(n.y.to_bytes(32, "big"))}
        if priv: d["d"] = S.b64u(k.private_numbers().private_value.to_bytes(32, "big"))
        return d
    hk, ik = ec.generate_private_key(ec.SECP256R1()), ec.generate_private_key(ec.SECP256R1())
    root = tempfile.mkdtemp(); R = S.Repo(root)
    R.write("config/inbox_pub.json", {"kid": "selftest-inbox", "jwk": jwk(ik.public_key())})
    hpub = {"kid": "selftest", "jwk": jwk(hk.public_key())}
    page = os.environ.get("SELFTEST_PAGE", "").strip() or "shode-dige"
    if page not in S.PAGES: raise SystemExit("unknown SELFTEST_PAGE")
    req = {"type": "voscript", "id": "rvoself", "page": page, "page_name": "Self test", "topic": "سرگرمی و طنز روزمره", "final_id": "fself",
           "title": "سه اشتباه رایج صبح‌ها", "content_type": "slide", "content_type_fa": "اسلاید",
           "script_text": "هوک: صبح‌ها این سه کار رو می‌کنی؟\n۱. گوشی قبل از آب\n۲. اسنوز پشت اسنوز\n۳. صبحونه‌ی سرپایی\nCTA: فالو کن برای روتین بهتر",
           "comments": [{"by": "نگین", "text": "لحن شوخ ولی کوتاه"}]}
    R.write("hark/requests/rvoself.json", S.seal(hpub, S.REQ_INFO, S.REQ_INFO + "|rvoself", req, {"id": "rvoself"}))
    os.environ["HARK_PRIV_JWK"] = json.dumps({"kid": "selftest", "jwk": jwk(hk, True)})
    print("self-test: synthetic voscript request, throwaway keys, dry run")
    summ = main(["--root", root, "--dry-run", "--request-id", ""] + (["--mock"] if mock else []))
    if not summ["done"]: raise SystemExit("self-test failed")
    print("self-test ok (provider: %s)" % summ["provider"])


if __name__ == "__main__":
    if "--selftest" in sys.argv: selftest(mock="--mock" in sys.argv)
    else: main()
