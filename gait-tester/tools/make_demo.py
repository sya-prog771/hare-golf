#!/usr/bin/env python3
"""デモ用の合成歩行データを作る。

人形が歩く動画（左側面・右側面）と、その関節位置（Gait Tester の
gaittester-keypoints-v1 形式）を作る。左脚は健常に近い歩き方、右脚は
遊脚期の膝屈曲が小さく、蹴り出し・股関節伸展が弱い歩き方（片麻痺を想定）。

関節角度の曲線（歩行周期0〜100%）から脚の位置を計算し、低いほうの足が
床に着くように骨盤の高さを決めるので、接地・踵離地・離地が自然に出る。

使い方: python3 tools/make_demo.py 出力フォルダ
  出力: demo_left.json / demo_right.json（関節位置）
        demo_left.webm / demo_left.mp4 / demo_right.webm / demo_right.mp4（動画）
必要なもの: numpy, Pillow, ffmpeg（libvpx・libx264）
"""
import json
import math
import os
import subprocess
import sys
import tempfile

import numpy as np
from PIL import Image, ImageDraw

W, H = 960, 540          # 動画の大きさ
FPS = 60                 # 撮影fps
DUR = 5.0                # 秒
PXM = 200.0              # 1 m あたりの画素数
GROUND = 470             # 床の高さ（画素）
SPEED = 0.85             # m/s
CYCLE = 1.15             # 1周期の秒数
TAPE = (1.2, 3.2)        # 床のテープの位置（m）＝距離の基準 2 m

# 歩行周期（%）ごとの関節角度（股:屈曲+ 膝:屈曲+ 足:背屈+）。Perry の正常歩行をもとにした近似値
NORMAL = [
    (0, 30, 4, 0), (6, 29, 14, -6), (12, 25, 17, -3), (20, 18, 13, 2), (31, 8, 6, 7),
    (40, 0, 4, 10), (50, -9, 8, 8), (55, -10, 18, 0), (62, -4, 38, -17), (70, 10, 55, -9),
    (75, 20, 60, -3), (87, 32, 33, 1), (95, 32, 10, 1), (100, 30, 4, 0),
]
# 右脚：股関節伸展・遊脚期の膝屈曲・蹴り出しが小さい
IMPAIRED = [
    (0, 26, 9, -4), (6, 26, 13, -6), (12, 23, 14, -3), (20, 18, 12, 0), (31, 11, 8, 3),
    (40, 6, 7, 5), (50, 2, 16, 4), (55, 0, 22, 0), (62, 3, 24, -7), (70, 13, 32, -6),
    (75, 20, 35, -5), (87, 28, 25, -4), (95, 27, 12, -4), (100, 26, 9, -4),
]

THIGH, SHANK = 0.42, 0.42
PELVIC_TILT = 12         # 股関節角度は骨盤基準なので、大腿の鉛直からの角度はこの分だけ小さい
TRUNK_LEAN = 2           # 体幹の前傾（度）
HEEL_BACK, HEEL_DOWN, FOOT = 0.05, 0.065, 0.22


def curve(table):
    """周期的な Catmull-Rom 補間で 0〜1 の関数を作る"""
    xs = np.array([r[0] for r in table[:-1]], float) / 100.0
    ys = np.array([r[1:] for r in table[:-1]], float)
    n = len(xs)

    def f(p):
        p %= 1.0
        i = np.searchsorted(xs, p, side='right') - 1
        x0, x1 = xs[i], (xs[(i + 1) % n] if i + 1 < n else 1.0)
        t = (p - x0) / (x1 - x0)
        p0, p1, p2, p3 = ys[(i - 1) % n], ys[i], ys[(i + 1) % n], ys[(i + 2) % n]
        return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t ** 3)
    return f


def leg(hip, ang):
    """股関節の位置（m・上が+）と角度から膝・足首・踵・つま先を求める"""
    h, k, a = [math.radians(v) for v in ang]
    knee = (hip[0] + THIGH * math.sin(h), hip[1] - THIGH * math.cos(h))
    s = h - k
    ank = (knee[0] + SHANK * math.sin(s), knee[1] - SHANK * math.cos(s))
    fa = a + s                                   # 足底の傾き（つま先上がり+）
    u = (math.cos(fa), math.sin(fa))
    n = (-math.sin(fa), math.cos(fa))
    heel = (ank[0] - HEEL_BACK * u[0] - HEEL_DOWN * n[0], ank[1] - HEEL_BACK * u[1] - HEEL_DOWN * n[1])
    toe = (heel[0] + FOOT * u[0], heel[1] + FOOT * u[1])
    return {'knee': knee, 'ank': ank, 'heel': heel, 'toe': toe}


