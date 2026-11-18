"""都道府県別のゴルフ場（コース）一覧 courses/XX.json を作る。

材料
- 国税庁「評価倍率表（ゴルフ場用地等用）」: 課税用の公的な一覧。練習場やミニゴルフは含まれない。
  多くの県はゴルフ場名まで載っているが、北海道・兵庫県などは市町村名だけ。
- OpenStreetMap（地図データ）: leisure=golf_course。取得できたら tools/osm_snapshot に保存し、
  取得できなければ保存済みのスナップショットを使う。
- Wikipedia: 都道府県別カテゴリにあるゴルフ場の記事（座標つき）。tools/wikipedia_snapshot.json に保存。
  取得に時間がかかるため、REFRESH_WIKIPEDIA=1 のときだけ取り直す。
- 国土地理院の住所検索: 市町村の位置と、一部のゴルフ場名の位置。

位置は、地図データ・Wikipedia・国土地理院に同じ名前があればその場所、なければ所在市町村の位置
（approx=1）を使う。
出力: courses/XX.json  [{"name","lat","lon","city"?,"approx"?}]
"""
import functools, io, json, math, os, re, sys, time, unicodedata, urllib.error, urllib.parse, urllib.request

print = functools.partial(print, flush=True)  # noqa: A001

TOP = "https://www.rosenka.nta.go.jp/"
PREF_NAMES = "北海道 青森県 岩手県 宮城県 秋田県 山形県 福島県 茨城県 栃木県 群馬県 埼玉県 千葉県 東京都 神奈川県 新潟県 富山県 石川県 福井県 山梨県 長野県 岐阜県 静岡県 愛知県 三重県 滋賀県 京都府 大阪府 兵庫県 奈良県 和歌山県 鳥取県 島根県 岡山県 広島県 山口県 徳島県 香川県 愛媛県 高知県 福岡県 佐賀県 長崎県 熊本県 大分県 宮崎県 鹿児島県 沖縄県".split()
HERE = os.path.dirname(os.path.abspath(__file__))
UA = "hare-golf-course-builder/1.0"

# 練習場・屋内・ミニゴルフ・ショートコースなど、ふつうのラウンドができないもの
HARD = re.compile(r"(練習|打ちっぱなし|打ちっ放し|ターゲットバード|パークゴルフ|グラウンド・?ゴルフ|グランドゴルフ|マレット|ゲートボール|"
                  r"GOLFERS24|ドライビングレンジ|driving range|ミニゴルフ|パターゴルフ|インドア|シミュレーション|シミュレーター|"
                  r"ゴルフスタジオ|golf studio|ステップゴルフ|SMART GOLF|ゼロカラ|ライザップ|ショートコース|ショート|"
                  r"跡$|跡地|基地|閉鎖|閉場|ゴルフスクール|ゴルフ[・ ]?アカデミー|ゴルフスペース|ゴルフパートナー|Round1)", re.I)
# ゴルフ場（クラブ・コース）であることがはっきりしている言葉
CLUB = re.compile(r"(カントリー|カンツリー|ＣＣ|(?<![A-Z])CC|C\.C|倶楽部|俱楽部|ゴルフコース|Golf Course|Golf Club|Country Club|リンクス|Links|"
                  r"ＧＣ|(?<![A-Z])GC|G\.C|ゴルフクラブ|ゴルフ場|ゴルフリゾート|ゴルフ ?[&＆] ?リゾート)", re.I)
# ゴルフ場らしい言葉（国税庁の表の「名前の欄」に書かれた地域の説明などと区別する）
GOLFISH = re.compile(r"(ゴルフ|カントリー|カンツリー|倶楽部|俱楽部|クラブ|ＣＣ|CC|ＧＣ|GC|コース|リンクス|golf|links|club)", re.I)
# 練習場・公園などに多い言葉（はっきりしたクラブ名がなければ除く）
RANGEISH = re.compile(r"(センター|ガーデン|GARDEN|プラザ|PLAZA|アリーナ|ドーム|レンジ|レインジ|RANGE|SWING|スイング|パーク|PARK|広場|"
                      r"ランド|レーン|LANE|スタジアム|ビレッジ|24|ゴルフ$|GOLF$|Golf$)", re.I)
