"""ローカル版ノートブックAI のサーバー

  python server.py            → ブラウザで http://localhost:8765 を開く

外部に通信するのは、自分のPCの LLM（Ollama など）と、URLで資料を追加したときだけです。
"""
import argparse
import json
import os
import re
import threading
import time
import traceback
import urllib.parse
import uuid
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import ai
import prompts
from export import markdown_to_docx
from extract import ExtractError, extract_file, extract_url
from llm import LLM, LLMError
from store import Store

HERE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(HERE, "static")

DEFAULT_CONFIG = {
    "backend": "ollama",                  # "ollama" または "openai"（LM Studio・llama.cpp など）
    "url": "http://localhost:11434",
    "model": "",                          # 例: qwen3:8b / gemma3:12b
    "embed_model": "",                    # 例: bge-m3（空ならキーワード検索のみ）
    "num_ctx": 16384,                     # モデルに一度に読ませるトークン数
    "temperature": 0.3,
}

MAX_UPLOAD = 100 * 1024 * 1024
TYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
         ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png"}


class App:
    def __init__(self, data_dir):
        self.data_dir = data_dir
        os.makedirs(data_dir, exist_ok=True)
        self.store = Store(data_dir)
        self.config_path = os.path.join(data_dir, "config.json")
        self.config = dict(DEFAULT_CONFIG)
        if os.path.exists(self.config_path):
            with open(self.config_path, encoding="utf-8") as f:
                self.config.update(json.load(f))
        self.lock = threading.Lock()

    def llm(self):
        return LLM(self.config)

    def save_config(self, new):
        with self.lock:
            for k in DEFAULT_CONFIG:
                if k in new:
                    self.config[k] = new[k]
            with open(self.config_path, "w", encoding="utf-8") as f:
                json.dump(self.config, f, ensure_ascii=False, indent=2)

    def context_budget(self):
        # 日本語はおよそ1文字≒1トークン。指示文と出力のぶんを残して6割を資料に使う
        return max(1000, int(int(self.config["num_ctx"]) * 0.6))


