"""ノートブック・資料・メモ・会話履歴をフォルダに保存する（データベース不要）

data/notebooks/<ノートブックID>/
    notebook.json        名前・メモ・会話履歴
    sources/<資料ID>.json 資料の本文・チャンク・埋め込みベクトル
"""
import json
import os
import shutil
import threading
import time
import uuid

from retrieve import chunk_text, tokenize

_lock = threading.RLock()


def _new_id():
    return uuid.uuid4().hex[:12]


def _write_json(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False)
    os.replace(tmp, path)  # 書きかけで壊れないように、書き終えてから置き換える


def _read_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


class Store:
    def __init__(self, root):
        self.root = os.path.join(root, "notebooks")
        os.makedirs(self.root, exist_ok=True)
        self._token_cache = {}  # (資料ID, チャンク番号) -> トークン列

    def _nb_dir(self, nb_id):
        if not nb_id or not nb_id.isalnum():
            raise KeyError(nb_id)
        d = os.path.join(self.root, nb_id)
        if not os.path.isdir(d):
            raise KeyError(nb_id)
        return d

    def _src_path(self, nb_id, src_id):
        if not src_id or not src_id.isalnum():
            raise KeyError(src_id)
        return os.path.join(self._nb_dir(nb_id), "sources", src_id + ".json")

    # ---------- ノートブック ----------
    def list_notebooks(self):
        out = []
        for nb_id in os.listdir(self.root):
            p = os.path.join(self.root, nb_id, "notebook.json")
            if os.path.exists(p):
                nb = _read_json(p)
                n_src = len(os.listdir(os.path.join(self.root, nb_id, "sources")))
                out.append({"id": nb_id, "name": nb["name"], "updated": nb.get("updated", 0), "sources": n_src})
        return sorted(out, key=lambda x: -x["updated"])

    def create_notebook(self, name):
        with _lock:
            nb_id = _new_id()
            d = os.path.join(self.root, nb_id)
            os.makedirs(os.path.join(d, "sources"))
            nb = {"name": name or "無題のノートブック", "created": time.time(), "updated": time.time(),
                  "notes": [], "chat": []}
            _write_json(os.path.join(d, "notebook.json"), nb)
            return nb_id

    def get_notebook(self, nb_id):
        return _read_json(os.path.join(self._nb_dir(nb_id), "notebook.json"))

    def update_notebook(self, nb_id, fn):
        """fn(nb) で中身を書き換えて保存"""
        with _lock:
            p = os.path.join(self._nb_dir(nb_id), "notebook.json")
            nb = _read_json(p)
            fn(nb)
            nb["updated"] = time.time()
            _write_json(p, nb)
            return nb

    def delete_notebook(self, nb_id):
        with _lock:
            shutil.rmtree(self._nb_dir(nb_id))

    # ---------- 資料 ----------
    def list_sources(self, nb_id):
        d = os.path.join(self._nb_dir(nb_id), "sources")
        out = []
        for f in os.listdir(d):
            if f.endswith(".json"):
                s = _read_json(os.path.join(d, f))
                out.append({"id": f[:-5], "title": s["title"], "kind": s["kind"], "chars": len(s["text"]),
                            "added": s["added"], "embedded": bool(s.get("embed_model"))})
        return sorted(out, key=lambda x: x["added"])

    def add_source(self, nb_id, title, kind, text, embed_fn=None, embed_model=""):
        chunks = chunk_text(text)
        vecs = None
        if embed_fn:
            try:
                vecs = embed_fn(chunks)
            except Exception as e:  # 埋め込みに失敗してもキーワード検索で使えるようにする
                print(f"[警告] 埋め込みに失敗したのでキーワード検索のみ使います: {e}")
        src = {
            "title": title, "kind": kind, "text": text, "added": time.time(),
            "embed_model": embed_model if vecs else "",
            "chunks": [{"text": c, "vec": (vecs[i] if vecs else None)} for i, c in enumerate(chunks)],
        }
        with _lock:
            src_id = _new_id()
            _write_json(self._src_path(nb_id, src_id), src)
        self.update_notebook(nb_id, lambda nb: None)
        return src_id

    def get_source(self, nb_id, src_id):
        return _read_json(self._src_path(nb_id, src_id))

    def rename_source(self, nb_id, src_id, title):
        with _lock:
            p = self._src_path(nb_id, src_id)
            s = _read_json(p)
            s["title"] = title
            _write_json(p, s)

    def delete_source(self, nb_id, src_id):
        with _lock:
            os.remove(self._src_path(nb_id, src_id))
            self._token_cache = {k: v for k, v in self._token_cache.items() if k[0] != src_id}

    def reembed(self, nb_id, embed_fn, embed_model):
        """埋め込みモデルを変えたとき、または後から設定したときに作り直す"""
        n = 0
        for s in self.list_sources(nb_id):
            p = self._src_path(nb_id, s["id"])
            src = _read_json(p)
            if src.get("embed_model") == embed_model:
                continue
            vecs = embed_fn([c["text"] for c in src["chunks"]])
            for c, v in zip(src["chunks"], vecs):
                c["vec"] = v
            src["embed_model"] = embed_model
            with _lock:
                _write_json(p, src)
            n += 1
        return n

    def load_chunks(self, nb_id, src_ids=None, embed_model=""):
        """検索用に、選ばれた資料のチャンクをまとめて返す"""
        out = []
        for s in self.list_sources(nb_id):
            if src_ids is not None and s["id"] not in src_ids:
                continue
            src = self.get_source(nb_id, s["id"])
            same_model = embed_model and src.get("embed_model") == embed_model
            for i, c in enumerate(src["chunks"]):
                key = (s["id"], i)
                if key not in self._token_cache:
                    self._token_cache[key] = tokenize(c["text"])
                out.append({
                    "source_id": s["id"], "source_title": src["title"], "chunk": i,
                    "text": c["text"], "tokens": self._token_cache[key],
                    "vec": c.get("vec") if same_model else None,
                })
        return out
