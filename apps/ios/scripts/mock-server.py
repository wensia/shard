#!/usr/bin/env python3
"""Isolated, in-memory shard-server fixture for the native iOS login tests.

    python3 apps/ios/scripts/mock-server.py --port 18789
    python3 apps/ios/scripts/mock-server.py --self-test

Only binds 127.0.0.1. No vault, database, real account, or GitHub token is used.
Debug app launch: -debugReset YES -debugServer http://127.0.0.1:18789
"""

import argparse
import base64
import hashlib
import json
import re
import socket
import sys
import threading
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse


EMAIL = "me@example.com"
PASSWORD = "correct horse battery"
STAMP = "2026-10-31T08:00:00+08:00"
FRAGMENT_ID = "20261031-080000-a1b2c3d4-010203"
INLINE_MAX = 1024 * 1024


def fragment_bytes(fragment_id, created_at, body, tags, source="ios"):
    scalar = lambda value: json.dumps(value, ensure_ascii=False)
    fields = [f"id: {scalar(fragment_id)}", f"created_at: {scalar(created_at)}",
              f"updated_at: {scalar(created_at)}", "tags: " + scalar(tags),
              "category: null", "ai_status: none", f"source: {scalar(source)}"]
    return ("---\n" + "\n".join(fields) + "\n---\n\n" + body.rstrip() + "\n").encode()


