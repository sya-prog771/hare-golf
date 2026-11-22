#!/usr/bin/env python3
"""オフライン版（1ファイルのHTML）を作る。

ダブルクリックで開くだけで使えるように、AI（MediaPipe のライブラリ・WASM・
標準モデル）、アイコン、デモ（合成動画と関節位置）を HTML に埋め込む。

  python3 tools/build_offline.py
    → offline/GaitTester_offline.html（AI版・デモつき）
      offline/GaitTester_manual_offline.html（手動デジタイズ版・デモ動画つき）

MediaPipe とモデルは、初回に npm と Google のサーバーから取得して
tools/.cache に保存する（--mp・--model で手元のファイルも指定できる）。
デモは tools/make_demo.py で作る（tools/.cache/demo になければ自動で作る）。
"""
import argparse
import base64
import gzip
import json
import os
import re
import subprocess
import sys
import tarfile
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CACHE = os.path.join(HERE, '.cache')
MP_VER = '0.10.14'
MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_{k}/float16/1/pose_landmarker_{k}.task'
AI_NAME = 'GaitTester_offline.html'
MANUAL_NAME = 'GaitTester_manual_offline.html'


def fetch(url, path):
    if not os.path.exists(path):
        print('download', url)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        urllib.request.urlretrieve(url, path + '.part')
        os.replace(path + '.part', path)
    return path


def mediapipe_dir(arg):
    if arg:
        return arg
    d = os.path.join(CACHE, f'tasks-vision-{MP_VER}')
    if not os.path.exists(os.path.join(d, 'vision_bundle.mjs')):
        tgz = fetch(f'https://registry.npmjs.org/@mediapipe/tasks-vision/-/tasks-vision-{MP_VER}.tgz', os.path.join(CACHE, f'tasks-vision-{MP_VER}.tgz'))
        with tarfile.open(tgz) as t:
            for m in t.getmembers():
                if m.isfile() and m.name.startswith('package/'):
                    m.name = m.name[len('package/'):]
                    t.extract(m, d, filter='data')
    return d


def blob(el_id, data, gz=True):
    if gz:
        data = gzip.compress(data, 9, mtime=0)
    return f'<script type="application/octet-stream" id="{el_id}" data-gzip="{1 if gz else 0}">{base64.b64encode(data).decode()}</script>\n'


def demo_data(demo_dir, with_kp=True):
    slots = {}
    for v in ('left', 'right'):
        kp = json.load(open(os.path.join(demo_dir, f'demo_{v}.json')))
        x = {'kp': kp if with_kp else {k: kp[k] for k in ('video', 'fps', 'capfps', 'width', 'height', 'calibration')}}
        for ext in ('mp4', 'webm'):
            x[ext] = base64.b64encode(open(os.path.join(demo_dir, f'demo_{v}.{ext}'), 'rb').read()).decode()
        slots[v] = x
    patient = {'pid': 'DEMO-001', 'pname': 'デモ（合成データ）', 'age': '68', 'sex': '男性', 'height': '165',
               'diag': '右片麻痺を想定した合成データ', 'aid': 'なし',
               'memo': 'Gait Tester のデモです。人形が歩く合成動画と、その関節位置から作ったデータで、実際の患者のデータではありません。'}
    return json.dumps({'patient': patient, 'slots': slots}, ensure_ascii=False, separators=(',', ':')).encode()


def common(html, icon_uri):
    html = re.sub(r'<link rel="manifest"[^>]*>\n?', '', html)
    html = html.replace('href="icon-192.png"', f'href="{icon_uri}"').replace('href="apple-touch-icon.png"', f'href="{icon_uri}"')
    return html


def inject(html, tags):
    i = html.index('<script type="module">')
    return html[:i] + tags + html[i:]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--mp', help='@mediapipe/tasks-vision のフォルダ（package の中身）')
    ap.add_argument('--model', help='pose_landmarker_full.task')
    ap.add_argument('--demo', help='make_demo.py の出力フォルダ')
    ap.add_argument('--out', default=os.path.join(ROOT, 'offline'))
    a = ap.parse_args()

    mp = mediapipe_dir(a.mp)
    model = a.model or fetch(MODEL_URL.format(k='full'), os.path.join(CACHE, 'pose_landmarker_full.task'))
    demo = a.demo or os.path.join(CACHE, 'demo')
    if not os.path.exists(os.path.join(demo, 'demo_right.webm')):
        subprocess.run([sys.executable, os.path.join(HERE, 'make_demo.py'), demo], check=True)
    icon_uri = 'data:image/png;base64,' + base64.b64encode(open(os.path.join(ROOT, 'icon-192.png'), 'rb').read()).decode()
    os.makedirs(a.out, exist_ok=True)
    rd = lambda p: open(p, 'rb').read()

    # AI版
    html = common(open(os.path.join(ROOT, 'index.html'), encoding='utf-8').read(), icon_uri)
    html = html.replace('href="manual.html"', f'href="{MANUAL_NAME}"')
    html = html.replace('<title>Gait Tester</title>', '<title>Gait Tester（オフライン版）</title>')
    tags = (blob('gt-lib', rd(os.path.join(mp, 'vision_bundle.mjs')))
            + blob('gt-loader', rd(os.path.join(mp, 'wasm', 'vision_wasm_internal.js')))
            + blob('gt-wasm', rd(os.path.join(mp, 'wasm', 'vision_wasm_internal.wasm')))
            + blob('gt-model-full', rd(model))
            + blob('gt-demo', demo_data(demo)))
    out = os.path.join(a.out, AI_NAME)
    open(out, 'w', encoding='utf-8').write(inject(html, tags))
    print('wrote', out, f'{os.path.getsize(out) / 1e6:.1f} MB')

    # 手動デジタイズ版
    html = common(open(os.path.join(ROOT, 'manual.html'), encoding='utf-8').read(), icon_uri)
    html = html.replace('id="aiLink" href="./"', f'id="aiLink" href="{AI_NAME}"')
    html = html.replace('<title>Gait Tester 手動版</title>', '<title>Gait Tester 手動版（オフライン版）</title>')
    out = os.path.join(a.out, MANUAL_NAME)
    open(out, 'w', encoding='utf-8').write(inject(html, blob('gt-demo', demo_data(demo, with_kp=False))))
    print('wrote', out, f'{os.path.getsize(out) / 1e6:.1f} MB')


if __name__ == '__main__':
    main()