DESCRIPTOR = re.compile(r"(上記以外|以外|の[東西南北]側|以[東西南北]|大字|字|号線|線の|地区|区域|地域|高原$|町$|^河川敷)")


def get(url, tries=4, headers=None):
    last = None
    for t in range(tries):
        try:
            req = urllib.request.Request(url, headers=headers or {"User-Agent": "Mozilla/5.0 (" + UA + ")"})
            with urllib.request.urlopen(req, timeout=90) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(5 * (t + 1))
    raise RuntimeError(f"{url}: {last}")


def nfkc(s):
    return unicodedata.normalize("NFKC", s or "").strip()


# ---------------------------------------------------------------- 名前の整形・比較

def clean_name(name):
    """表や地図データの名前の崩れを直す"""
    s = nfkc(name).replace("\n", "")
    s = re.sub(r"^(?:[(（]?\d{1,2}[)）.]|[①-⑳]|\d{1,2}\s)\s*", "", s)              # 先頭の番号 「1 」「(2)」
    m = re.match(r"^([A-Za-z0-9 .,'&\-]+)\s*[(（]([^)）]*[ぁ-んァ-ヶ一-龠][^)）]*)[)）]$", s)  # 英語名 (日本語名)
    if m:
        s = m.group(2)
    s = re.sub(r"\s*[(（][A-Za-z][^)）]*[)）]\s*$", "", s)                            # 日本語名 (英語名)
    s = re.sub(r"\s*【[^】]*】", "", s)
    s = re.sub(r"\s*[(（](旧[^)）]*|[^)）]*[市町村区]|ゴルフ場)[)）]", "", s)                 # (旧〇〇) (八王子市)                                                 # 【PGM】など
    s = re.sub(r"[\s　]+", " ", s).strip(" 、,")
    return s


def norm(s):
    s = unicodedata.normalize("NFKC", s).lower().replace("俱", "倶").replace("カンツリー", "カントリー")
    s = re.sub(r"[\s・･\-‐–_/,.、。]", "", s)
    s = re.sub(r"(?<=[一-龠])[がガケヶヵ](?=[一-龠])", "ケ", s)  # 竜ヶ崎・竜ケ崎・桜が丘
    for a, b in [("カントリークラブ", "cc"), ("カントリー倶楽部", "cc"), ("カントリーclub", "cc"), ("country club", "cc"),
                 ("c.c.", "cc"), ("c.c", "cc"), ("ゴルフクラブ", "gc"), ("ゴルフ倶楽部", "gc"), ("golf club", "gc"),
                 ("g.c.", "gc"), ("g.c", "gc"), ("ゴルフ場", ""), ("ゴルフコース", "gc"), ("golf course", "gc")]:
        s = s.replace(a, b)
    return re.sub(r"[\s・･\-‐ー–_/()（）「」『』,.、。&＆]", "", s)


def core(s):
    """名前から「カントリークラブ」などを除いた中心部分"""
    return re.sub(r"(cc|gc|カントリー|ゴルフ|倶楽部|クラブ|club|コース|course|リゾート|resort|ゴルフ場)", "", norm(s)) or norm(s)


def base_name(s):
    """「〇〇ゴルフ場 西コース」→「〇〇ゴルフ場」（同じクラブの別コースをまとめる）"""
    s = clean_name(s)
    b = re.sub(r"[\s　]*[^\s　]{0,10}コース$", "", s)
    b = re.sub(r"[\s　]+(東|西|南|北|イン|アウト|[A-Za-z]+|[^\s　]{1,6}(コース|C))$", "", b)
    return b if b != s and CLUB.search(b) else s


