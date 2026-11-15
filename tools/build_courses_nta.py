"""国税庁「評価倍率表（ゴルフ場用地等用）」から都道府県別のゴルフ場（コース）一覧を作る。

- 国税庁の表は課税用の公的な一覧で、ゴルフ練習場やミニゴルフは含まれない。
- 位置は、地図データ（OpenStreetMap のスナップショット）に同じ名前があればその場所、
  なければ所在市町村の位置（国土地理院の住所検索）を使う。
- 表にゴルフ場名が書かれていない県（北海道など）は、これまでの地図データの一覧を使う。
出力: courses/XX.json  [{"name","lat","lon","city","approx"?}]
"""
import functools, io, json, math, os, re, sys, time, unicodedata, urllib.parse, urllib.request

import pdfplumber

print = functools.partial(print, flush=True)  # noqa: A001

TOP = "https://www.rosenka.nta.go.jp/"
PREF_NAMES = "北海道 青森県 岩手県 宮城県 秋田県 山形県 福島県 茨城県 栃木県 群馬県 埼玉県 千葉県 東京都 神奈川県 新潟県 富山県 石川県 福井県 山梨県 長野県 岐阜県 静岡県 愛知県 三重県 滋賀県 京都府 大阪府 兵庫県 奈良県 和歌山県 鳥取県 島根県 岡山県 広島県 山口県 徳島県 香川県 愛媛県 高知県 福岡県 佐賀県 長崎県 熊本県 大分県 宮崎県 鹿児島県 沖縄県".split()
HERE = os.path.dirname(os.path.abspath(__file__))
COURSE_WORD = re.compile(r"(カントリー|ＣＣ|(?<![A-Z])CC|C\.C|倶楽部|俱楽部|ゴルフコース|Golf Course|Golf Club|リンクス|Links|ＧＣ|(?<![A-Z])GC|G\.C|ゴルフクラブ)", re.I)
HARD = re.compile(r"(練習|打ちっぱなし|ターゲットバード|パークゴルフ|グラウンド・?ゴルフ|グランドゴルフ|マレット|ゲートボール|GOLFERS24|ドライビングレンジ|driving range|ミニゴルフ|パターゴルフ|インドア)", re.I)


def get(url, tries=4):
    last = None
    for t in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (hare-golf course list builder)"})
            with urllib.request.urlopen(req, timeout=90) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(5 * (t + 1))
    raise RuntimeError(f"{url}: {last}")


def pref_pages():
    """{都道府県名: その県の目次URL}（最新年分）"""
    h = get(TOP).decode("cp932", "replace")
    links = re.findall(r'href="(main_r(\d+)/[^"]+/pref_frm\.htm)"[^>]*>\s*([^<]+?)\s*<', h)
    latest = max(int(y) for _, y, _ in links)
    out = {}
    for href, y, text in links:
        if int(y) != latest:
            continue
        for p in PREF_NAMES:
            if p in text or (p == "北海道" and "北海道" in href.replace("hokkaido", "北海道")):
                out[p] = TOP + href
    # 北海道はリンク文字が長文なので URL で判定
    for href, y, _ in links:
        if int(y) == latest and "/hokkaido/" in href:
            out["北海道"] = TOP + href
    return out


def golf_rows(pref_url):
    """表から (市町村, ゴルフ場名) を取り出す。名前のない行は名前 ''。"""
    h = get(pref_url).decode("cp932", "replace")
    m = re.search(r'others/(\w\d{2})0200\.htm', h)
    if not m:
        return []
    page = urllib.parse.urljoin(pref_url, f"others/{m.group(1)}0200.htm")
    hh = get(page).decode("cp932", "replace")
    rows, muni = [], None
    for pdf_href in sorted(set(re.findall(r'href="([^"]+\.pdf)"', hh))):
        data = get(urllib.parse.urljoin(page, pdf_href))
        with pdfplumber.open(io.BytesIO(data)) as pdf:
            for pg in pdf.pages:
                for line in (pg.extract_text() or "").splitlines():
                    line = unicodedata.normalize("NFKC", line).strip()
                    a = re.match(r"^(?:[ぁ-ん]\s+)?(.+?)\s+ゴルフ場用地\s*(.*?)\s*(\d+(?:\.\d+)?|―|-|路線価|個別評価)?$", line)
                    if a and "ゴルフ場用地等" not in line:
                        muni = re.sub(r"\s+", "", a.group(1))
                        if muni in ("上記以外",):
                            continue
                        rows.append((muni, a.group(2).strip()))
                        continue
                    b = re.match(r"^(?:[ぁ-ん]\s+)?(.+?)\s+(\d+(?:\.\d+)?)$", line)
                    if b and muni and len(b.group(1)) < 60 and "ゴルフ場用地" not in line and not re.search(r"(次表|評価|倍率|算式|注|地積)", line):
                        rows.append((muni, b.group(1).strip()))
    return rows


