#!/usr/bin/env python3
"""Disposable Rust server + loopback control proxy for WKWebView acceptance tests.

python3 apps/ios/scripts/web-server-fixture.py --server-bin target/debug/shard-server
python3 apps/ios/scripts/web-server-fixture.py --server-bin target/debug/shard-server --self-test

The server owns a TemporaryDirectory; no existing database or account is opened.
API requests, cookies and SSE are forwarded without replacing the real RPC layer.
"""

import argparse
import atexit
import contextlib
import http.client
import json
import os
from pathlib import Path
import re
import signal
import socket
import sqlite3
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse


EMAIL = "me@example.com"
PASSWORD = "correct horse battery"
SEED_ID = "20261031-080000-a1b2c3d4-010203"
SEED_BODY = "- [ ] 项目\n- [x] 完成\n甲\\\n乙\n\n字面 / 和 \\路径"
HOP_HEADERS = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
               "te", "trailer", "transfer-encoding", "upgrade", "content-length"}


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class Fixture:
    def __init__(self, binary, proxy_port, backend_port):
        self.binary = Path(binary).resolve(strict=True)
        if not self.binary.is_file() or not os.access(self.binary, os.X_OK):
            raise ValueError("--server-bin must be an executable shard-server")
        self.proxy_port = proxy_port
        self.backend_port = backend_port
        self.origin = f"http://localhost:{proxy_port}"
        self.lock = threading.RLock()
        self.process = None
        self.directory = None
        self.log = None
        self.paused = True
        self.create_attempts = 0
        self.stream_sockets = set()
        atexit.register(self.close)

    def backend(self, method, path, body=None, headers=None, timeout=10):
        connection = http.client.HTTPConnection("127.0.0.1", self.backend_port, timeout=timeout)
        try:
            data = None if body is None else json.dumps(body, ensure_ascii=False).encode()
            fields = {"Host": f"localhost:{self.proxy_port}", "Origin": self.origin,
                      "X-Shard-Request": "1", "Content-Type": "application/json", **(headers or {})}
            connection.request(method, path, data, fields)
            response = connection.getresponse()
            return response.status, response.getheaders(), response.read()
        finally:
            connection.close()

    def cli(self, command, *extra):
        return subprocess.run(
            [str(self.binary), command, "--data-dir", str(self.data_dir),
             "--origin", self.origin, *extra], capture_output=True, text=True,
            timeout=15, check=True,
        ).stdout

    @property
    def data_dir(self):
        return Path(self.directory.name) / "data"

    def reset(self, body=SEED_BODY):
        with self.lock:
            self.close()
            # Refuse an occupied backend port before starting a child; never reuse
            # or terminate another service that happens to be listening there.
            with socket.socket() as check:
                check.bind(("127.0.0.1", self.backend_port))
            self.directory = tempfile.TemporaryDirectory(prefix="shard-ios-web-fixture-")
            self.data_dir.mkdir()
            self.log = open(Path(self.directory.name) / "server.log", "w+")
            self.process = subprocess.Popen(
                [str(self.binary), "serve", "--data-dir", str(self.data_dir),
                 "--origin", self.origin, "--listen", f"127.0.0.1:{self.backend_port}"],
                stdout=self.log, stderr=subprocess.STDOUT,
                env={**os.environ, "NO_COLOR": "1", "RUST_LOG": "info"},
            )
            deadline = time.monotonic() + 12
            while time.monotonic() < deadline:
                if self.process.poll() is not None:
                    self.log.flush()
                    self.log.seek(0)
                    raise RuntimeError("private shard-server exited before readiness: "
                                       + self.log.read()[-1000:])
                try:
                    status, _, content = self.backend("GET", "/healthz", timeout=1)
                    if status == 200 and content == b"ok":
                        break
                except OSError:
                    pass
                time.sleep(0.05)
            else:
                raise RuntimeError("private shard-server did not become ready")

            token = re.search(r"#token=([^\s]+)", self.cli("setup")).group(1)
            status, headers, _ = self.backend("POST", "/api/auth/setup", {
                "token": token, "email": EMAIL, "password": PASSWORD,
            })
            if status != 200:
                raise RuntimeError(f"fixture setup failed with HTTP {status}")
            cookie = "; ".join(value.split(";", 1)[0] for name, value in headers
                               if name.lower() == "set-cookie")
            status, _, _ = self.backend("POST", "/api/rpc/create_fragment", {
                "id": SEED_ID, "createdAt": "2026-10-31T08:00:00+08:00",
                "content": body, "tags": ["inbox"], "source": "web",
            }, {"Cookie": cookie, "Idempotency-Key": "fixture-seed"})
            if status != 200:
                raise RuntimeError(f"fixture seed failed with HTTP {status}")
            self.create_attempts = 0
            self.paused = False

    def close(self):
        with self.lock:
            self.pause()
            if self.process is not None:
                self.process.terminate()
                try:
                    self.process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait(timeout=5)
                self.process = None
            if self.log is not None:
                self.log.close()
                self.log = None
            if self.directory is not None:
                self.directory.cleanup()
                self.directory = None

    def pause(self):
        with self.lock:
            self.paused = True
            # A lost connection also ends already-open SSE streams. Returning
            # 503 only to new requests would leave SSE falsely online forever.
            for sock in tuple(self.stream_sockets):
                with contextlib.suppress(OSError):
                    sock.shutdown(socket.SHUT_RDWR)

    def state(self, marker):
        with self.lock:
            with contextlib.closing(sqlite3.connect(
                f"file:{self.data_dir / 'shard.db'}?mode=ro", uri=True,
            )) as database:
                rows = database.execute(
                    "SELECT path, inline FROM nodes WHERE kind='file' AND path LIKE 'fragments/%'"
                ).fetchall()
                notes = database.execute(
                    "SELECT inline FROM nodes WHERE kind='file' AND path LIKE 'notes/%'"
                ).fetchall()
                created = database.execute(
                    "SELECT count(*) FROM txns WHERE command='create_fragment'"
                ).fetchone()[0] - 1
            with contextlib.closing(sqlite3.connect(
                f"file:{self.data_dir / 'auth.db'}?mode=ro", uri=True,
            )) as auth:
                events = dict(auth.execute(
                    "SELECT event, count(*) FROM audit_log GROUP BY event"
                ).fetchall())
            return {"paused": self.paused, "backendPID": self.process.pid,
                    "fragmentCount": len(rows), "createdCount": created,
                    "createAttempts": self.create_attempts,
                    "loginCount": events.get("login.success", 0),
                    "rejectedLoginCount": events.get("login.failure", 0) + events.get("device.login_failure", 0),
                    "deviceLoginCount": events.get("device.created", 0),
                    "matchingNoteCount": sum(marker.encode() in (data or b"")
                                              for (data,) in notes) if marker else 0,
                    "matchingFragmentCount": sum(marker.encode() in (data or b"")
                                                 for _, data in rows) if marker else 0}


