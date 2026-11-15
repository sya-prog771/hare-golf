"""courses/XX.json の全ゴルフ場について Open-Meteo の16日予報を取り、weather/XX.json に保存する。
GitHub Actions から実行する（.github/workflows/update-weather.yml）。
保存するのは 6〜20時ラベル（= 5:00〜20:00 の各1時間）だけ。"""
import datetime as dt, functools, glob, json, os, sys, time, urllib.parse, urllib.request

print = functools.partial(print, flush=True)  # noqa: A001

H_FROM, H_TO = 6, 20  # Open-Meteo の時刻ラベル（直前1時間の値）
BATCH = 50
VARS = "precipitation,precipitation_probability,weather_code,temperature_2m,wind_speed_10m"


def fetch(part):
    q = {
        "latitude": ",".join(str(c["lat"]) for c in part),
        "longitude": ",".join(str(c["lon"]) for c in part),
        "hourly": VARS, "timezone": "Asia/Tokyo", "wind_speed_unit": "ms", "forecast_days": 16,
    }
    url = "https://api.open-meteo.com/v1/forecast?" + urllib.parse.urlencode(q)
    last = None
    for attempt in range(4):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "hare-golf"}), timeout=60) as r:
                js = json.load(r)
                return js if isinstance(js, list) else [js]
        except Exception as e:  # noqa: BLE001
            last = e
            print(f"  retry {attempt + 1}: {e}")
            time.sleep(10 * (attempt + 1))
    raise RuntimeError(last)


def pack(w):
    h = w["hourly"]
    keep = [i for i, t in enumerate(h["time"]) if H_FROM <= int(t[11:13]) <= H_TO]

    def col(name, scale=1):
        return [None if h[name][i] is None else round(h[name][i] * scale) for i in keep]

    return {"p": col("precipitation", 10), "pp": col("precipitation_probability"), "c": col("weather_code"),
            "t": col("temperature_2m"), "w": col("wind_speed_10m")}, h["time"][0][:10]


def main():
    os.makedirs("weather", exist_ok=True)
    now = dt.datetime.now(dt.timezone(dt.timedelta(hours=9))).isoformat(timespec="minutes")
    failed = []
    for path in sorted(glob.glob("courses/*.json")):
        pref = os.path.basename(path)[:2]
        courses = json.load(open(path, encoding="utf-8"))
        rows, start = [], None
        try:
            for i in range(0, len(courses), BATCH):
                for w in fetch(courses[i:i + BATCH]):
                    r, start = pack(w)
                    rows.append(r)
                time.sleep(7)  # 1分あたりの上限（600回）を超えないように
        except Exception as e:  # noqa: BLE001
            print(f"FAILED {pref}: {e}")
            failed.append(pref)
            continue
        out = {"generated": now, "start": start, "hFrom": H_FROM, "hTo": H_TO,
               "names": [c["name"] for c in courses], "rows": rows}
        with open(f"weather/{pref}.json", "w", encoding="utf-8") as f:
            json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
        print(f"{pref}: {len(rows)}")
    if len(failed) > 10:
        sys.exit(f"too many failures: {failed}")


if __name__ == "__main__":
    main()
