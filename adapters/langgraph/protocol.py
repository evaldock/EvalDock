"""Graph protocol helpers extracted from the VMmac adapter; no collection buffers."""
from __future__ import annotations
import argparse
import asyncio
import base64
import importlib
import importlib.util
import inspect
import json
import os
import pathlib
import sys
import traceback
import uuid
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from types import ModuleType
from typing import Any

GRAPH_METHODS = ("stream", "astream", "astream_events", "invoke", "ainvoke")

def _jsonable(value: Any) -> Any:
    """Convert common LangChain message/model values to JSON-safe values."""

    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, bytes):
        return {"encoding": "base64", "value": base64.b64encode(value).decode("ascii")}
    if isinstance(value, Mapping):
        return {str(key): _jsonable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set, frozenset)):
        return [_jsonable(item) for item in value]
    # LangChain message objects commonly expose model_dump/asdict/content.
    for method_name in ("model_dump", "dict"):
        method = getattr(value, method_name, None)
        if callable(method):
            try:
                dumped = method()
            except Exception:  # pragma: no cover - defensive for user objects
                dumped = None
            if dumped is not None:
                return _jsonable(dumped)
    if hasattr(value, "__dict__"):
        try:
            return _jsonable(vars(value))
        except Exception:  # pragma: no cover - defensive for extension types
            pass
    return str(value)

def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")

def _import_factory(spec: str) -> Any:
    """Resolve ``module:attribute`` or ``file.py:attribute`` safely."""

    working_directory = str(pathlib.Path.cwd())
    if working_directory not in sys.path:
        sys.path.insert(0, working_directory)
    if ":" not in spec:
        raise ValueError("--graph must use module:factory or /path/to/module.py:factory")
    module_spec, attribute_path = spec.rsplit(":", 1)
    if not module_spec or not attribute_path:
        raise ValueError("--graph must use module:factory or /path/to/module.py:factory")
    module: ModuleType
    module_path = pathlib.Path(module_spec)
    if module_path.suffix == ".py" or module_path.is_file():
        resolved = module_path.expanduser().resolve()
        if not resolved.is_file():
            raise FileNotFoundError(f"graph module does not exist: {resolved}")
        if str(resolved.parent) not in sys.path:
            sys.path.insert(0, str(resolved.parent))
        name = f"evaldock_graph_{uuid.uuid4().hex}"
        module_spec_obj = importlib.util.spec_from_file_location(name, resolved)
        if module_spec_obj is None or module_spec_obj.loader is None:
            raise ImportError(f"unable to load graph module: {resolved}")
        module = importlib.util.module_from_spec(module_spec_obj)
        sys.modules[name] = module
        module_spec_obj.loader.exec_module(module)
    else:
        module = importlib.import_module(module_spec)
    value: Any = module
    for part in attribute_path.split("."):
        value = getattr(value, part)
    return value

async def _materialize_graph_async(value: Any, config: dict[str, Any]) -> tuple[Any, Any | None]:
    if callable(value) and not any(callable(getattr(value, name, None)) for name in GRAPH_METHODS):
        try:
            signature = inspect.signature(value)
        except (TypeError, ValueError):
            signature = None
        value = _call_factory(value, config, signature)
        if inspect.isawaitable(value):
            value = await value
    context = None
    if not any(callable(getattr(value, name, None)) for name in GRAPH_METHODS):
        async_enter = getattr(value, "__aenter__", None)
        sync_enter = getattr(value, "__enter__", None)
        if callable(async_enter):
            context = value
            value = await async_enter()
        elif callable(sync_enter):
            context = value
            value = sync_enter()
    if not any(callable(getattr(value, name, None)) for name in GRAPH_METHODS):
        raise TypeError("graph factory must return an object with stream, astream, astream_events, invoke or ainvoke")
    return value, context

