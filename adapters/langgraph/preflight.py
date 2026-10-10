"""Materialize and inspect a configured graph without executing a task."""
import asyncio
import contextlib
import importlib.metadata
import json
import sys
from protocol import _import_factory, _materialize_graph_async

async def check(entrypoint):
    graph, context = await _materialize_graph_async(
        _import_factory(entrypoint), {"configurable": {"thread_id": "evaldock-interface-check"}})
    try:
        if not any(callable(getattr(graph, name, None)) for name in ("stream", "astream")):
            raise TypeError("Graph has no streaming interface")
    finally:
        if context is not None:
            if hasattr(context, "__aexit__"):
                await context.__aexit__(None, None, None)
            else:
                context.__exit__(None, None, None)
    try:
        version = importlib.metadata.version("langgraph")
    except importlib.metadata.PackageNotFoundError:
        version = None
    return {"ready": True, "version": version}

if __name__ == "__main__":
    try:
        # Factory output may contain credentials; discard it from the protocol.
        import os
        with open(os.devnull, "w") as sink, contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
            result = asyncio.run(check(sys.argv[1]))
        print(json.dumps(result))
    except Exception:
        print(json.dumps({"ready": False, "reasonCode": "LANGGRAPH_INTERFACE_UNAVAILABLE"}))
        sys.exit(1)