class Fixture:
    def __init__(self):
        self.lock = threading.RLock()
        self.reset()

    def reset(self):
        with self.lock:
            png = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5AAAAABJRU5ErkJggg==")
            image_sha = hashlib.sha256(png).hexdigest()
            large = b"fixture-large-asset\n" * 60_000
            large_sha = hashlib.sha256(large).hexdigest()
            self.files = {
                f"fragments/2026/10/{FRAGMENT_ID}.md": fragment_bytes(
                    FRAGMENT_ID, STAMP, "服务器上的测试碎片 #登录测试", ["inbox", "登录测试"], "web"),
                "notes/登录测试.md": "---\ntags: [登录测试]\n---\n\n# 服务器笔记\n账号登录后的资料库内容。\n".encode(),
                f"assets/{image_sha[:2]}/{image_sha}.png": png,
                f"assets/{large_sha[:2]}/{large_sha}.bin": large,
                "lockbox/fragments/hidden.shard": b"fixture-only-hidden-lockbox",
                ".trash/fragments/hidden.md": b"fixture-only-hidden-trash",
                ".shard/internal.json": b"{}",
            }
            self.head = 1
            self.tokens = set()
            self.login_count = 0
            self.created_count = 0
            self.create_attempts = 0
            self.replayed_count = 0
            self.recorded = {}
            self.offline = False
            self.drop_next_create_response = False


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    @property
    def fixture(self):
        return self.server.fixture

    def log_message(self, message, *args):
        # Request paths only; never log Authorization or request bodies.
        sys.stderr.write("mock-server: " + message % args + "\n")

    def reply(self, status, body, content_type="application/json", headers=None):
        data = body if isinstance(body, bytes) else json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        if self.command != "HEAD":
            try:
                self.wfile.write(data)
            except (BrokenPipeError, ConnectionResetError):
                pass

    def error(self, status, code, message):
        self.reply(status, {"code": code, "message": message})

    def body(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length > 1024 * 1024:
            raise ValueError("body too large")
        raw = self.rfile.read(length)
        return raw, json.loads(raw or b"{}")

    def authorized(self):
        with self.fixture.lock:
            if self.fixture.offline:
                self.error(503, "UNAVAILABLE", "服务器暂不可用。")
                return False
            token = self.headers.get("Authorization", "").removeprefix("Bearer ")
            if token not in self.fixture.tokens:
                self.error(401, "UNAUTHENTICATED", "登录已失效。")
                return False
        return True

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        url = urlparse(self.path)
        path = unquote(url.path)
        if path == "/healthz":
            return self.reply(200, b"ok", "text/plain")
        if path == "/__test/state":
            marker = parse_qs(url.query).get("marker", [""])[0].encode()
            with self.fixture.lock:
                matching = sum(path.startswith("fragments/") and marker in data
                               for path, data in self.fixture.files.items()) if marker else 0
                return self.reply(200, {"loginCount": self.fixture.login_count,
                    "createdCount": self.fixture.created_count, "createAttempts": self.fixture.create_attempts,
                    "replayedCount": self.fixture.replayed_count, "activeTokens": len(self.fixture.tokens),
                    "matchingFragmentCount": matching, "headSeq": self.fixture.head})
        if not self.authorized():
            return
        with self.fixture.lock:
            if path == "/api/sync/manifest":
                entries = [{"path": name, "kind": "file", "sha": hashlib.sha256(data).hexdigest(),
                            "size": len(data), "seq": self.fixture.head}
                           for name, data in sorted(self.fixture.files.items())]
                return self.reply(200, {"vaultId": "shard://test/ios-login", "epoch": "fixture-1",
                                        "headSeq": self.fixture.head, "entries": entries})
            if path.startswith("/api/blobs/"):
                sha = path.removeprefix("/api/blobs/")
                for data in self.fixture.files.values():
                    if len(data) > INLINE_MAX and hashlib.sha256(data).hexdigest() == sha:
                        return self.reply(200, data, "application/octet-stream")
            if path.startswith("/api/files/"):
                data = self.fixture.files.get(path.removeprefix("/api/files/"))
                if data is not None:
                    return self.reply(200, data, "application/octet-stream")
        self.error(404, "NOT_FOUND", "找不到文件。")

    def do_POST(self):
        path = urlparse(self.path).path
        try:
            raw, body = self.body()
        except (ValueError, json.JSONDecodeError):
            return self.error(400, "INVALID_ARGS", "请求无效。")
        if path.startswith("/__test/"):
            return self.control(path, body)
        if path == "/api/device/login":
            with self.fixture.lock:
                if self.fixture.offline:
                    return self.error(503, "UNAVAILABLE", "服务器暂不可用。")
                if body.get("kind") not in ("desktop", "cli"):
                    return self.error(400, "INVALID_ARGS", "kind 只能是 desktop 或 cli。")
                if body.get("email", "").strip().lower() != EMAIL or body.get("password") != PASSWORD:
                    return self.error(401, "INVALID_CREDENTIALS", "邮箱或密码不对。")
                if not body.get("name", "").strip():
                    return self.error(400, "INVALID_ARGS", "请给设备起个名字。")
                self.fixture.login_count += 1
                token = f"shd_dev_fixture_{self.fixture.login_count}"
                self.fixture.tokens.add(token)
                return self.reply(200, {"token": token, "deviceId": f"dev_fixture_{self.fixture.login_count}",
                                        "name": body["name"]})
        if not self.authorized():
            return
        if path == "/api/sync/fetch":
            with self.fixture.lock:
                items = []
                for name in body.get("paths", []):
                    data = self.fixture.files.get(name)
                    if data is None:
                        items.append({"path": name, "missing": True})
                    else:
                        item = {"path": name, "sha": hashlib.sha256(data).hexdigest(),
                                "createdAt": STAMP, "modifiedAt": STAMP}
                        if len(data) > INLINE_MAX:
                            item["blob"] = True
                        else:
                            item["data"] = base64.b64encode(data).decode()
                        items.append(item)
                return self.reply(200, {"items": items})
        if path == "/api/rpc/create_fragment":
            return self.create_fragment(raw, body)
        self.error(404, "UNKNOWN_COMMAND", "操作不存在。")

    def control(self, path, body):
        with self.fixture.lock:
            if path == "/__test/reset":
                self.fixture.reset()
            elif path == "/__test/revoke":
                self.fixture.tokens.clear()
            elif path == "/__test/offline":
                self.fixture.offline = bool(body.get("enabled"))
            elif path == "/__test/drop-next-create-response":
                self.fixture.drop_next_create_response = True
            else:
                return self.error(404, "NOT_FOUND", "测试操作不存在。")
        self.reply(200, {"ok": True})

    def create_fragment(self, raw, body):
        key = self.headers.get("Idempotency-Key", "").strip()
        if not key:
            return self.error(400, "INVALID_ARGS", "写操作必须带 Idempotency-Key。")
        request_sha = hashlib.sha256(b"create_fragment\n" + raw).hexdigest()
        with self.fixture.lock:
            self.fixture.create_attempts += 1
            recorded = self.fixture.recorded.get(key)
            if recorded:
                previous_sha, reply = recorded
                if previous_sha != request_sha:
                    return self.error(409, "IDEMPOTENCY_MISMATCH", "幂等键已用于其他请求。")
                self.fixture.replayed_count += 1
                return self.reply(200, reply, headers={"X-Shard-Replayed": "1"})
            fragment_id = body.get("id", "")
            created_at = body.get("createdAt", "")
            if not re.fullmatch(r"\d{8}-\d{6}-[a-fA-F0-9]{8}-[a-fA-F0-9]{6}", fragment_id):
                return self.error(400, "INVALID_ARGS", "片段 id 无效。")
            try:
                created = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
                if created.tzinfo is None:
                    raise ValueError("timezone missing")
            except (TypeError, ValueError):
                return self.error(400, "INVALID_ARGS", "createdAt 无效。")
            content = body.get("content", "").strip()
            tags = body.get("tags") or ["inbox"]
            if not content:
                return self.error(400, "INVALID_ARGS", "内容不能为空。")
            if any(tag in ("密匣", "lockbox") for tag in tags):
                return self.error(409, "LOCKBOX_UNAVAILABLE", "密匣暂不可用。")
            name = f"fragments/{created.year:04d}/{created.month:02d}/{fragment_id}.md"
            if name in self.fixture.files:
                return self.error(409, "FRAGMENT_EXISTS", "片段已存在。")
            self.fixture.files[name] = fragment_bytes(fragment_id, created_at, content, tags, body.get("source", "ios"))
            self.fixture.created_count += 1
            self.fixture.head += 1
            reply = {"id": fragment_id, "path": name, "content": content, "tags": tags,
                     "createdAt": created_at, "updatedAt": created_at, "source": body.get("source", "ios"),
                     "pinned": False, "archived": False, "lockbox": False}
            self.fixture.recorded[key] = (request_sha, reply)
            if self.fixture.drop_next_create_response:
                self.fixture.drop_next_create_response = False
                self.close_connection = True
                try:
                    self.connection.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
                return
            self.reply(200, reply)


def make_server(port):
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.fixture = Fixture()
    return server


def self_test():
    from http.client import RemoteDisconnected
    from urllib.error import HTTPError
    from urllib.request import Request, urlopen

    server = make_server(0)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_port}"
    token = None

    def request(path, body=None, key=None):
        headers = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = "Bearer " + token
        if key:
            headers["Idempotency-Key"] = key
        req = Request(base + path, data=None if body is None else json.dumps(body).encode(), headers=headers)
        try:
            with urlopen(req, timeout=5) as response:
                return response.status, response.read()
        except HTTPError as error:
            return error.code, error.read()

    try:
        assert request("/api/sync/manifest")[0] == 401
        login = {"email": EMAIL, "password": "wrong", "name": "测试 iPhone", "kind": "desktop"}
        assert request("/api/device/login", login)[0] == 401
        login["password"] = PASSWORD
        status, raw = request("/api/device/login", login)
        assert status == 200
        token = json.loads(raw)["token"]
        manifest = json.loads(request("/api/sync/manifest")[1])
        for entry in manifest["entries"]:
            status, raw = request("/api/sync/fetch", {"paths": [entry["path"]]})
            assert status == 200
            item = json.loads(raw)["items"][0]
            if item.get("blob"):
                status, data = request("/api/blobs/" + entry["sha"])
                assert status == 200 and entry["size"] > INLINE_MAX
            else:
                data = base64.b64decode(item["data"])
                assert entry["size"] <= INLINE_MAX
                assert request("/api/blobs/" + entry["sha"])[0] == 404
            assert hashlib.sha256(data).hexdigest() == entry["sha"]
        payload = {"id": "20261031-091500-a1b2c3d4-aabbcc", "createdAt": STAMP,
                   "content": "离线重试标记", "tags": ["inbox"], "source": "ios"}
        assert request("/api/rpc/create_fragment", payload)[0] == 400
        assert request("/api/rpc/create_fragment", payload, "fixture-op")[0] == 200
        assert request("/api/rpc/create_fragment", payload, "fixture-op")[0] == 200
        assert request("/api/rpc/create_fragment", {**payload, "content": "其他内容"}, "fixture-op")[0] == 409
        state = json.loads(request("/__test/state")[1])
        assert state["createdCount"] == 1 and state["replayedCount"] == 1
        lost = {**payload, "id": "20261031-091501-a1b2c3d4-aabbcd", "content": "丢失响应标记"}
        request("/__test/drop-next-create-response", {})
        try:
            request("/api/rpc/create_fragment", lost, "fixture-lost-reply")
        except RemoteDisconnected:
            pass
        else:
            raise AssertionError("fixture did not drop the committed response")
        assert request("/api/rpc/create_fragment", lost, "fixture-lost-reply")[0] == 200
        state = json.loads(request("/__test/state")[1])
        assert state["createdCount"] == 2 and state["replayedCount"] == 2
        request("/__test/offline", {"enabled": True})
        assert request("/api/sync/manifest")[0] == 503
        request("/__test/offline", {"enabled": False})
        request("/__test/revoke", {})
        assert request("/api/sync/manifest")[0] == 401
        request("/__test/reset", {})
        assert json.loads(request("/__test/state")[1])["createdCount"] == 0
        print("mock-server self-test passed")
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=18789)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
    else:
        server = make_server(args.port)
        print(f"mock-server listening at http://127.0.0.1:{server.server_port}", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            server.server_close()