def frames_3d():
    fL, fR = curve(NORMAL), curve(IMPAIRED)
    out = []
    for i in range(int(DUR * FPS)):
        t = i / FPS
        pL, pR = t / CYCLE, t / CYCLE + 0.5
        aL, aR = fL(pL), fR(pR)
        x = -0.15 + SPEED * t
        tL, tR = (aL[0] - PELVIC_TILT, aL[1], aL[2]), (aR[0] - PELVIC_TILT, aR[1], aR[2])
        L, R = leg((x, 0), tL), leg((x, 0), tR)
        low = min(L['heel'][1], L['toe'][1], R['heel'][1], R['toe'][1])
        hy = -low                                       # 低いほうの足が床（y=0）に着く高さ
        sh = lambda d: (d[0], d[1] + hy)
        L = {k: sh(v) for k, v in L.items()}
        R = {k: sh(v) for k, v in R.items()}
        hip = (x, hy)
        lean = math.radians(TRUNK_LEAN)
        shoulder = (x + 0.5 * math.sin(lean), hy + 0.5 * math.cos(lean))
        ear = (shoulder[0] + 0.03, shoulder[1] + 0.25)
        arms = {}
        for side, hipang in (('L', aR[0]), ('R', aL[0])):    # 腕は反対側の脚と同じ向きに振る
            sw = math.radians(0.7 * (hipang - 10))
            el = (shoulder[0] + 0.28 * math.sin(sw), shoulder[1] - 0.28 * math.cos(sw))
            sw2 = sw + math.radians(15)
            wr = (el[0] + 0.25 * math.sin(sw2), el[1] - 0.25 * math.cos(sw2))
            arms[side] = (el, wr)
        out.append({'t': t, 'hip': hip, 'sh': shoulder, 'ear': ear, 'L': L, 'R': R, 'arms': arms})
    return out


def to_px(p, mirror):
    x = p[0] * PXM + 40
    if mirror:
        x = W - x
    return (x, GROUND - p[1] * PXM)


def keypoints(fr, near, mirror):
    """MediaPipe の33点の並びで画素座標と信頼度を作る（カメラから遠い脚は信頼度を下げる）"""
    vis = lambda s: 0.95 if s == near else 0.72
    P = lambda p: to_px(p, mirror)
    lm = [None] * 33
    def put(i, p, v): lm[i] = [round(P(p)[0], 1), round(P(p)[1], 1), v]
    ear = fr['ear']
    for i in range(0, 11):                           # 顔
        put(i, (ear[0] + 0.07, ear[1] + 0.02), 0.9)
    put(7, ear, vis('L')); put(8, ear, vis('R'))
    put(11, fr['sh'], vis('L')); put(12, fr['sh'], vis('R'))
    for side, (e, w) in fr['arms'].items():
        b = 13 if side == 'L' else 14
        put(b, e, vis(side)); put(b + 2, w, vis(side))
        for j in (17, 19, 21):
            put(j + (0 if side == 'L' else 1), w, vis(side) * 0.9)
    put(23, fr['hip'], vis('L')); put(24, fr['hip'], vis('R'))
    for side, b in (('L', 25), ('R', 26)):
        g = fr[side]
        put(b, g['knee'], vis(side)); put(b + 2, g['ank'], vis(side))
        put(b + 4, g['heel'], vis(side)); put(b + 6, g['toe'], vis(side))
    return lm


