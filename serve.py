#!/usr/bin/env python3
"""누끼 로컬 서버. 정적 파일만 제공하며 업로드를 받는 엔드포인트가 없습니다.

  python3 serve.py            # http://localhost:8000 (이 PC에서만 접속)
  python3 serve.py --lan      # 같은 Wi-Fi의 휴대폰에서 접속 (http://<PC IP>:8000)
"""
import argparse
import functools
import http.server
import os

http.server.SimpleHTTPRequestHandler.extensions_map.update({
    ".mjs": "text/javascript",
    ".js": "text/javascript",
    ".wasm": "application/wasm",
    ".webmanifest": "application/manifest+json",
    ".onnx": "application/octet-stream",
})


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # 교차 출처 격리: WASM 멀티스레드 활성화
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Content-Type-Options", "nosniff")
        if self.path.endswith((".html", "/", ".js", ".webmanifest")):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def do_POST(self):
        self.send_error(405)

    do_PUT = do_DELETE = do_PATCH = do_POST


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--port", type=int, default=8000)
    p.add_argument("--lan", action="store_true", help="같은 네트워크의 다른 기기에서 접속 허용")
    a = p.parse_args()
    host = "0.0.0.0" if a.lan else "127.0.0.1"
    root = os.path.dirname(os.path.abspath(__file__))
    srv = http.server.ThreadingHTTPServer((host, a.port), functools.partial(Handler, directory=root))
    print(f"누끼 실행 중: http://localhost:{a.port}" + ("  (LAN 접속 허용)" if a.lan else ""))
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
