from http.server import HTTPServer, SimpleHTTPRequestHandler
import argparse


class CrossOriginIsolatedHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cross-Origin-Resource-Policy", "cross-origin")
        super().end_headers()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("port", nargs="?", default=8080, type=int)
    args = parser.parse_args()

    server = HTTPServer(("127.0.0.1", args.port), CrossOriginIsolatedHandler)
    print(f"Serving on http://127.0.0.1:{args.port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
