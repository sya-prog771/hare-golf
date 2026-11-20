#!/usr/bin/env python3
"""お試し版（1ファイルの HTML）を作る。claude.ai の非公開ページなどで、スマホから操作を試すためのもの。
   使い方: python3 emr/tools/build-trial.py 出力先.html
   お試し版では「実在の患者情報を入力しない」表示を出し、ホーム画面への追加案内・オフライン保存は行わない。"""
import os, sys
here = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
out = sys.argv[1] if len(sys.argv) > 1 else "emr-trial.html"
js = ["jscrypto", "crypto", "db", "diseases", "dxmaster", "master", "store", "ui", "print", "demo", "charts", "app"]
parts = ['<title>電子カルテ お試し版</title>',
         '<meta name="claude:viewport-fit-sides" content="cover">',
         '<meta name="emr-trial" content="1">',
         '<meta name="theme-color" content="#1f6fc5">',
         '<style>\n' + open(os.path.join(here, "styles.css"), encoding="utf-8").read() + '\n</style>',
         '<noscript>この電子カルテを使うには JavaScript を有効にしてください。</noscript>',
         '<div id="app"></div>']
for n in js:
    src = open(os.path.join(here, "js", n + ".js"), encoding="utf-8").read()
    if "</script" in src.lower():
        sys.exit(f"js/{n}.js に </script が含まれているため、1ファイルにまとめられません")
    parts.append('<script>\n' + src + '\n</script>')
open(out, "w", encoding="utf-8").write("\n".join(parts) + "\n")
print(f"{out} を作成しました（{os.path.getsize(out) // 1024} KB）")