def _call_factory(factory: Any, config: dict[str, Any], signature: inspect.Signature | None) -> Any:
    """Call a graph factory across the common LangGraph integration shapes.

    Most examples expose ``build_graph()`` while server-oriented applications
    expose ``build_graph(config)`` or ``build_graph(*, config=...)``.  A few
    use an optional config parameter (or ``**kwargs``), which the old runner
    treated as a zero-argument factory.  Passing the merged config in those
    cases preserves thread/checkpoint identity without changing zero-argument
    factories.
    """

    if signature is None:
        return factory()
    parameters = tuple(signature.parameters.values())
    positional = tuple(
        parameter for parameter in parameters
        if parameter.kind in (inspect.Parameter.POSITIONAL_ONLY, inspect.Parameter.POSITIONAL_OR_KEYWORD)
    )
    required = tuple(parameter for parameter in parameters if parameter.default is inspect.Parameter.empty and parameter.kind in (
        inspect.Parameter.POSITIONAL_ONLY,
        inspect.Parameter.POSITIONAL_OR_KEYWORD,
        inspect.Parameter.KEYWORD_ONLY,
    ))
    config_parameter = next((parameter for parameter in parameters if parameter.name in ("config", "run_config", "runtime_config", "graph_config", "cfg")), None)
    accepts_kwargs = any(parameter.kind is inspect.Parameter.VAR_KEYWORD for parameter in parameters)
    if config_parameter is not None:
        if config_parameter.kind is inspect.Parameter.KEYWORD_ONLY:
            return factory(**{config_parameter.name: config})
        if config_parameter.kind is inspect.Parameter.POSITIONAL_OR_KEYWORD:
            return factory(config)
        return factory(config)
    if accepts_kwargs:
        return factory(config=config)
    if required:
        parameter = required[0]
        if parameter.kind is inspect.Parameter.KEYWORD_ONLY:
            return factory(**{parameter.name: config})
        if positional:
            return factory(config)
    return factory()

def _event_parts(item: Any) -> tuple[str, Any, list[str]]:
    """Return (stream mode/type, payload, namespace) for a stream item."""

    if isinstance(item, Mapping):
        if isinstance(item.get("event"), str):
            event_type = str(item["event"])
            payload = item.get("data", {})
            if isinstance(payload, Mapping):
                payload = dict(payload)
                for key in ("name", "run_id", "parent_run_id", "tags", "metadata"):
                    if key in item and key not in payload:
                        payload[key] = item[key]
            return event_type, payload, []
        event_type = item.get("type")
        if isinstance(event_type, str):
            # v2 envelopes always carry ``data`` (and usually ``ns``).  Debug
            # and older v1 modes also use a top-level ``type`` for the payload
            # itself; retain that complete mapping instead of dropping fields.
            payload = item.get("data") if "data" in item or "ns" in item else dict(item)
            return event_type, payload, list(item.get("ns", [])) if isinstance(item.get("ns", []), (list, tuple)) else []
        # v1 ``stream_mode=[...]`` may yield a dict with the mode as its key.
        if len(item) == 1:
            key, payload = next(iter(item.items()))
            return str(key), payload, []
        return "custom", dict(item), []
    if isinstance(item, tuple) and len(item) == 2:
        # Older LangGraph subgraph streaming wraps an event as
        # ``(namespace_tuple, inner_event)``. Preserve the namespace while
        # normalizing the inner mode/data pair.
        if isinstance(item[0], (list, tuple)):
            event_type, payload, namespace = _event_parts(item[1])
            return event_type, payload, [str(part) for part in item[0]] + namespace
        if isinstance(item[0], str):
            return item[0], item[1], []
    if isinstance(item, tuple) and len(item) == 3 and isinstance(item[0], (list, tuple)) and isinstance(item[1], str):
        return item[1], item[2], [str(part) for part in item[0]]
    # Typed ``StreamPart`` implementations in some LangGraph releases expose
    # attributes rather than a plain TypedDict.  Accept both forms.
    event_type = getattr(item, "type", None)
    if isinstance(event_type, str):
        payload = getattr(item, "data", item)
        namespace = getattr(item, "ns", ())
        return event_type, payload, [str(part) for part in namespace] if isinstance(namespace, (list, tuple)) else []
    return "custom", item, []

