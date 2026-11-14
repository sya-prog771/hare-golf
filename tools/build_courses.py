"""OpenStreetMap から都道府県別のゴルフ場一覧を取得し courses/XX.json に保存する。
GitHub Actions から実行する（.github/workflows/update-courses.yml）。"""
import json, os, re, sys, time, urllib.parse, urllib.request

ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]
EXCLUDE = re.compile(r"(練習場|打ちっぱなし|打ちっ放し|パークゴルフ|グラウンドゴルフ|グランドゴルフ|ミニゴルフ|パターゴルフ|インドア|シミュレーション|driving range)", re.I)


def query(pref):
    q = (f'[out:json][timeout:180];area["ISO3166-2"="JP-{pref}"]["admin_level"="4"]->.a;'
         '(way["leisure"="golf_course"](area.a);relation["leisure"="golf_course"](area.a);'
         'node["leisure"="golf_course"](area.a););out center tags;')
    data = urllib.parse.urlencode({"data": q}).encode()
    last = None
    for attempt in range(4):
        for ep in ENDPOINTS:
            try:
                req = urllib.request.Request(ep, data=data, headers={"User-Agent": "hare-golf-course-builder"})
                with urllib.request.urlopen(req, timeout=240) as r:
                    return json.load(r)["elements"]
            except Exception as e:  # noqa: BLE001
                last = e
                print(f"  {pref} {ep}: {e}", file=sys.stderr)
                time.sleep(10)
        time.sleep(30 * (attempt + 1))
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
    for i in range(1, 48):
        pref = f"{i:02d}"
        try:
            courses = parse(query(pref))
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
