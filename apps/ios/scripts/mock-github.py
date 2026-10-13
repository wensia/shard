#!/usr/bin/env python3
"""Serves a local bare git repository through the slice of the GitHub REST API the
iOS app uses, so debug builds and UI tests run against real vault data offline.

    git clone --bare ~/Documents/ShardVault /tmp/vault.git
    apps/ios/scripts/mock-github.py /tmp/vault.git 18787

Debug builds point at it with `-githubAPIBase http://127.0.0.1:18787`. Any token is accepted.
"""

import base64
import json
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlparse

REPO = sys.argv[1]
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 18787


def git(*args, stdin=None, env=None):
    return subprocess.run(
        ["git", "-C", REPO, *args], check=True, capture_output=True, input=stdin, env=env
    ).stdout


def resolve(ref):
    try:
        return git("rev-parse", "--verify", "--quiet", ref).decode().strip()
    except subprocess.CalledProcessError:
        return None


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        sys.stderr.write("mock-github: " + format % args + "\n")

    def parts(self):
        return [unquote(p) for p in urlparse(self.path).path.strip("/").split("/")]

    def send(self, status, body, content_type="application/json"):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def not_found(self):
        self.send(404, {"message": "Not Found"})

    def do_GET(self):
        p = self.parts()
        if len(p) < 4 or p[0] != "repos":
            return self.not_found()
        rest = p[3:]
        if rest[0] == "branches" and len(rest) == 2:
            commit = resolve(f"refs/heads/{rest[1]}")
            if not commit:
                return self.not_found()
            tree = resolve(f"{commit}^{{tree}}")
            return self.send(200, {"name": rest[1], "commit": {"sha": commit, "commit": {"tree": {"sha": tree}}}})
        if rest[:2] == ["git", "trees"] and len(rest) == 3:
            entries = []
            for record in git("ls-tree", "-r", "-l", "-z", rest[2]).split(b"\0"):
                if not record:
                    continue
                meta, path = record.split(b"\t", 1)
                mode, kind, sha, size = meta.split()
                entries.append({
                    "path": path.decode(), "mode": mode.decode(), "type": kind.decode(),
                    "sha": sha.decode(), "size": None if size == b"-" else int(size),
                })
            return self.send(200, {"sha": rest[2], "tree": entries, "truncated": False})
        if rest[:2] == ["git", "blobs"] and len(rest) == 3:
            try:
                data = git("cat-file", "blob", rest[2])
            except subprocess.CalledProcessError:
                return self.not_found()
            return self.send(200, data, "application/octet-stream")
        if rest[0] == "contents" and len(rest) >= 2:
            path = "/".join(rest[1:])
            branch = (urlparse(self.path).query.partition("ref=")[2] or "main").split("&")[0]
            try:
                sha = git("rev-parse", f"refs/heads/{branch}:{path}").decode().strip()
                data = git("cat-file", "blob", sha)
            except subprocess.CalledProcessError:
                return self.not_found()
            return self.send(200, {"type": "file", "path": path, "sha": sha, "encoding": "base64",
                                   "content": base64.b64encode(data).decode()})
        return self.not_found()

    def do_PUT(self):
        """`PUT contents/{path}`: creates a commit adding a new file on the branch."""
        p = self.parts()
        if len(p) < 5 or p[0] != "repos" or p[3] != "contents":
            return self.not_found()
        path = "/".join(p[4:])
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        branch = body.get("branch", "main")
        parent = resolve(f"refs/heads/{branch}")
        if resolve(f"{parent}:{path}") and "sha" not in body:
            return self.send(422, {"message": "Invalid request.\n\n\"sha\" wasn't supplied."})
        blob = git("hash-object", "-w", "--stdin", stdin=base64.b64decode(body["content"])).decode().strip()
        index = f"/tmp/mock-github-index-{PORT}"
        env = {"GIT_INDEX_FILE": index, "PATH": "/usr/bin:/bin:/opt/homebrew/bin",
               "GIT_AUTHOR_NAME": "Shard iOS", "GIT_AUTHOR_EMAIL": "ios@shard.local",
               "GIT_COMMITTER_NAME": "GitHub", "GIT_COMMITTER_EMAIL": "noreply@github.com"}
        git("read-tree", parent, env=env)
        git("update-index", "--add", "--cacheinfo", f"100644,{blob},{path}", env=env)
        tree = git("write-tree", env=env).decode().strip()
        commit = git("commit-tree", tree, "-p", parent, "-m", body["message"], env=env).decode().strip()
        git("update-ref", f"refs/heads/{branch}", commit, parent)
        return self.send(201, {"content": {"path": path, "sha": blob}, "commit": {"sha": commit}})


if __name__ == "__main__":
    print(f"mock-github: serving {REPO} on http://127.0.0.1:{PORT}", file=sys.stderr)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