def is_course_name(name):
    """地図データの名前がゴルフ場（コース）らしいか"""
    if not name or HARD.search(name) or len(core(name)) < 2:
        return False
    strong = CLUB.search(name) or re.search(r"(クラブ|倶楽部|コース|\bgolf\b)", name, re.I)
    if not strong:
        return False
    if RANGEISH.search(name) and not re.search(r"(カントリー|カンツリー|倶楽部|ゴルフクラブ|CC|GC|ゴルフコース|リンクス|ゴルフ場|コース)", name):
        return False
    return True


def dist_km(a, b):
    dy = (a[0] - b[0]) * 111.0
    dx = (a[1] - b[1]) * 111.0 * math.cos(math.radians(a[0]))
    return (dx * dx + dy * dy) ** 0.5


def same_course(a, b, near_km=1.2):
    """同じゴルフ場か（名前と位置で判断）"""
    pa, pb = (a["lat"], a["lon"]), (b["lat"], b["lon"])
    d = dist_km(pa, pb)
    na, nb = norm(a["name"]), norm(b["name"])
    ca, cb = core(a["name"]), core(b["name"])
    if na == nb or (len(ca) >= 2 and ca == cb):
        return d < 40
    if norm(base_name(a["name"])) == norm(base_name(b["name"])):
        return d < 6
    if d < near_km and not (a.get("approx") or b.get("approx")):
        return True
    short, long_ = sorted((ca, cb), key=len)
    return len(short) >= 3 and short in long_ and d < (25 if a.get("approx") or b.get("approx") else 8)


# ---------------------------------------------------------------- 国税庁の表

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
            if p in text:
                out[p] = TOP + href
    for href, y, _ in links:  # 北海道はリンク文字が長文なので URL で判定
        if int(y) == latest and "/hokkaido/" in href:
            out["北海道"] = TOP + href
    return out


def golf_rows(pref_url):
    """表から (市町村 or None, ゴルフ場名) を取り出す。名前のない市町村は名前 ''。"""
    import pdfplumber

    h = get(pref_url).decode("cp932", "replace")
    m = re.search(r'others/(\w\d{2})0200\.htm', h)
    if not m:
        return []
    page = urllib.parse.urljoin(pref_url, f"others/{m.group(1)}0200.htm")
    hh = get(page).decode("cp932", "replace")
    rows = []
    for pdf_href in sorted(set(re.findall(r'href="([^"]+\.pdf)"', hh))):
        data = get(urllib.parse.urljoin(page, pdf_href))
        with pdfplumber.open(io.BytesIO(data)) as pdf:
            for pg in pdf.pages:
                for tb in pg.extract_tables():
                    rows += table_rows(tb)
    return rows


def table_rows(tb):
    """評価倍率表の1つの表から (市町村, 名前) を取り出す。
    5〜6列: [音順, 市町村, (地区), 種類, 名前..., 倍率]  3列: [音順, 名前, 倍率]（市街化区域の表）"""
    out, muni = [], None
    cells_rows = [[nfkc(c).replace("\n", "") for c in r] for r in tb]
    if not cells_rows:
        return out
    ncol = len(cells_rows[0])
    for r in cells_rows[1:]:
        if len(r) != ncol:
            continue
        if ncol == 3:
            for nm in split_names(r[1]):
                out.append((None, nm))
            continue
        if r[1]:
            muni = re.sub(r"\s+", "", r[1])
            if muni.startswith("上記以外"):
                muni = None
                continue
            out.append((muni, ""))  # この市町村にゴルフ場がある印
        if not muni:
            continue
        for cell in r[2:-1]:
            if re.search(r"(用地|^上記以外$)", cell) or not cell:
                continue
            for nm in split_names(cell):
                out.append((muni, nm))
    return out


