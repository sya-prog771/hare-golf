"""ローカルLLMとの通信（Ollama / OpenAI互換サーバー）

- Ollama:            http://localhost:11434        （おすすめ）
- OpenAI互換サーバー: LM Studio・llama.cpp server・vLLM など（例 http://localhost:1234/v1）

どちらも外部ライブラリなし（標準ライブラリの urllib だけ）で話します。
"""
import json
import urllib.error
import urllib.request


class LLMError(Exception):
    pass


def _post(url, payload, timeout=600):
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"}, method="POST",
    )
    try:
        return urllib.request.urlopen(req, timeout=timeout)
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")[:500]
        raise LLMError(f"LLMサーバーがエラーを返しました ({e.code}): {body}") from None
    except urllib.error.URLError as e:
        raise LLMError(f"LLMサーバーにつながりません ({url}): {e.reason}。Ollama は起動していますか？") from None


def _get(url, timeout=10):
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return json.loads(r.read())
    except (urllib.error.URLError, OSError) as e:
        raise LLMError(f"LLMサーバーにつながりません ({url}): {e}") from None


class ThinkFilter:
    """Qwen3 などの「考え中」部分 <think>…</think> をストリームから取り除く"""

    def __init__(self):
        self.buf = ""
        self.inside = False
        self.after = False  # 閉じタグ直後の改行を捨てるため

    def feed(self, text):
        self.buf += text
        out = []
        while self.buf:
            if self.inside:
                end = self.buf.find("</think>")
                if end < 0:
                    self.buf = self.buf[-8:]  # 閉じタグが分割されて届く場合に備える
                    break
                self.buf = self.buf[end + 8:]
                self.inside = False
                self.after = True
            else:
                if self.after:
                    self.buf = self.buf.lstrip("\n")
                    if not self.buf:
                        break
                    self.after = False
                start = self.buf.find("<think>")
                if start < 0:
                    # "<thi" のようにタグの途中で切れている可能性がある部分だけ残す
                    keep = 0
                    for k in range(1, min(7, len(self.buf) + 1)):
                        if "<think>".startswith(self.buf[-k:]):
                            keep = k
                    out.append(self.buf[:len(self.buf) - keep])
                    self.buf = self.buf[len(self.buf) - keep:]
                    break
                out.append(self.buf[:start])
                self.buf = self.buf[start + 7:]
                self.inside = True
        return "".join(out)

    def flush(self):
        rest = "" if self.inside else self.buf
        self.buf = ""
        return rest


class LLM:
    def __init__(self, cfg):
        self.backend = cfg.get("backend", "ollama")
        self.url = cfg.get("url", "http://localhost:11434").rstrip("/")
        self.model = cfg.get("model", "")
        self.embed_model = cfg.get("embed_model", "")
        self.num_ctx = int(cfg.get("num_ctx", 16384))
        self.temperature = float(cfg.get("temperature", 0.3))

    # ---- モデル一覧 ----
    def list_models(self):
        if self.backend == "ollama":
            data = _get(self.url + "/api/tags")
            return [m["name"] for m in data.get("models", [])]
        data = _get(self.url + "/models")
        return [m["id"] for m in data.get("data", [])]

    # ---- 文章生成（少しずつ返す） ----
    def stream_chat(self, messages, temperature=None):
        if not self.model:
            raise LLMError("使うモデルが設定されていません。右上の ⚙ から選んでください。")
        temp = self.temperature if temperature is None else temperature
        filt = ThinkFilter()
        for piece in self._raw_stream(messages, temp):
            text = filt.feed(piece)
            if text:
                yield text
        rest = filt.flush()
        if rest:
            yield rest

    def _raw_stream(self, messages, temp):
        if self.backend == "ollama":
            payload = {
                "model": self.model, "messages": messages, "stream": True,
                "options": {"temperature": temp, "num_ctx": self.num_ctx},
            }
            with _post(self.url + "/api/chat", payload) as r:
                for line in r:
                    if not line.strip():
                        continue
                    obj = json.loads(line)
                    if obj.get("error"):
                        raise LLMError(obj["error"])
                    piece = (obj.get("message") or {}).get("content", "")
                    if piece:
                        yield piece
                    if obj.get("done"):
                        break
        else:
            payload = {"model": self.model, "messages": messages, "stream": True, "temperature": temp}
            with _post(self.url + "/chat/completions", payload) as r:
                for line in r:
                    line = line.decode("utf-8").strip()
                    if not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if data == "[DONE]":
                        break
                    obj = json.loads(data)
                    choices = obj.get("choices") or [{}]
                    piece = (choices[0].get("delta") or {}).get("content") or ""
                    if piece:
                        yield piece

    def chat(self, messages, temperature=None):
        return "".join(self.stream_chat(messages, temperature))

    # ---- 埋め込み（意味検索用のベクトル） ----
    def embed(self, texts):
        """埋め込みモデルが未設定なら None（そのときはキーワード検索だけで動く）"""
        if not self.embed_model or not texts:
            return None
        out = []
        for i in range(0, len(texts), 32):
            batch = texts[i:i + 32]
            if self.backend == "ollama":
                with _post(self.url + "/api/embed", {"model": self.embed_model, "input": batch}) as r:
                    out.extend(json.loads(r.read())["embeddings"])
            else:
                with _post(self.url + "/embeddings", {"model": self.embed_model, "input": batch}) as r:
                    out.extend(d["embedding"] for d in json.loads(r.read())["data"])
        return out