def _stream_kwargs(config: dict[str, Any], modes: list[str], version: str, subgraphs: bool) -> dict[str, Any]:
    # ``version=\"v2\"`` is the modern protocol.  ``auto`` starts with v2 and
    # the compatibility caller below removes it for pre-v2 LangGraph releases.
    safe_modes = modes or ["values"]
    return {
        "config": config,
        "stream_mode": safe_modes if len(safe_modes) > 1 else safe_modes[0],
        "version": "v2" if version == "auto" else version,
        "subgraphs": subgraphs,
    }

def _call_stream(graph: Any, input_value: Any, config: dict[str, Any], modes: list[str], version: str, subgraphs: bool) -> Any:
    method = getattr(graph, "stream", None)
    if method is None:
        raise TypeError("graph does not expose stream")
    kwargs = _stream_kwargs(config, modes, version, subgraphs)
    return _call_stream_method(method, input_value, kwargs)

def _call_astream(graph: Any, input_value: Any, config: dict[str, Any], modes: list[str], version: str, subgraphs: bool) -> Any:
    method = getattr(graph, "astream", None)
    if method is None:
        raise TypeError("graph does not expose astream")
    kwargs = _stream_kwargs(config, modes, version, subgraphs)
    return _call_stream_method(method, input_value, kwargs)

def _call_stream_method(method: Any, input_value: Any, kwargs: dict[str, Any]) -> Any:
    # Tiny fixture graphs and older LangGraph versions may not accept v2-only
    # options.  Remove only rejected keyword arguments, preserving real errors
    # raised from inside the graph.
    # Filter options by the bound method signature when possible.  This is
    # safer than catching every TypeError (which could be raised inside a node)
    # and covers older releases that simply omit ``version`` or ``subgraphs``.
    try:
        signature = inspect.signature(method)
    except (TypeError, ValueError):
        signature = None
    if signature is not None and not any(parameter.kind is inspect.Parameter.VAR_KEYWORD for parameter in signature.parameters.values()):
        accepted = set(signature.parameters)
        kwargs = {key: value for key, value in kwargs.items() if key in accepted}

    def call() -> Any:
        if signature is None:
            return method(input_value, **kwargs)
        positional = [input_value]
        keyword: dict[str, Any] = {}
        parameters = tuple(signature.parameters.values())
        for parameter in parameters[1:]:
            if parameter.name not in kwargs:
                continue
            if parameter.kind is inspect.Parameter.POSITIONAL_ONLY:
                positional.append(kwargs[parameter.name])
            elif parameter.kind in (inspect.Parameter.POSITIONAL_OR_KEYWORD, inspect.Parameter.KEYWORD_ONLY):
                keyword[parameter.name] = kwargs[parameter.name]
        if any(parameter.kind is inspect.Parameter.VAR_KEYWORD for parameter in parameters):
            for key, value in kwargs.items():
                if key not in keyword and key not in {parameter.name for parameter in parameters}:
                    keyword[key] = value
        return method(*positional, **keyword)

    while True:
        try:
            return call()
        except TypeError as error:
            message = str(error)
            if "unexpected keyword argument" not in message and "got an unexpected keyword" not in message:
                raise
            removed = False
            for key in ("subgraphs", "version", "stream_mode"):
                if key in message and key in kwargs:
                    # A pre-v2 release may support only one mode.  Keep one
                    # execution (and therefore side effects) instead of
                    # replaying the graph once per requested mode.
                    if key == "stream_mode" and isinstance(kwargs[key], (list, tuple)) and kwargs[key]:
                        kwargs[key] = kwargs[key][0]
                    else:
                        kwargs.pop(key)
                    removed = True
                    break
            if not removed:
                raise