def draw(fr, near, mirror):
    im = Image.new('RGB', (W, H))
    d = ImageDraw.Draw(im)
    for y in range(GROUND):                         # 壁
        c = int(222 - 30 * y / GROUND)
        d.line([(0, y), (W, y)], fill=(c, c + 4, c + 2))
    d.rectangle([0, GROUND, W, H], fill=(150, 135, 118))   # 床
    for m in TAPE:                                  # 距離の基準のテープ
        x = to_px((m, 0), mirror)[0]
        d.rectangle([x - 3, GROUND - 2, x + 3, GROUND + 26], fill=(255, 220, 40))
    P = lambda p: to_px(p, mirror)
    far = 'R' if near == 'L' else 'L'

    def limb(a, b, w, col):
        a, b = P(a), P(b)
        d.line([a, b], fill=col, width=w)
        r = w / 2
        for q in (a, b):
            d.ellipse([q[0] - r, q[1] - r, q[0] + r, q[1] + r], fill=col)

    def legdraw(side, dark):
        g = fr[side]
        pant = (40, 55, 110) if not dark else (28, 36, 70)
        skin = (225, 185, 150) if not dark else (170, 135, 110)
        shoe = (35, 35, 35) if not dark else (20, 20, 20)
        limb(fr['hip'], g['knee'], 30, pant)
        limb(g['knee'], g['ank'], 24, pant)
        d.polygon([P(g['heel']), P(g['ank']), P(g['toe'])], fill=shoe)
        limb(g['heel'], g['toe'], 12, shoe)
        limb(g['ank'], g['heel'], 12, shoe)
        _ = skin

    def armdraw(side, dark):
        e, w = fr['arms'][side]
        sl = (170, 45, 50) if not dark else (110, 30, 34)
        sk = (225, 185, 150) if not dark else (165, 130, 105)
        limb(fr['sh'], e, 18, sl)
        limb(e, w, 14, sk)

    armdraw(far, True)
    legdraw(far, True)
    limb(fr['hip'], fr['sh'], 46, (190, 50, 55))     # 胴体
    (x0, y0), (x1, y1) = P((fr['hip'][0] - 0.09, fr['hip'][1] + 0.08)), P((fr['hip'][0] + 0.09, fr['hip'][1] - 0.07))
    d.ellipse([min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1)], fill=(40, 55, 110))   # 腰
    legdraw(near, False)
    hx, hy = P(fr['ear'])
    d.line([P(fr['sh']), (hx, hy + 10)], fill=(225, 185, 150), width=16)
    dx = 14 if not mirror else -14
    d.ellipse([hx - 24 + dx * 0.4, hy - 30, hx + 24 + dx * 0.4, hy + 30], fill=(225, 185, 150))
    d.chord([hx - 26 + dx * 0.2, hy - 33, hx + 26 + dx * 0.2, hy + 10], 180, 360, fill=(50, 35, 30))
    armdraw(near, False)
    return im


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else '.'
    os.makedirs(out, exist_ok=True)
    frs = frames_3d()
    for view, near, mirror in (('left', 'L', False), ('right', 'R', True)):
        name = f'demo_{view}'
        kp = {'format': 'gaittester-keypoints-v1', 'video': f'{name}.mp4', 'fps': FPS, 'capfps': FPS,
              'width': W, 'height': H, 'nframes': len(frs), 'stride': 1,
              'frames': [{'f': i, 'lm': keypoints(fr, near, mirror)} for i, fr in enumerate(frs)],
              'calibration': {'p': [list(to_px((TAPE[0], 0), mirror)), list(to_px((TAPE[1], 0), mirror))], 'm': round(TAPE[1] - TAPE[0], 3)}}
        kp['calibration']['p'] = [[round(v, 1) for v in p] for p in kp['calibration']['p']]
        with open(os.path.join(out, name + '.json'), 'w') as f:
            json.dump(kp, f, separators=(',', ':'))
        with tempfile.TemporaryDirectory() as td:
            for i, fr in enumerate(frs):
                draw(fr, near, mirror).save(os.path.join(td, f'{i:04d}.png'))
            src = ['-framerate', str(FPS), '-i', os.path.join(td, '%04d.png')]
            subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', *src, '-c:v', 'libvpx', '-b:v', '350k', '-pix_fmt', 'yuv420p', os.path.join(out, name + '.webm')], check=True)
            subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', *src, '-c:v', 'libx264', '-crf', '28', '-preset', 'slow', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', os.path.join(out, name + '.mp4')], check=True)
        print('wrote', name)


if __name__ == '__main__':
    main()
