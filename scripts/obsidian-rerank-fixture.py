"""Deterministic protocol fixture only; never a model or production endpoint."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import sys
import time
from pathlib import Path

class Fixture(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        if self.path not in {"/v1/rerank", "/v1/chat/completions"}:
            self.send_error(404)
            return
        auth = self.headers.get("Authorization")
        if auth not in {"Bearer fixture-success", "Bearer fixture-delay", "Bearer fixture-bad-citation"}:
            self.send_error(401)
            return
        try:
            size = int(self.headers.get("Content-Length", "0"))
            assert 0 < size <= 4096
            body = json.loads(self.rfile.read(size))
            if self.path == "/v1/rerank":
                assert set(body) == {"model", "query", "documents", "top_n",
                                     "max_tokens_per_query", "max_tokens_per_doc"}
                assert body["model"] == "synthetic-reranker@fixture-v1"
                assert body["query"] == "REQ-OKS-RERANK"
                assert sorted(body["documents"]) == ["REQ-OKS-RERANK: alpha", "REQ-OKS-RERANK: beta"]
                assert body["top_n"] == 2
                assert body["max_tokens_per_query"] == body["max_tokens_per_doc"] == 0
            else:
                assert set(body) == {"model", "stream", "temperature", "max_tokens", "messages", "response_format"}
                assert body["model"] == "synthetic-generator@fixture-v1"
                assert body["stream"] is False and body["max_tokens"] == 128
                payload = json.loads(body["messages"][1]["content"])
                assert payload["question"] == "REQ-OKS-GENERATION"
                assert sorted(x["text"] for x in payload["passages"]) == [
                    "REQ-OKS-GENERATION: alpha", "REQ-OKS-GENERATION: beta"]
                assert [x["id"] for x in payload["passages"]] == [0, 1]
        except (ValueError, KeyError, AssertionError, TypeError):
            self.send_error(400)
            return
        if auth == "Bearer fixture-delay":
            time.sleep(1.2)
        if self.path == "/v1/rerank":
            result = {"model": body["model"], "results": [
                {"index": 1, "relevance_score": 0.9}, {"index": 0, "relevance_score": 0.1}]}
        else:
            claims = [{"kind": "quotation", "text": payload["passages"][0]["text"],
                       "citationIds": [99 if auth == "Bearer fixture-bad-citation" else 0]},
                      {"kind": "inference", "text": "<img src=x onerror=alert(1)> synthetic inference",
                       "citationIds": [0, 1]}]
            result = {"model": body["model"], "usage": {"completion_tokens": 32},
                      "choices": [{"index": 0, "finish_reason": "stop", "message": {
                          "role": "assistant", "content": json.dumps({"claims": claims})}}]}
        response = json.dumps(result).encode()
        try:
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(response)))
            self.end_headers()
            self.wfile.write(response)
        except (BrokenPipeError, ConnectionResetError):
            pass

if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", 18765), Fixture)
    Path(sys.argv[1]).touch()
    server.serve_forever()
