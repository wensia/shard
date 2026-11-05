#!/usr/bin/env python3
"""Loopback stand-in for a MiMo-compatible speech service, for native voice acceptance tests.

python3 apps/ios/scripts/voice-service-fixture.py            # http://127.0.0.1:18794/v1
python3 apps/ios/scripts/voice-service-fixture.py --self-test

POST /v1/chat/completions answers both MiMo calls:
- input_audio (recognition): the WAV must be canonical 16 kHz mono PCM16; replies with fixed text.
- assistant message + audio (synthesis): replies with an 8-second base64 WAV tone (long enough to observe playback).
GET /__voice/state reports counts and the last recording's format; POST /__voice/reset clears them.
Only a fixed test key is accepted, and no request body or key is ever logged.
"""

import argparse
import base64
import io
import json
import math
import struct
import threading
import urllib.request
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

KEY = "test-voice-key"
TEXT = "原生识别文字"
LOCK = threading.Lock()
STATE = {}


def reset():
    with LOCK:
        STATE.clear()
        STATE.update(asr=0, tts=0, unauthorized=0, rejected=0, lastText=None,
                     lastRate=None, lastChannels=None, lastBits=None, lastSeconds=None)


def tone(seconds=8.0, rate=24_000):
    frames = b"".join(struct.pack("<h", int(8000 * math.sin(2 * math.pi * 440 * i / rate)))
                      for i in range(int(seconds * rate)))
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(rate)
        output.writeframes(frames)
    return buffer.getvalue()


def recording_format(data_url):
    prefix = "data:audio/wav;base64,"
    if not data_url.startswith(prefix):
        raise ValueError("not a WAV data URL")
    raw = base64.b64decode(data_url[len(prefix):], validate=True)
    # A canonical header puts "data" right after a 16-byte fmt chunk.
    if raw[:4] != b"RIFF" or raw[8:12] != b"WAVE" or raw[12:16] != b"fmt " or raw[36:40] != b"data":
        raise ValueError("not a canonical WAV")
    with wave.open(io.BytesIO(raw)) as source:
        return source.getframerate(), source.getnchannels(), source.getsampwidth() * 8, source.getnframes() / source.getframerate()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):  # noqa: A002 - keep requests out of the log
        pass

    def send_json(self, value, status=200):
        body = json.dumps(value, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path != "/__voice/state":
            return self.send_json({"error": {"code": "not_found"}}, 404)
        with LOCK:
            self.send_json(dict(STATE))

    def do_POST(self):
        length = int(self.headers.get("content-length") or 0)
        body = self.rfile.read(length)
        if self.path == "/__voice/reset":
            reset()
            return self.send_json({"ok": True})
        if self.path != "/v1/chat/completions":
            return self.send_json({"error": {"code": "not_found"}}, 404)
        if self.headers.get("authorization") != f"Bearer {KEY}":
            with LOCK:
                STATE["unauthorized"] += 1
            return self.send_json({"error": {"code": "invalid_api_key"}}, 401)
        try:
            request = json.loads(body)
            message = request["messages"][0]
            if message["role"] == "assistant":
                if request.get("audio", {}).get("format") != "wav":
                    raise ValueError("synthesis must request WAV")
                with LOCK:
                    STATE["tts"] += 1
                    STATE["lastText"] = message["content"]
                audio = base64.b64encode(tone()).decode()
                return self.send_json({"choices": [{"message": {"role": "assistant", "audio": {"data": audio}}}]})
            part = message["content"][0]
            rate, channels, bits, seconds = recording_format(part["input_audio"]["data"])
            with LOCK:
                STATE["asr"] += 1
                STATE.update(lastRate=rate, lastChannels=channels, lastBits=bits, lastSeconds=round(seconds, 2))
            return self.send_json({"choices": [{"message": {"role": "assistant", "content": TEXT}}]})
        except (KeyError, IndexError, TypeError, ValueError):
            with LOCK:
                STATE["rejected"] += 1
            return self.send_json({"error": {"code": "invalid_request_error"}}, 400)


def self_test(port):
    base = f"http://127.0.0.1:{port}"

    def post(path, value, key=KEY):
        request = urllib.request.Request(base + path, json.dumps(value).encode(), method="POST",
                                         headers={"content-type": "application/json", "authorization": f"Bearer {key}"})
        with urllib.request.urlopen(request) as response:
            return json.load(response)

    speech = post("/v1/chat/completions", {"model": "tts", "messages": [{"role": "assistant", "content": "你好"}],
                                           "audio": {"format": "wav", "voice": "冰糖"}})
    assert base64.b64decode(speech["choices"][0]["message"]["audio"]["data"])[:4] == b"RIFF"
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(16_000)
        output.writeframes(b"\0\0" * 16_000)
    url = "data:audio/wav;base64," + base64.b64encode(buffer.getvalue()).decode()
    text = post("/v1/chat/completions", {"model": "asr", "messages": [{"role": "user", "content": [
        {"type": "input_audio", "input_audio": {"data": url}}]}]})
    assert text["choices"][0]["message"]["content"] == TEXT
    with urllib.request.urlopen(base + "/__voice/state") as response:
        state = json.load(response)
    assert state["asr"] == 1 and state["tts"] == 1 and state["lastRate"] == 16_000, state
    print("voice fixture self-test passed")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=18794)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    reset()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    if args.self_test:
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self_test(args.port)
        server.shutdown()
        return
    print(f"voice fixture on http://127.0.0.1:{args.port}/v1", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
