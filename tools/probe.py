import re, sys, urllib.request
def get(u):
    with urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent":"Mozilla/5.0"}), timeout=60) as r:
        b = r.read()
    for enc in ("utf-8", "shift_jis", "cp932"):
        try: return b.decode(enc)
        except Exception: pass
    return b.decode("utf-8", "replace")
for u in sys.argv[1:]:
    print("=====", u)
    try:
        h = get(u)
        for m in re.finditer(r'<a[^>]+href="([^"]+)"[^>]*>(.*?)</a>', h, re.S|re.I):
            print(m.group(1), "|", re.sub(r"<[^>]+>|\s+", " ", m.group(2)).strip()[:60])
    except Exception as e:
        print("ERR", e)
