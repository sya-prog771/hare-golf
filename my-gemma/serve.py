"""自作 Gemma を OpenAI 互換の API サーバーとして動かす

  python serve.py --model out/sft/model.pt            → http://localhost:8000/v1

ノートブックAI（../local-notebook）の ⚙ 設定で
  LLMの種類: OpenAI互換 / URL: http://localhost:8000/v1 / モデル: my-gemma
にすると、自作モデルで質問応答や文書作成ができます。
"""
import argparse
import json
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from chat import load_model, stream_text

MODEL_NAME = "my-gemma"


class Handler(BaseHTTPRequestHandler):
    model = tok = None
    lock = threading.Lock()  # 1つのモデルを同時に使わないように

    def log_message(self, fmt, *a):
        pass

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.rstrip("/") in ("/v1/models", "/models"):
            return self._json(200, {"object": "list", "data": [{"id": MODEL_NAME, "object": "model", "owned_by": "me"}]})
        self._json(404, {"error": {"message": "not found"}})

    def do_POST(self):
        if self.path.rstrip("/") not in ("/v1/chat/completions", "/chat/completions"):
            return self._json(404, {"error": {"message": "not found"}})
        req = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        msgs = [{"role": m["role"], "content": m["content"] if isinstance(m["content"], str)
                 else "".join(p.get("text", "") for p in m["content"])} for m in req.get("messages", [])]
        cfg = self.model.cfg
        max_new = int(req.get("max_tokens") or req.get("max_completion_tokens") or 1024)
        max_new = max(16, min(max_new, cfg.max_seq_len // 2))
        ids = self.tok.chat_ids(msgs)
        limit = cfg.max_seq_len - max_new
        if len(ids) > limit:  # 長すぎる入力は先頭（指示）と末尾（質問）を残して中ほどを削る
            ids = ids[:64] + ids[-(limit - 64):]
        gen = dict(max_new_tokens=max_new, temperature=float(req.get("temperature", 0.7)),
                   top_p=float(req.get("top_p", 0.95)), top_k=50, repetition_penalty=1.1)
        rid, created = "chatcmpl-" + uuid.uuid4().hex[:12], int(time.time())

        def chunk(delta, finish=None):
            return {"id": rid, "object": "chat.completion.chunk", "created": created, "model": MODEL_NAME,
                    "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}

        with self.lock:
            if req.get("stream"):
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-cache")
                self.end_headers()
                try:
                    self.wfile.write(f"data: {json.dumps(chunk({'role': 'assistant'}))}\n\n".encode())
                    for piece in stream_text(self.model, self.tok, ids, **gen):
                        self.wfile.write(f"data: {json.dumps(chunk({'content': piece}), ensure_ascii=False)}\n\n".encode())
                        self.wfile.flush()
                    self.wfile.write(f"data: {json.dumps(chunk({}, 'stop'))}\n\ndata: [DONE]\n\n".encode())
                except (BrokenPipeError, ConnectionResetError):
                    pass
            else:
                text = "".join(stream_text(self.model, self.tok, ids, **gen))
                self._json(200, {"id": rid, "object": "chat.completion", "created": created, "model": MODEL_NAME,
                                 "choices": [{"index": 0, "message": {"role": "assistant", "content": text},
                                              "finish_reason": "stop"}],
                                 "usage": {"prompt_tokens": len(ids), "completion_tokens": len(self.tok.encode(text))}})


def main():
    global MODEL_NAME
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="out/sft/model.pt")
    ap.add_argument("--name", default=MODEL_NAME)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--device", default="auto")
    args = ap.parse_args()
    MODEL_NAME = args.name
    Handler.model, Handler.tok, is_chat = load_model(args.model, args.device)
    if not is_chat:
        print("注意: SFT 前のモデルです。質問への答え方はまだ学習していません")
    print(f"{args.model} を http://{args.host}:{args.port}/v1 で公開しました（モデル名: {MODEL_NAME}）")
    ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