def norm(s):
    s = unicodedata.normalize("NFKC", s).lower().replace("俱", "倶")
    for a, b in [("カントリークラブ", "cc"), ("カントリー倶楽部", "cc"), ("カントリーclub", "cc"), ("c.c.", "cc"), ("c.c", "cc"),
                 ("ゴルフクラブ", "gc"), ("ゴルフ倶楽部", "gc"), ("golf club", "gc"), ("g.c.", "gc"), ("g.c", "gc"), ("ゴルフ場", ""),
                 ("ゴルフコース", "gc"), ("golf course", "gc")]:
        s = s.replace(a, b)
    return re.sub(r"[\s・･\-‐ー–_/()（）「」『』,.、。&＆]", "", s)


def core(s):
    """名前から「カントリークラブ」などを除いた中心部分"""
    return re.sub(r"(cc|gc|カントリー|ゴルフ|倶楽部|クラブ|club|コース|course|リゾート|resort|ゴルフ場)", "", norm(s)) or norm(s)


JUNK = re.compile(r"(遊園地|上記以外|用地|^.{0,2}$)")


def dist_km(a, b):
    dy = (a[0] - b[0]) * 111.0
    dx = (a[1] - b[1]) * 111.0 * math.cos(math.radians(a[0]))
    return (dx * dx + dy * dy) ** 0.5


_geo = {}


def geocode(pref, muni):
    q = pref + muni
    if q in _geo:
        return _geo[q]
    res = None
    for query in (q, pref + re.split(r"(?<=[市町村区])", muni)[0]):
        try:
            js = json.loads(get("https://msearch.gsi.go.jp/address-search/AddressSearch?q=" + urllib.parse.quote(query)))
            if js:
                lon, lat = js[0]["geometry"]["coordinates"]
                res = (round(lat, 4), round(lon, 4))
                break
        except Exception as e:  # noqa: BLE001
            print(f"  geocode {query}: {e}")
        time.sleep(0.3)
    _geo[q] = res
    return res


def build(pref_idx, pref_url):
    pref = PREF_NAMES[pref_idx - 1]
    code = f"{pref_idx:02d}"
    osm = json.load(open(os.path.join(HERE, "osm_snapshot", f"{code}.json"), encoding="utf-8"))
    osm_n = [(norm(o["name"]), o) for o in osm]
    rows = golf_rows(pref_url)
    named = [(m, n) for m, n in rows if n and not HARD.search(n) and not JUNK.search(n)]
    if len(named) < 3:
        return None, len(rows)
    out, seen = [], set()
    for muni, name in named:
        key = norm(name)
        if key in seen:
            continue
        seen.add(key)
        center = geocode(pref, muni)
        base = norm(re.split(r"\s", name)[0]) if " " in name else key
        cands = [o for k, o in osm_n if len(k) >= 3 and (k == key or k == base or (len(base) >= 4 and (base in k or k in base))
                                                      or (len(core(name)) >= 2 and core(o["name"]) == core(name)))]
        if center:
            cands = [o for o in cands if dist_km(center, (o["lat"], o["lon"])) < 35]
            cands.sort(key=lambda o: dist_km(center, (o["lat"], o["lon"])))
        if cands:
            out.append({"name": name, "lat": cands[0]["lat"], "lon": cands[0]["lon"], "city": muni})
        elif center:
            out.append({"name": name, "lat": center[0], "lon": center[1], "city": muni, "approx": 1})
    # 表に名前が書かれていない市町村の分は、地図データのうち「コースらしい名前」のものを補う
    for o in osm:
        if COURSE_WORD.search(o["name"]) and not HARD.search(o["name"]) and \
                all(dist_km((o["lat"], o["lon"]), (c["lat"], c["lon"])) > 2 for c in out if not c.get("approx")) and \
                norm(o["name"]) not in seen and \
                all(core(o["name"]) != core(c["name"]) for c in out):
            out.append({"name": o["name"], "lat": o["lat"], "lon": o["lon"]})
            seen.add(norm(o["name"]))
    return sorted(out, key=lambda c: c["name"]), len(rows)


def main():
    os.makedirs("courses", exist_ok=True)
    pages = pref_pages()
    print("pages:", len(pages))
    only = os.environ.get("PREFS", "").split()
    for i, pref in enumerate(PREF_NAMES, 1):
        code = f"{i:02d}"
        if only and code not in only:
            continue
        if pref not in pages:
            print(f"{code} {pref}: 目次なし（前回分のまま）")
            continue
        try:
            courses, nrows = build(i, pages[pref])
        except Exception as e:  # noqa: BLE001
            print(f"FAILED {code} {pref}: {e}")
            continue
        if courses is None:
            print(f"{code} {pref}: 表に名前なし（{nrows}行）→ 前回分のまま")
            continue
        with open(f"courses/{code}.json", "w", encoding="utf-8") as f:
            json.dump(courses, f, ensure_ascii=False, separators=(",", ":"))
        approx = sum(1 for c in courses if c.get("approx"))
        print(f"{code} {pref}: {len(courses)}か所（位置が市町村単位 {approx}）")
        time.sleep(1)


if __name__ == "__main__":
    main()
