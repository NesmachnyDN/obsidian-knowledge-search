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
        if self.path != "/v1/rerank":
            self.send_error(404)
            return
        auth = self.headers.get("Authorization")
        if auth not in {"Bearer fixture-success", "Bearer fixture-delay"}:
            self.send_error(401)
            return
        try:
            size = int(self.headers.get("Content-Length", "0"))
            assert 0 < size <= 4096
            body = json.loads(self.rfile.read(size))
            assert set(body) == {"model", "query", "documents", "top_n",
                                 "max_tokens_per_query", "max_tokens_per_doc"}
            assert body["model"] == "synthetic-reranker@fixture-v1"
            assert body["query"] == "REQ-OKS-RERANK"
            assert sorted(body["documents"]) == ["REQ-OKS-RERANK: alpha", "REQ-OKS-RERANK: beta"]
            assert body["top_n"] == 2
            assert body["max_tokens_per_query"] == body["max_tokens_per_doc"] == 0
        except (ValueError, KeyError, AssertionError, TypeError):
            self.send_error(400)
            return
        if auth == "Bearer fixture-delay":
            time.sleep(1.2)
        response = json.dumps({"model": body["model"], "results": [
            {"index": 1, "relevance_score": 0.9}, {"index": 0, "relevance_score": 0.1}]}).encode()
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