def split_names(cell):
    """「1 Aゴルフ倶楽部、Bカントリークラブ」→ [A..., B...]。地域の説明や「上記以外」は除く"""
    cell = re.sub(r"^(?:[(（]?\d{1,2}[)）.]?\s*)", "", nfkc(cell))
    out = []
    for part in re.split(r"[、,]", cell):
        nm = clean_name(part)
        if len(nm) < 3 or not GOLFISH.search(nm) or HARD.search(nm):
            continue
        if DESCRIPTOR.search(nm) and not CLUB.search(nm):
            continue
        out.append(nm)
    return out


# ---------------------------------------------------------------- 位置

_geo = {}


def gsi(query):
    try:
        js = json.loads(get("https://msearch.gsi.go.jp/address-search/AddressSearch?q=" + urllib.parse.quote(query), tries=2))
    except Exception as e:  # noqa: BLE001
        print(f"  gsi {query}: {e}")
        return []
    time.sleep(0.2)
    return js


def geocode(pref, muni):
    """市町村（＋地区）の位置"""
    q = pref + muni
    if q in _geo:
        return _geo[q]
    res = None
    for query in (q, pref + re.split(r"(?<=[市町村区])", muni)[0]):
        js = gsi(query)
        hit = [h for h in js if h["properties"]["title"].startswith(pref)]
        if hit:
            lon, lat = hit[0]["geometry"]["coordinates"]
            res = (round(lat, 4), round(lon, 4))
            break
    _geo[q] = res
    return res


def gsi_course(name, center):
    """国土地理院の地名にゴルフ場名があれば、その位置"""
    want = core(name)
    if len(want) < 2:
        return None
    for h in gsi(name):
        title = h["properties"]["title"]
        if any(title.startswith(p) for p in PREF_NAMES):
            continue  # 住所の一致は使わない
        t = core(title)
        if t and (t == want or (len(t) >= 3 and (t in want or want in t))):
            lon, lat = h["geometry"]["coordinates"]
            if center is None or dist_km(center, (lat, lon)) < 40:
                return round(lat, 4), round(lon, 4)
    return None


# ---------------------------------------------------------------- 地図データ（OpenStreetMap）

OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"]


def osm_fetch(code):
    """Overpass で県内の leisure=golf_course を取る。名前つきで、狭すぎるもの（練習場）は除く"""
    pref = PREF_NAMES[int(code) - 1]
    for area in (f'area["ISO3166-2"="JP-{code}"]["admin_level"="4"]', f'area["name"="{pref}"]["admin_level"="4"]'):
        q = (f'[out:json][timeout:180];{area}->.a;(way["leisure"="golf_course"](area.a);'
             'relation["leisure"="golf_course"](area.a);node["leisure"="golf_course"](area.a););out bb tags;')
        els = None
        for ep in OVERPASS:
            try:
                req = urllib.request.Request(ep, data=urllib.parse.urlencode({"data": q}).encode(), headers={"User-Agent": UA})
                with urllib.request.urlopen(req, timeout=200) as r:
                    els = json.load(r)["elements"]
                break
            except Exception as e:  # noqa: BLE001
                print(f"  osm {code} {ep}: {e}")
                time.sleep(10)
        if els is None:
            return None
        if els:
            break
    by = {}
    for e in els:
        t = e.get("tags", {})
        name = clean_name(t.get("name:ja") or t.get("name") or "")
        if not name or t.get("golf") == "driving_range" or HARD.search(name):
            continue
        bb = e.get("bounds")
        lat = e.get("lat", (bb["minlat"] + bb["maxlat"]) / 2 if bb else None)
        lon = e.get("lon", (bb["minlon"] + bb["maxlon"]) / 2 if bb else None)
        if lat is None or lon is None:
            continue
        km2 = None
        if bb:
            km2 = ((bb["maxlat"] - bb["minlat"]) * 111.0) * ((bb["maxlon"] - bb["minlon"]) * 111.0 * math.cos(math.radians(lat)))
        o = by.setdefault(name, {"name": name, "lat": 0, "lon": 0, "n": 0, "km2": 0})
        o["lat"] = (o["lat"] * o["n"] + lat) / (o["n"] + 1)
        o["lon"] = (o["lon"] * o["n"] + lon) / (o["n"] + 1)
        o["n"] += 1
        o["km2"] += km2 or 0
    out = [{"name": o["name"], "lat": round(o["lat"], 4), "lon": round(o["lon"], 4)}
           for o in by.values() if o["km2"] == 0 or o["km2"] >= 0.1]
    return sorted(out, key=lambda o: o["name"])