class Proxy(ThreadingHTTPServer):
    daemon_threads = True


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_args):
        pass  # Never log cookies, authorization, setup links or request bodies.

    def json_reply(self, status, body):
        data = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def request_body(self):
        length = int(self.headers.get("Content-Length", "0"))
        if not 0 <= length <= 64 * 1024 * 1024:
            raise ValueError("request body is too large")
        return self.rfile.read(length) if length else None

    def handle_request(self):
        fixture = self.server.fixture
        parsed = urlparse(self.path)
        try:
            body = self.request_body()
            if parsed.path.startswith("/__test/"):
                if self.command == "GET" and parsed.path == "/__test/state":
                    marker = parse_qs(parsed.query).get("marker", [""])[0]
                    return self.json_reply(200, fixture.state(marker))
                if self.command != "POST":
                    return self.json_reply(405, {"code": "METHOD_NOT_ALLOWED"})
                fields = json.loads(body or b"{}")
                if parsed.path == "/__test/reset":
                    content = fields.get("fragmentContent", SEED_BODY)
                    if not isinstance(content, str):
                        raise ValueError("fragmentContent must be a string")
                    fixture.reset(content)
                elif parsed.path == "/__test/pause":
                    fixture.pause()
                elif parsed.path == "/__test/resume":
                    fixture.paused = False
                elif parsed.path == "/__test/revoke-all":
                    fixture.cli("reset-password", "--revoke-all")
                else:
                    return self.json_reply(404, {"code": "NOT_FOUND"})
                return self.json_reply(200, {"ok": True})
            if not (parsed.path.startswith("/api/") or parsed.path == "/healthz"):
                return self.json_reply(404, {"code": "NOT_FOUND"})
            if fixture.paused:
                return self.json_reply(503, {"code": "UNAVAILABLE", "message": "服务器暂不可用。"})
            if self.command == "POST" and parsed.path == "/api/rpc/create_fragment":
                with fixture.lock:
                    fixture.create_attempts += 1
            self.forward(body)
        except (ValueError, OSError, http.client.HTTPException) as error:
            if not isinstance(error, (BrokenPipeError, ConnectionResetError)):
                with contextlib.suppress(OSError):
                    self.json_reply(503, {"code": "FIXTURE_UNAVAILABLE", "message": type(error).__name__})

    def forward(self, body):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.fixture.backend_port, timeout=30)
        sockets = set()
        try:
            headers = {name: value for name, value in self.headers.items()
                       if name.lower() not in HOP_HEADERS}
            connection.request(self.command, self.path, body, headers)
            response = connection.getresponse()
            streaming = response.getheader("Content-Type", "").startswith("text/event-stream")
            if streaming:
                sockets = {self.connection}
                if connection.sock is not None:
                    sockets.add(connection.sock)
                with self.server.fixture.lock:
                    self.server.fixture.stream_sockets.update(sockets)
            data = None if streaming else response.read()
            self.send_response(response.status)
            for name, value in response.getheaders():
                if name.lower() not in HOP_HEADERS:
                    self.send_header(name, value)
            if streaming:
                self.send_header("Transfer-Encoding", "chunked")
            else:
                self.send_header("Content-Length", response.getheader("Content-Length", "0")
                                 if self.command == "HEAD" else str(len(data)))
            self.end_headers()
            if self.command == "HEAD":
                return
            if not streaming:
                self.wfile.write(data)
                return
            while chunk := response.read1(4096):
                self.wfile.write(f"{len(chunk):x}\r\n".encode() + chunk + b"\r\n")
                self.wfile.flush()
            self.wfile.write(b"0\r\n\r\n")
        finally:
            with self.server.fixture.lock:
                self.server.fixture.stream_sockets.difference_update(sockets)
            connection.close()

    do_GET = do_POST = do_PUT = do_DELETE = do_HEAD = handle_request