class Handler(BaseHTTPRequestHandler):
    app: App = None
    allowed_hosts = ()

    def log_message(self, fmt, *args):
        pass  # アクセスログは出さない

    # ---------- 共通 ----------
    def _send(self, code, body, ctype="application/json; charset=utf-8", headers=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False).encode("utf-8")
        elif isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _err(self, code, msg):
        self._send(code, {"error": msg})

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > MAX_UPLOAD:
            raise ValueError("ファイルが大きすぎます（100MBまで）")
        return self.rfile.read(n) if n else b""

    def _json(self):
        raw = self._body()
        return json.loads(raw) if raw else {}

    def _stream(self, events, on_event=None):
        """AIの出力を1行1イベント（NDJSON）で少しずつ送る"""
        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        try:
            for ev in events:
                if on_event:
                    on_event(ev)
                self.wfile.write((json.dumps(ev, ensure_ascii=False) + "\n").encode("utf-8"))
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            return  # ブラウザ側で止められた
        except LLMError as e:
            self.wfile.write((json.dumps({"type": "error", "text": str(e)}, ensure_ascii=False) + "\n").encode())
        except Exception as e:
            traceback.print_exc()
            self.wfile.write((json.dumps({"type": "error", "text": f"内部エラー: {e}"}, ensure_ascii=False) + "\n").encode())

    def _host_ok(self):
        # 他のWebサイトからこのサーバーを操作されないよう、Hostヘッダーを確認する
        if not self.allowed_hosts:
            return True
        host = (self.headers.get("Host") or "").rsplit(":", 1)[0].strip("[]")
        return host in self.allowed_hosts

    def _route(self, method):
        if not self._host_ok():
            return self._err(403, "forbidden host")
        path = urllib.parse.urlparse(self.path).path
        try:
            for pattern, m, fn in ROUTES:
                if m != method:
                    continue
                mt = re.fullmatch(pattern, path)
                if mt:
                    return fn(self, *mt.groups())
            if method == "GET":
                return self._static(path)
            self._err(404, "not found")
        except KeyError:
            self._err(404, "見つかりません")
        except (ExtractError, LLMError, ValueError, RuntimeError) as e:
            self._err(400, str(e))
        except Exception as e:
            traceback.print_exc()
            self._err(500, f"内部エラー: {e}")

    def do_GET(self):
        self._route("GET")

    def do_POST(self):
        self._route("POST")

    def do_PUT(self):
        self._route("PUT")

    def do_PATCH(self):
        self._route("PATCH")

    def do_DELETE(self):
        self._route("DELETE")

    def _static(self, path):
        if path == "/":
            path = "/index.html"
        full = os.path.normpath(os.path.join(STATIC, path.lstrip("/")))
        if not full.startswith(STATIC + os.sep) or not os.path.isfile(full):
            return self._err(404, "not found")
        with open(full, "rb") as f:
            self._send(200, f.read(), TYPES.get(os.path.splitext(full)[1], "application/octet-stream"))

    # ---------- 設定 ----------
    def get_config(self):
        self._send(200, self.app.config)

    def put_config(self):
        self.app.save_config(self._json())
        self._send(200, self.app.config)

    def get_models(self):
        try:
            self._send(200, {"models": self.app.llm().list_models()})
        except LLMError as e:
            self._send(200, {"models": [], "error": str(e)})

    def get_templates(self):
        self._send(200, [{"id": k, "label": v["label"], "icon": v["icon"]} for k, v in prompts.TEMPLATES.items()])

    # ---------- ノートブック ----------
    def list_notebooks(self):
        self._send(200, self.app.store.list_notebooks())

    def create_notebook(self):
        nb_id = self.app.store.create_notebook((self._json().get("name") or "").strip())
        self._send(200, {"id": nb_id})

    def get_notebook(self, nb_id):
        nb = self.app.store.get_notebook(nb_id)
        nb["id"] = nb_id
        nb["sources"] = self.app.store.list_sources(nb_id)
        self._send(200, nb)

    def patch_notebook(self, nb_id):
        name = (self._json().get("name") or "").strip()
        if name:
            self.app.store.update_notebook(nb_id, lambda nb: nb.__setitem__("name", name))
        self._send(200, {"ok": True})

    def delete_notebook(self, nb_id):
        self.app.store.delete_notebook(nb_id)
        self._send(200, {"ok": True})

    # ---------- 資料 ----------
    def _add_source(self, nb_id, title, kind, text):
        llm = self.app.llm()
        sid = self.app.store.add_source(nb_id, title, kind, text,
                                        embed_fn=llm.embed if llm.embed_model else None,
                                        embed_model=llm.embed_model)
        self._send(200, {"id": sid})

    def upload_source(self, nb_id):
        self.app.store.get_notebook(nb_id)
        name = urllib.parse.unquote(self.headers.get("X-Filename") or "file.txt")
        text = extract_file(name, self._body())
        self._add_source(nb_id, os.path.basename(name), os.path.splitext(name)[1].lstrip(".").lower() or "txt", text)

    def text_source(self, nb_id):
        d = self._json()
        text = (d.get("text") or "").strip()
        if not text:
            raise ValueError("テキストが空です")
        title = (d.get("title") or "").strip() or text.split("\n", 1)[0][:40]
        self._add_source(nb_id, title, "text", text)

    def url_source(self, nb_id):
        title, text = extract_url((self._json().get("url") or "").strip())
        self._add_source(nb_id, title, "web", text)

    def get_source(self, nb_id, sid):
        s = self.app.store.get_source(nb_id, sid)
        self._send(200, {"id": sid, "title": s["title"], "kind": s["kind"], "text": s["text"],
                         "chunks": [c["text"] for c in s["chunks"]]})

    def patch_source(self, nb_id, sid):
        title = (self._json().get("title") or "").strip()
        if title:
            self.app.store.rename_source(nb_id, sid, title)
        self._send(200, {"ok": True})

    def delete_source(self, nb_id, sid):
        self.app.store.delete_source(nb_id, sid)
        self._send(200, {"ok": True})

    def reembed(self, nb_id):
        llm = self.app.llm()
        if not llm.embed_model:
            raise ValueError("埋め込みモデルが設定されていません")
        n = self.app.store.reembed(nb_id, llm.embed, llm.embed_model)
        self._send(200, {"updated": n})

    # ---------- チャット・文書作成 ----------
    def chat(self, nb_id):
        d = self._json()
        question = (d.get("message") or "").strip()
        if not question:
            raise ValueError("質問が空です")
        src_ids = d.get("source_ids")
        nb = self.app.store.get_notebook(nb_id)
        answer, cites = [], []

        def collect(ev):
            if ev["type"] == "delta":
                answer.append(ev["text"])
            elif ev["type"] == "citations":
                cites.extend(ev["items"])
            elif ev["type"] == "done":
                def save(nb):
                    nb["chat"].append({"role": "user", "content": question})
                    nb["chat"].append({"role": "assistant", "content": "".join(answer), "citations": cites})
                    nb["chat"] = nb["chat"][-200:]
                self.app.store.update_notebook(nb_id, save)

        self._stream(ai.answer(self.app.store, self.app.llm(), nb_id, question, src_ids, nb["chat"]), collect)

    def clear_chat(self, nb_id):
        self.app.store.update_notebook(nb_id, lambda nb: nb.__setitem__("chat", []))
        self._send(200, {"ok": True})

    def generate(self, nb_id):
        d = self._json()
        self.app.store.get_notebook(nb_id)
        self._stream(ai.generate(self.app.store, self.app.llm(), nb_id, d.get("kind", "summary"),
                                 d.get("source_ids"), d.get("extra") or "", self.app.context_budget()))

    # ---------- メモ（作った文書の保存先） ----------
    def add_note(self, nb_id):
        d = self._json()
        note = {"id": uuid.uuid4().hex[:12], "title": (d.get("title") or "メモ").strip(),
                "content": d.get("content") or "", "kind": d.get("kind") or "note", "created": time.time()}
        self.app.store.update_notebook(nb_id, lambda nb: nb["notes"].insert(0, note))
        self._send(200, note)

    def patch_note(self, nb_id, note_id):
        d = self._json()

        def fn(nb):
            for n in nb["notes"]:
                if n["id"] == note_id:
                    for k in ("title", "content"):
                        if k in d:
                            n[k] = d[k]
        self.app.store.update_notebook(nb_id, fn)
        self._send(200, {"ok": True})

    def delete_note(self, nb_id, note_id):
        self.app.store.update_notebook(
            nb_id, lambda nb: nb.__setitem__("notes", [n for n in nb["notes"] if n["id"] != note_id]))
        self._send(200, {"ok": True})

    def note_to_source(self, nb_id, note_id):
        note = next(n for n in self.app.store.get_notebook(nb_id)["notes"] if n["id"] == note_id)
        self._add_source(nb_id, note["title"], "note", note["content"])

    # ---------- 書き出し ----------
    def export_docx(self):
        d = self._json()
        title = (d.get("title") or "document").strip()
        data = markdown_to_docx(d.get("markdown") or "", title)
        fname = urllib.parse.quote(re.sub(r'[\\/:*?"<>|]', "_", title) + ".docx")
        self._send(200, data, "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                   {"Content-Disposition": f"attachment; filename*=UTF-8''{fname}"})


NB = r"/api/notebooks/([a-z0-9]+)"
ROUTES = [
    (r"/api/config", "GET", Handler.get_config),
    (r"/api/config", "PUT", Handler.put_config),
    (r"/api/models", "GET", Handler.get_models),
    (r"/api/templates", "GET", Handler.get_templates),
    (r"/api/notebooks", "GET", Handler.list_notebooks),
    (r"/api/notebooks", "POST", Handler.create_notebook),
    (NB, "GET", Handler.get_notebook),
    (NB, "PATCH", Handler.patch_notebook),
    (NB, "DELETE", Handler.delete_notebook),
    (NB + r"/sources/upload", "POST", Handler.upload_source),
    (NB + r"/sources/text", "POST", Handler.text_source),
    (NB + r"/sources/url", "POST", Handler.url_source),
    (NB + r"/sources/([a-z0-9]+)", "GET", Handler.get_source),
    (NB + r"/sources/([a-z0-9]+)", "PATCH", Handler.patch_source),
    (NB + r"/sources/([a-z0-9]+)", "DELETE", Handler.delete_source),
    (NB + r"/reembed", "POST", Handler.reembed),
    (NB + r"/chat", "POST", Handler.chat),
    (NB + r"/chat", "DELETE", Handler.clear_chat),
    (NB + r"/generate", "POST", Handler.generate),
    (NB + r"/notes", "POST", Handler.add_note),
    (NB + r"/notes/([a-z0-9]+)", "PATCH", Handler.patch_note),
    (NB + r"/notes/([a-z0-9]+)", "DELETE", Handler.delete_note),
    (NB + r"/notes/([a-z0-9]+)/to-source", "POST", Handler.note_to_source),
    (r"/api/export/docx", "POST", Handler.export_docx),
]


def main():
    ap = argparse.ArgumentParser(description="ローカル版ノートブックAI")
    ap.add_argument("--host", default="127.0.0.1", help="0.0.0.0 にすると同じLANの他の端末からも使える")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--data", default=os.path.join(HERE, "data"))
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()

    Handler.app = App(args.data)
    if args.host in ("127.0.0.1", "localhost"):
        Handler.allowed_hosts = ("127.0.0.1", "localhost", "::1")
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    url = f"http://localhost:{args.port}"
    print(f"ノートブックAI を起動しました → {url}  （止めるときは Ctrl+C）")
    cfg = Handler.app.config
    print(f"LLM: {cfg['backend']} {cfg['url']}  モデル: {cfg['model'] or '（未設定・画面の⚙から選択）'}")
    if not args.no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n終了しました")


if __name__ == "__main__":
    main()
