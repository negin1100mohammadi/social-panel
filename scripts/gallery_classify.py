"""Gallery auto-classification — the same rules as classifyUpload() in app.js (tests/classifier_cases.json covers both).

files: list of {"type": "image"|"video", "w": int, "h": int, "dur": float}
returns: list of {"files": [indexes], "kind": slide|reel|story|video, "rule": Persian text, "suggest": bool}
"""

FA_DIGITS = str.maketrans("0123456789", "۰۱۲۳۴۵۶۷۸۹")


def _near(w, h, a, b, tol=0.03):
    return bool(w and h) and abs(w / h - a / b) <= tol


def classify_image(f):
    w, h = f.get("w") or 0, f.get("h") or 0
    if not w or not h:
        return {"kind": "slide", "rule": "ابعاد عکس خوانده نشد → اسلاید (پیش‌فرض عکس)"}
    if _near(w, h, 9, 16):
        return {"kind": "story", "rule": "عکس تکی ۹:۱۶ → استوری"}
    if _near(w, h, 4, 5):
        return {"kind": "slide", "rule": "عکس ۴:۵ → اسلاید"}
    if _near(w, h, 1, 1):
        return {"kind": "slide", "rule": "عکس ۱:۱ → اسلاید"}
    return {"kind": "slide", "rule": "عکس با نسبت دیگر → اسلاید (پیش‌فرض عکس)"}


def classify_video(f, story=False):
    w, h, d = f.get("w") or 0, f.get("h") or 0, f.get("dur") or 0
    if not w or not h:
        return {"kind": "video", "rule": "ابعاد ویدئو خوانده نشد → ویدئو"}
    if story and 0 < d <= 60:
        return {"kind": "story", "rule": "ویدئوی تا ۶۰ ثانیه با علامت «استوری» → استوری"}
    if w > h:
        return {"kind": "video", "rule": "ویدئوی افقی → ویدئو"}
    v916 = _near(w, h, 9, 16)
    if v916 and 0 < d <= 15:
        return {"kind": "story", "rule": "ویدئوی ۹:۱۶ تا ۱۵ ثانیه → پیشنهاد: استوری (یا ریل)", "suggest": True}
    if 0 < d <= 90:
        return {"kind": "reel", "rule": "ویدئوی عمودی ۹:۱۶ تا ۹۰ ثانیه → ریل" if v916 else "ویدئوی عمودی/مربعی تا ۹۰ ثانیه → ریل"}
    return {"kind": "video", "rule": "ویدئوی بلندتر از ۹۰ ثانیه → ویدئو" if d > 90 else "مدت ویدئو خوانده نشد → ویدئو"}


def classify_upload(files, story=False):
    out = []
    imgs = [i for i, f in enumerate(files) if f.get("type") == "image"]
    if len(imgs) > 1:
        out.append({"files": imgs, "kind": "slide", "rule": f"چند عکس در یک بارگذاری ({str(len(imgs)).translate(FA_DIGITS)} عکس) → اسلاید", "suggest": False})
    elif len(imgs) == 1:
        c = classify_image(files[imgs[0]])
        out.append({"files": imgs, "kind": c["kind"], "rule": c["rule"], "suggest": False})
    for i, f in enumerate(files):
        if f.get("type") == "video":
            v = classify_video(f, story)
            out.append({"files": [i], "kind": v["kind"], "rule": v["rule"], "suggest": bool(v.get("suggest"))})
    return out
