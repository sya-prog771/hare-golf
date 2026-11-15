"""OpenStreetMap から都道府県別のゴルフ場一覧を取得し courses/XX.json に保存する。
GitHub Actions から実行する（.github/workflows/update-courses.yml）。"""
import functools, json, os, re, sys, time, urllib.parse, urllib.request

print = functools.partial(print, flush=True)  # noqa: A001  ログをすぐ出す

ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]
# 名前でコースか練習場かを見分ける
HARD = re.compile(r"(練習|打ちっぱなし|打ちっ放し|ターゲットバード|パークゴルフ|グラウンド・?ゴルフ|グランドゴルフ|グラウンド•ゴルフ|ground golf|マレット|ゲートボール|GOLFERS24|ドライビングレンジ|driving range|打席|ミニゴルフ|パターゴルフ|インドア|シミュレーション|シミュレーター|ゴルフスタジオ|golf studio|ゴルフスペース|ゴルフパートナー|ステップゴルフ|SMART GOLF|Round1|Asobi-bar)", re.I)
COURSE = re.compile(r"(カントリー|ＣＣ|(?<![A-Z])CC|C\.C|倶楽部|俱楽部|ゴルフコース|Golf Course|Golf Club|リンクス|Links|ＧＣ|(?<![A-Z])GC|G\.C|ゴルフリゾート|ゴルフ[&＆]リゾート|Golf ?[&＆] ?Resort|Course|コース|ゴルフクラブ)", re.I)
RANGE = re.compile(r"(ゴルフセンター|Gセンター|Golf ?Center|ガーデン|GARDEN|プラザ|PLAZA|レンジ|レインジ|RANGE|ドーム|広場|ゴルフパーク|GOLF PARK|ゴルフランド|ロングゴルフ|ゴルフレーン|LANE|スイング|SWING|24|ゴルフビレッジ|スタジアム|グリーンゴルフ|ゴルフ$|GOLF$|Golf$)", re.I)
def is_course(name):
    if HARD.search(name): return False
    if COURSE.search(name): return True
    if RANGE.search(name): return False
    return True


def bbox_km2(b):
    """バウンディングボックスのおおよその面積（km²）"""
    import math
    h = (b["maxlat"] - b["minlat"]) * 111.0
    w = (b["maxlon"] - b["minlon"]) * 111.0 * math.cos(math.radians((b["maxlat"] + b["minlat"]) / 2))
    return h * w


MIN_COURSE_KM2 = 0.1   # これより狭いものは練習場とみなす
RESCUE_KM2 = 0.4       # 名前が練習場っぽくても、これより広ければコース


PREF_NAMES = "北海道 青森県 岩手県 宮城県 秋田県 山形県 福島県 茨城県 栃木県 群馬県 埼玉県 千葉県 東京都 神奈川県 新潟県 富山県 石川県 福井県 山梨県 長野県 岐阜県 静岡県 愛知県 三重県 滋賀県 京都府 大阪府 兵庫県 奈良県 和歌山県 鳥取県 島根県 岡山県 広島県 山口県 徳島県 香川県 愛媛県 高知県 福岡県 佐賀県 長崎県 熊本県 大分県 宮崎県 鹿児島県 沖縄県".split()


def query(pref, by_name=False):
    area = (f'area["name"="{PREF_NAMES[int(pref) - 1]}"]["admin_level"="4"]' if by_name
            else f'area["ISO3166-2"="JP-{pref}"]["admin_level"="4"]')
    q = (f'[out:json][timeout:180];{area}->.a;'
         '(way["leisure"="golf_course"](area.a);relation["leisure"="golf_course"](area.a);'
         'node["leisure"="golf_course"](area.a););out bb tags;')
    data = urllib.parse.urlencode({"data": q}).encode()
    last = None
    for attempt in range(3):
        for ep in ENDPOINTS:
            try:
                req = urllib.request.Request(ep, data=data, headers={"User-Agent": "hare-golf-course-builder"})
                with urllib.request.urlopen(req, timeout=150) as r:
                    return json.load(r)["elements"]
            except Exception as e:  # noqa: BLE001
                last = e
                print(f"  {pref} {ep}: {e}", file=sys.stderr)
                time.sleep(10)
        time.sleep(20 * (attempt + 1))
    raise RuntimeError(f"{pref}: {last}")