def osm_list(code):
    path = os.path.join(HERE, "osm_snapshot", f"{code}.json")
    snap = json.load(open(path, encoding="utf-8")) if os.path.exists(path) else []
    if os.environ.get("SKIP_OSM") != "1":
        fresh = osm_fetch(code)
        if fresh and len(fresh) >= 0.8 * len(snap):
            with open(path, "w", encoding="utf-8") as f:
                json.dump(fresh, f, ensure_ascii=False, separators=(",", ":"))
            snap = fresh
        elif fresh is not None:
            print(f"  osm {code}: 取得 {len(fresh)}件がスナップショット {len(snap)}件より少ないので使わない")
    for o in snap:
        o["name"] = clean_name(o["name"])
    return snap


# ---------------------------------------------------------------- Wikipedia

WP_API = "https://ja.wikipedia.org/w/api.php"
WP_SNAPSHOT = os.path.join(HERE, "wikipedia_snapshot.json")


def wp_query(**p):
    p.update(format="json", formatversion=2, maxlag=5)
    for t in range(8):
        try:
            req = urllib.request.Request(WP_API + "?" + urllib.parse.urlencode(p), headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=60) as r:
                time.sleep(1)
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code not in (429, 503):
                raise
            wait = int(e.headers.get("Retry-After") or 0) or 30 * (t + 1)
            time.sleep(min(wait, 120))
    raise RuntimeError("Wikipedia: rate limited")


def wp_members(cat, typ):
    out, cont = [], {}
    while True:
        js = wp_query(action="query", list="categorymembers", cmtitle=cat, cmtype=typ, cmlimit=500, **cont)
        out += js["query"]["categorymembers"]
        if "continue" not in js:
            return out
        cont = js["continue"]


