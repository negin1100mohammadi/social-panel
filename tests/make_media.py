"""Test media for tests/v8.test.js: images (Pillow) + VP8 webm clips (ffmpeg; Chromium has no H.264).
usage: python tests/make_media.py <out_dir>"""
import os, subprocess, sys
from PIL import Image
out = sys.argv[1]
os.makedirs(out, exist_ok=True)
for i, (n, (w, h)) in enumerate({"img45.jpg": (400, 500), "img45b.jpg": (400, 500), "img11.png": (300, 300), "img916.jpg": (360, 640), "imgH.jpg": (600, 400)}.items()):
    Image.new("RGB", (w, h), (120, 60 + 30 * i, 200)).save(os.path.join(out, n))
for n, size, d in [("v916_10", "180x320", 10), ("v916_40", "180x320", 40), ("vH_20", "320x180", 20), ("v916_120", "180x320", 120)]:
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"testsrc=size={size}:rate=5", "-t", str(d), "-c:v", "libvpx", "-b:v", "50k",
                    os.path.join(out, n + ".webm")], check=True)
print("ok")
