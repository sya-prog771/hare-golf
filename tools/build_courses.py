"""OpenStreetMap から都道府県別のゴルフ場一覧を取得し courses/XX.json に保存する。
GitHub Actions から実行する（.github/workflows/update-courses.yml）。"""
import functools, json, os, re, sys, time, urllib.parse, urllib.request

print = functools.partial(print, flush=True)  # noqa: A001  ログをすぐ出す

ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]
EXCLUDE = re.compile(r"(練習場|打ちっぱなし|打ちっ放し|パークゴルフ|グラウンドゴルフ|グランドゴルフ|ミニゴルフ|パターゴルフ|インドア|シミュレーション|driving range)", re.I)


PREF_NAMES = "北海道 青森県 岩手県 宮城県 秋田県 山形県 福島県 茨城県 栃木県 群馬県 埼玉県 千葉県 東京都 神奈川県 新潟県 富山県 石川県 福井県 山梨県 長野県 岐阜県 静岡県 愛知県 三重県 滋賀県 京都府 大阪府 兵庫県 奈良県 和歌山県 鳥取県 島根県 岡山県 広島県 山口県 徳島県 香川県 愛媛県 高知県 福岡県 佐賀県 長崎県 熊本県 大分県 宮崎県 鹿児島県 沖縄県".split()


def query(pref, by_name=False):
    area = (f'area["name"="{PREF_NAMES[int(pref) - 1]}"]["admin_level"="4"]' if by_name
            else f'area["ISO3166-2"="JP-{pref}"]["admin_level"="4"]')
    q = (f'[out:json][timeout:180];{area}->.a;'
         '(way["leisure"="golf_course"](area.a);relation["leisure"="golf_course"](area.a);'
         'node["leisure"="golf_course"](area.a););out center tags;')
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
        if not name or EXCLUDE.search(name):
            continue
        lat = e.get("lat", e.get("center", {}).get("lat"))
        lon = e.get("lon", e.get("center", {}).get("lon"))
        if lat is None or lon is None:
            continue
        if name in by:
            o = by[name]
            o["lat"] = (o["lat"] * o["n"] + lat) / (o["n"] + 1)
            o["lon"] = (o["lon"] * o["n"] + lon) / (o["n"] + 1)
            o["n"] += 1
        else:
            by[name] = {"name": name, "lat": lat, "lon": lon, "n": 1}
    out = [{"name": o["name"], "lat": round(o["lat"], 4), "lon": round(o["lon"], 4)} for o in by.values()]
    return sorted(out, key=lambda o: o["name"])


def main():
    os.makedirs("courses", exist_ok=True)
    failed = []
    only = os.environ.get("PREFS", "").split()
    for i in range(1, 48):
        pref = f"{i:02d}"
        if only and pref not in only:
            continue
        try:
            courses = parse(query(pref))
            if not courses:  # ISO コードが付いていない県は名前で探す
                courses = parse(query(pref, by_name=True))
        except Exception as e:  # noqa: BLE001
            print(f"FAILED {pref}: {e}", file=sys.stderr)
            failed.append(pref)
            continue
        if not courses:
            print(f"EMPTY {pref}, keep old file", file=sys.stderr)
            continue
        with open(f"courses/{pref}.json", "w", encoding="utf-8") as f:
            json.dump(courses, f, ensure_ascii=False, separators=(",", ":"))
        print(f"{pref}: {len(courses)}")
        time.sleep(5)
    if len(failed) > 10:
        sys.exit(f"too many failures: {failed}")


if __name__ == "__main__":
    main()
