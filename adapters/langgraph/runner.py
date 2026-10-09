"""Stream graph evidence as bounded JSON lines; never accumulate native history."""
from __future__ import annotations

import argparse
import asyncio
import contextlib
import hashlib
import inspect
import json
import os
import sys
from collections import OrderedDict
from pathlib import Path

from protocol import (
    _call_astream, _call_stream, _event_parts, _import_factory,
    _jsonable, _materialize_graph_async, _now,
)

PROTOCOL = sys.stdout


def bounded(value, limit=16384):
    if isinstance(value, str):
        body = value.encode()
        if len(body) <= limit:
            return value
        return {"representation": "EXCERPT", "prefix": body[:limit // 2].decode(errors="replace"),
                "suffix": body[-limit // 2:].decode(errors="replace"), "originalBytes": len(body),
                "sha256": hashlib.sha256(body).hexdigest(), "omitted": True}
    if isinstance(value, list):
        if len(value) > 128:
            return {"items": [bounded(x) for x in value[:128]], "omittedItems": len(value)-128, "omitted": True}
        return [bounded(x) for x in value]
    if isinstance(value, dict):
        result = {k: "[REDACTED]" if k.lower() in {"api_key", "apikey", "authorization", "password", "token"} else bounded(v)
                  for k, v in list(value.items())[:128]}
        if len(value) > 128:
            result["__evaldock_omitted_keys__"] = len(value)-128
        return result
    return value


def emit(kind, data):
    record = {"schema": "evaldock.langgraph.events/v1", "at": _now(), "type": kind, "data": data if kind == "assistant/final" else bounded(data)}
    PROTOCOL.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
    PROTOCOL.flush()


def content_text(value):
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return "".join(x.get("text", "") for x in value if isinstance(x, dict) and x.get("type") == "text")
    return ""


class Evidence:
    def __init__(self):
        self.seen = OrderedDict()
        self.final = ""
        self.final_truncated = False

    def once(self, key, value):
        fingerprint = str(key) + ":" + hashlib.sha256(json.dumps(value, sort_keys=True, default=str).encode()).hexdigest()
        if fingerprint in self.seen:
            return False
        self.seen[fingerprint] = True
        if len(self.seen) > 512:
            self.seen.popitem(last=False)
        return True

    def message(self, message):
        role = message.get("type") or message.get("role")
        if role in ("ai", "assistant"):
            calls = message.get("tool_calls") or []
            for call in calls:
                if self.once("call:" + str(call.get("id")), call):
                    emit("tool/call", {"callId": call.get("id"), "name": call.get("name"), "arguments": call.get("args")})
            answer = content_text(message.get("content"))
            if answer and not calls:
                # Keep only the latest completed assistant answer; no token chunks.
                self.final = answer.encode()[:65536].decode(errors="replace")
                self.final_truncated = len(answer.encode()) > 65536
        elif role == "tool":
            call_id = message.get("tool_call_id")
            if self.once("result:" + str(call_id), message):
                emit("tool/result", {"callId": call_id, "name": message.get("name"),
                                     "result": message.get("content"), "isError": message.get("status") == "error"})

    def walk(self, value, depth=0):
        if depth > 8:
            return
        if isinstance(value, list):
            for child in value:
                self.walk(child, depth + 1)
        elif isinstance(value, dict):
            if value.get("type", value.get("role")) in ("ai", "assistant", "tool"):
                self.message(value)
                return
            for key, child in value.items():
                if key == "__interrupt__":
                    emit("interrupt/raise", {"interrupt": bounded(child)})
                elif isinstance(child, (list, dict)):
                    self.walk(child, depth + 1)

    def accept(self, item):
        kind, data, namespace = _event_parts(item)
        data = _jsonable(data)
        if kind in ("updates", "custom"):
            if isinstance(data, dict):
                for node in list(data)[:32]:
                    emit("node/end", {"node": node, "namespace": namespace})
            self.walk(data)
        elif kind == "tasks":
            if isinstance(data, dict):
                emit("node/end" if "result" in data or "error" in data else "node/start",
                     {k: data[k] for k in ("id", "name", "error") if k in data})
                if data.get("error"):
                    emit("runtime/error", {"error": data["error"]})
                self.walk(data.get("result"))
        elif kind in ("checkpoints", "checkpoint"):
            config = data.get("config", {}).get("configurable", {}) if isinstance(data, dict) else {}
            emit("checkpoint/write", {"checkpointId": config.get("checkpoint_id"), "namespace": namespace})
        elif kind in ("interrupt", "interrupt/raise"):
            emit("interrupt/raise", {"interrupt": data})
        elif kind in ("on_tool_start", "on_tool_end"):
            emit("tool/call" if kind == "on_tool_start" else "tool/result",
                 {"callId": data.get("run_id"), "name": data.get("name"),
                  "arguments" if kind == "on_tool_start" else "result": data.get("input" if kind == "on_tool_start" else "output")})


async def run(args):
    payload = json.loads(Path(args.input).read_text())
    config = {"configurable": {"thread_id": args.thread}, "recursion_limit": 100}
    evidence = Evidence()
    graph, context = await _materialize_graph_async(_import_factory(args.graph), config)
    try:
        modes = ["updates", "custom", "tasks", "checkpoints"]
        if callable(getattr(graph, "astream", None)):
            stream = _call_astream(graph, payload, config, modes, "v2", True)
            if inspect.isawaitable(stream):
                stream = await stream
            async for item in stream:
                evidence.accept(item)
        elif callable(getattr(graph, "stream", None)):
            for item in _call_stream(graph, payload, config, modes, "v2", True):
                evidence.accept(item)
        else:
            raise TypeError("Graph must expose stream or astream")
        if evidence.final:
            emit("assistant/final", {"text": evidence.final, "truncated": evidence.final_truncated})
        emit("runtime/completed", {"threadId": args.thread})
    finally:
        if context is not None:
            if hasattr(context, "__aexit__"):
                await context.__aexit__(None, None, None)
            else:
                context.__exit__(None, None, None)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--graph", required=True)
    parser.add_argument("--input", required=True)
    parser.add_argument("--thread", required=True)
    args = parser.parse_args()
    try:
        # Agent/tool prints must not corrupt the structured event channel.
        with contextlib.redirect_stdout(sys.stderr):
            asyncio.run(run(args))
    except Exception as error:
        message = str(error)
        for key, value in os.environ.items():
            if any(word in key.upper() for word in ("KEY", "TOKEN", "SECRET", "PASSWORD")) and len(value) >= 8:
                message = message.replace(value, "[REDACTED]")
        emit("runtime/error", {"errorClass": type(error).__name__, "message": message[:2000]})
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
