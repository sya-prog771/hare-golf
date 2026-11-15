import re, sys, urllib.request, urllib.parse, io
import pdfplumber
BASE="https://www.rosenka.nta.go.jp/main_r08/"
def get(u):
    with urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent":"Mozilla/5.0"}), timeout=60) as r: return r.read()
for pref in sys.argv[1:]:
    h=get(BASE+pref+"/pref_frm.htm").decode("cp932","replace")
    m=re.search(r'others/(\w\d{2})0200\.htm',h); code=m.group(1)
    hh=get(BASE+pref+f"/others/{code}0200.htm").decode("cp932","replace")
    pdfs=sorted(set(re.findall(r'href="([^"]+\.pdf)"',hh)))
    print("=====",pref,code,pdfs, re.sub(r"<[^>]+>|\s+"," ",hh)[600:900])
    for p in pdfs[:3]:
        u=urllib.parse.urljoin(BASE+pref+f"/others/{code}0200.htm",p)
        with pdfplumber.open(io.BytesIO(get(u))) as pdf:
            for pg in pdf.pages[:3]:
                t=pg.extract_text() or ""
                for line in t.splitlines():
                    if "ゴルフ" in line or "カントリー" in line or "倶楽部" in line or "クラブ" in line: print("  ",line)