def parse(els):
    by = {}
    for e in els:
        t = e.get("tags", {})
        name = (t.get("name:ja") or t.get("name") or "").strip()
        if not name or t.get("golf") == "driving_range":
            continue
        bb = e.get("bounds")
        lat = e.get("lat", (bb["minlat"] + bb["maxlat"]) / 2 if bb else None)
        lon = e.get("lon", (bb["minlon"] + bb["maxlon"]) / 2 if bb else None)
        if lat is None or lon is None:
            continue
        area = bbox_km2(bb) if bb else None
        if name in by:
            o = by[name]
            o["lat"] = (o["lat"] * o["n"] + lat) / (o["n"] + 1)
            o["lon"] = (o["lon"] * o["n"] + lon) / (o["n"] + 1)
            o["n"] += 1
            if area is not None:
                o["area"] = (o["area"] or 0) + area
        else:
            by[name] = {"name": name, "lat": lat, "lon": lon, "n": 1, "area": area}
    out = []
    for o in by.values():
        name, area = o["name"], o["area"]
        if HARD.search(name):
            continue
        if is_course(name):
            if area is not None and area < MIN_COURSE_KM2:
                continue
        elif area is None or area < RESCUE_KM2:
            continue
        out.append({"name": name, "lat": round(o["lat"], 4), "lon": round(o["lon"], 4)})
    return sorted(out, key=lambda o: o["name"])


WIKIDATA_Q = """
SELECT ?g ?label ?coord ?iso WHERE {
  ?g wdt:P31/wdt:P279* wd:Q1048525 ; wdt:P17 wd:Q17 ; wdt:P625 ?coord .
  OPTIONAL { ?g wdt:P131* ?p . ?p wdt:P31 wd:Q50337 ; wdt:P300 ?iso . }
  ?g rdfs:label ?label . FILTER(LANG(?label) = "ja")
}"""


def wikidata():
    """Wikidata の日本のゴルフ場（名前・座標・都道府県）"""
    url = "https://query.wikidata.org/sparql?format=json&query=" + urllib.parse.quote(WIKIDATA_Q)
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "hare-golf-course-builder (github.com/sya-prog771/hare-golf)",
                                                       "Accept": "application/sparql-results+json"})
            with urllib.request.urlopen(req, timeout=180) as r:
                rows = json.load(r)["results"]["bindings"]
            break
        except Exception as e:  # noqa: BLE001
            print(f"wikidata retry: {e}")
            time.sleep(30)
    else:
        return {}
    by = {}
    for b in rows:
        name = b["label"]["value"].strip()
        m = re.match(r"Point\(([-0-9.]+) ([-0-9.]+)\)", b["coord"]["value"])
        iso = b.get("iso", {}).get("value", "")
        if not m or not iso.startswith("JP-") or HARD.search(name):
            continue
        by.setdefault(iso[3:], {})[b["g"]["value"]] = {"name": name, "lat": round(float(m.group(2)), 4), "lon": round(float(m.group(1)), 4)}
    out = {k: list(v.values()) for k, v in by.items()}
    print("wikidata:", sum(len(v) for v in out.values()))
    return out


def dist_km(a, b):
    import math
    dy = (a["lat"] - b["lat"]) * 111.0
    dx = (a["lon"] - b["lon"]) * 111.0 * math.cos(math.radians(a["lat"]))
    return (dx * dx + dy * dy) ** 0.5


def merge(primary, extra):
    """Wikidata を優先し、1km以内に同じゴルフ場がない OSM のものを足す"""
    out = list(primary)
    for c in extra:
        if all(dist_km(c, p) > 1.0 for p in out):
            out.append(c)
    return sorted(out, key=lambda o: o["name"])


def main():
    os.makedirs("courses", exist_ok=True)
    wd = wikidata()
    failed = []
    only = os.environ.get("PREFS", "").split()
    for i in range(1, 48):
        pref = f"{i:02d}"
        if only and pref not in only:
            continue
        try:
            osm = parse(query(pref))
            if not osm:  # ISO コードが付いていない県は名前で探す
                osm = parse(query(pref, by_name=True))
        except Exception as e:  # noqa: BLE001
            print(f"FAILED {pref}: {e}")
            failed.append(pref)
            osm = None
        if osm is None and not wd.get(pref):
            continue
        courses = merge(wd.get(pref, []), osm or [])
        if osm is None and os.path.exists(f"courses/{pref}.json"):  # OSM が取れなければ前回分と合わせる
            courses = merge(courses, json.load(open(f"courses/{pref}.json", encoding="utf-8")))
        with open(f"courses/{pref}.json", "w", encoding="utf-8") as f:
            json.dump(courses, f, ensure_ascii=False, separators=(",", ":"))
        print(f"{pref}: {len(courses)} (wikidata {len(wd.get(pref, []))}, osm {len(osm) if osm is not None else '-'})")
        time.sleep(5)
    if len(failed) > 10:
        sys.exit(f"too many failures: {failed}")


if __name__ == "__main__":
    main()