def wikipedia():
    """{県コード: [{"name","lat","lon"}]}。取れなければ前回の保存分"""
    old = json.load(open(WP_SNAPSHOT, encoding="utf-8")) if os.path.exists(WP_SNAPSHOT) else {}
    if os.environ.get("REFRESH_WIKIPEDIA") != "1":  # 取得に時間がかかるので、ふだんは保存分を使う
        return old
    try:
        res = {}
        for c in wp_members("Category:日本のゴルフ場 (都道府県別)", "subcat"):
            pref = next((p for p in PREF_NAMES if c["title"].startswith("Category:" + p)), None)
            if not pref:
                continue
            code = f"{PREF_NAMES.index(pref) + 1:02d}"
            titles = [p["title"] for p in wp_members(c["title"], "page")]
            for i in range(0, len(titles), 50):
                js = wp_query(action="query", prop="coordinates", titles="|".join(titles[i:i + 50]), colimit=500)
                for p in js["query"]["pages"]:
                    co = p.get("coordinates")
                    name = clean_name(re.sub(r"\s*\(.*?\)$", "", p["title"]))
                    if co and not HARD.search(name):
                        res.setdefault(code, []).append({"name": name, "lat": round(co[0]["lat"], 4), "lon": round(co[0]["lon"], 4)})
        if sum(len(v) for v in res.values()) >= 0.8 * sum(len(v) for v in old.values()):
            with open(WP_SNAPSHOT, "w", encoding="utf-8") as f:
                json.dump(res, f, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
            print("wikipedia:", sum(len(v) for v in res.values()))
            return res
    except Exception as e:  # noqa: BLE001
        print(f"wikipedia: {e}（前回分を使う）")
    return old


# ---------------------------------------------------------------- 組み立て

def build(pref_idx, pref_url, wp):
    pref = PREF_NAMES[pref_idx - 1]
    code = f"{pref_idx:02d}"
    osm = [o for o in osm_list(code) if not HARD.search(o["name"])]
    wiki = wp.get(code, [])
    rows = golf_rows(pref_url) if pref_url else []
    named = [(m, n) for m, n in rows if n]
    out = []

    def add(c, official=False):
        for o in out:
            # 国税庁の表どうしは別のゴルフ場（名前が同じときだけまとめる）
            if (norm(o["name"]) == norm(c["name"])) if official else same_course(o, c):
                if o.get("approx") and not c.get("approx"):  # 位置がおおよそなら、正確な方で置きかえる
                    o.update(lat=c["lat"], lon=c["lon"])
                    o.pop("approx", None)
                return False
        out.append(c)
        return True

    # 1) 国税庁の表のゴルフ場（公的な一覧なので、名前はこちらを使う）
    if len(named) >= 3:
        for muni, name in named:
            center = geocode(pref, muni) if muni else None
            pos = None
            for src in (osm, wiki):
                cn = core(name)
                cands = [o for o in src if len(core(o["name"])) >= 2 and (
                    norm(o["name"]) == norm(name) or core(o["name"]) == cn
                    or norm(base_name(o["name"])) == norm(name)
                    or (min(len(cn), len(core(o["name"]))) >= 3 and (cn in core(o["name"]) or core(o["name"]) in cn)))]
                if center:
                    cands = sorted((o for o in cands if dist_km(center, (o["lat"], o["lon"])) < 35),
                                   key=lambda o: dist_km(center, (o["lat"], o["lon"])))
                if cands:
                    pos = (cands[0]["lat"], cands[0]["lon"])
                    break
            pos = pos or gsi_course(name, center)
            c = {"name": name, "lat": None, "lon": None}
            if muni:
                c["city"] = muni
            if pos:
                c["lat"], c["lon"] = pos
            elif center:
                c["lat"], c["lon"], c["approx"] = center[0], center[1], 1
            else:
                continue
            add(c, official=True)
    nta = len(out)

    # 2) 表にないものを、地図データと Wikipedia の「コースらしい名前」で補う
    for src in (osm, wiki):
        for o in src:
            if is_course_name(o["name"]):
                nm = base_name(o["name"]) if src is osm else o["name"]
                add({"name": nm if len(core(nm)) >= 2 else o["name"], "lat": o["lat"], "lon": o["lon"]})
    return sorted(out, key=lambda c: c["name"]), {"rows": len(rows), "nta": nta, "total": len(out)}


def main():
    os.makedirs("courses", exist_ok=True)
    only = os.environ.get("PREFS", "").split()
    try:
        pages = pref_pages()
    except Exception as e:  # noqa: BLE001
        print(f"国税庁の目次を取得できません: {e}")
        pages = {}
    print("pages:", len(pages))
    wp = wikipedia()
    for i, pref in enumerate(PREF_NAMES, 1):
        code = f"{i:02d}"
        if only and code not in only:
            continue
        try:
            courses, st = build(i, pages.get(pref), wp)
        except Exception as e:  # noqa: BLE001
            print(f"FAILED {code} {pref}: {e}")
            continue
        old = f"courses/{code}.json"
        if os.path.exists(old) and len(courses) < 0.7 * len(json.load(open(old, encoding="utf-8"))):
            print(f"{code} {pref}: {len(courses)}か所しかないので前回分のまま")
            continue
        with open(old, "w", encoding="utf-8") as f:
            json.dump(courses, f, ensure_ascii=False, separators=(",", ":"))
        approx = sum(1 for c in courses if c.get("approx"))
        print(f"{code} {pref}: {len(courses)}か所（国税庁 {st['nta']}・位置が市町村単位 {approx}）")


if __name__ == "__main__":
    main()