def create_proxy(binary, proxy_port, backend_port):
    server = Proxy(("127.0.0.1", proxy_port), Handler)
    try:
        server.fixture = Fixture(binary, server.server_port, backend_port)
        server.fixture.reset()
    except BaseException:
        if hasattr(server, "fixture"):
            server.fixture.close()
        server.server_close()
        raise
    return server


def self_test(binary):
    server = create_proxy(binary, 0, free_port())
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    cookie = ""

    def request(method, path, body=None, extra=None):
        connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=10)
        try:
            data = None if body is None else json.dumps(body, ensure_ascii=False).encode()
            connection.request(method, path, data, {
                "Content-Type": "application/json", "X-Shard-Request": "1", "Cookie": cookie,
                "Origin": server.fixture.origin, "Host": f"localhost:{server.server_port}",
                **(extra or {}),
            })
            response = connection.getresponse()
            return response.status, response.getheaders(), response.read()
        finally:
            connection.close()

    try:
        assert request("GET", "/__test/state")[0] == 200
        assert request("POST", "/api/auth/login", {"email": EMAIL, "password": "wrong-password"})[0] == 401
        status, headers, _ = request("POST", "/api/auth/login", {"email": EMAIL, "password": PASSWORD})
        assert status == 200
        auth = json.loads(request("GET", "/__test/state")[2])
        assert auth["loginCount"] == auth["rejectedLoginCount"] == 1
        assert auth["deviceLoginCount"] == auth["matchingNoteCount"] == 0
        cookie = "; ".join(value.split(";", 1)[0] for name, value in headers if name.lower() == "set-cookie")
        status, _, body = request("POST", "/api/rpc/list_fragments", {})
        assert status == 200 and SEED_BODY in json.loads(body)["fragments"][0]["content"]
        events = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=5)
        events.request("GET", "/api/events", headers={"Cookie": cookie})
        stream = events.getresponse()
        assert stream.status == 200
        assert b"connected" in stream.read1(4096), "SSE headers and first chunk must flush immediately"
        payload = {"content": "fixture self-test SELFTEST", "tags": ["inbox"]}
        assert request("POST", "/api/rpc/create_fragment", payload, {"Idempotency-Key": "self-test-create"})[0] == 200
        assert request("POST", "/api/rpc/create_fragment", payload, {"Idempotency-Key": "self-test-create"})[0] == 200
        state = json.loads(request("GET", "/__test/state?marker=SELFTEST")[2])
        assert state["createdCount"] == state["matchingFragmentCount"] == 1
        assert b"vault-changed" in stream.read1(4096), "SSE must forward live Rust events"
        assert request("POST", "/__test/pause", {})[0] == 200
        try:
            assert stream.read1(4096) == b"", "Pausing must break existing SSE connections"
        except (http.client.IncompleteRead, ConnectionResetError):
            pass
        stream.close()
        events.close()
        assert request("POST", "/api/rpc/list_fragments", {})[0] == 503
        assert request("POST", "/__test/resume", {})[0] == 200
        assert request("POST", "/api/rpc/list_fragments", {})[0] == 200
        assert request("POST", "/__test/revoke-all", {})[0] == 200
        assert request("POST", "/api/rpc/list_fragments", {})[0] == 401
        assert request("POST", "/__test/reset", {})[0] == 200
        assert json.loads(request("GET", "/__test/state")[2])["createdCount"] == 0
        print("web-server-fixture: real Rust RPC/cookies/SSE, idempotency, pause/resume, revoke/reset passed")
    finally:
        server.shutdown()
        server.server_close()
        server.fixture.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--server-bin", type=Path, default=Path(__file__).resolve().parents[3] / "target/debug/shard-server")
    parser.add_argument("--port", type=int, default=18792)
    parser.add_argument("--backend-port", type=int, default=18793)
    parser.add_argument("--self-test", action="store_true")
    arguments = parser.parse_args()
    if arguments.self_test:
        return self_test(arguments.server_bin)
    if arguments.port == arguments.backend_port or min(arguments.port, arguments.backend_port) < 1024:
        parser.error("choose two distinct non-privileged loopback ports")
    server = create_proxy(arguments.server_bin, arguments.port, arguments.backend_port)
    print(f"web-server-fixture: loopback proxy {server.server_port}, private Rust {arguments.backend_port}", flush=True)
    def interrupt(_signal, _frame):
        raise KeyboardInterrupt()

    signal.signal(signal.SIGTERM, interrupt)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        server.fixture.close()


if __name__ == "__main__":
    main()
