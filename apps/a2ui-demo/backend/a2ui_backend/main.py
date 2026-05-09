"""FastAPI service that runs `agent_core.loop` and emits A2UI v0.9 messages.

Wire shape: SSE — one `data: { ... }` line per A2UI message. The frontend
JSON-parses each line and feeds it to `MessageProcessor.processMessages([...])`
from `@a2ui/web_core/v0_9`. The Lit `<a2ui-surface>` element then mounts the
surfaces.

A2UI is a UI *description* protocol, not a transport. SSE matches our
other demos; you could just as well send these messages over WebSockets,
WebRTC data channels, or post-hoc as a JSON dump.
"""

from __future__ import annotations

import json
from typing import AsyncIterator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from agent_core import events as ev
from agent_core import loop

from a2ui_backend.adapter import create_surface, text_surface_messages, update_components

app = FastAPI(title="a2ui-demo backend")
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
)


class RunRequest(BaseModel):
    message: str


@app.get("/healthz")
async def healthz() -> dict[str, str]:
    return {"status": "ok"}


def _sse(payload: dict) -> bytes:
    return f"data: {json.dumps(payload)}\n\n".encode("utf-8")


@app.post("/a2ui-stream")
async def a2ui_stream(req: RunRequest) -> StreamingResponse:
    return StreamingResponse(_run(req.message), media_type="text/event-stream")


async def _run(message: str) -> AsyncIterator[bytes]:
    text_buf: list[str] = []
    surface_n = 0

    def _flush_text(prefix: str) -> AsyncIterator[bytes]:
        nonlocal surface_n, text_buf
        text = "".join(text_buf).strip()
        text_buf = []
        if not text:
            return
        surface_n += 1
        sid = f"{prefix}_{surface_n}"
        for msg in text_surface_messages(sid, text):
            yield _sse(msg)

    async for event in loop.run(message):
        if isinstance(event, ev.RunStarted):
            yield _sse({"meta": "run_started", "runId": event.run_id})
            continue

        if isinstance(event, ev.TextDelta):
            text_buf.append(event.delta)
            continue

        if isinstance(event, ev.ToolCallStart):
            for chunk in _flush_text("text"):
                yield chunk
            args_pretty = ", ".join(f"{k}={v}" for k, v in event.arguments.items())
            yield _sse({"meta": "tool_call", "name": event.name, "args": args_pretty})
            continue

        if isinstance(event, ev.ToolCallResult):
            surface_n += 1
            sid = f"tool_{surface_n}"
            yield _sse(create_surface(sid))
            yield _sse(
                update_components(
                    surface_id=sid, header=f"→ {event.name}", blocks=event.blocks
                )
            )
            continue

        if isinstance(event, ev.RunFinished):
            for chunk in _flush_text("final"):
                yield chunk
            yield _sse({"meta": "run_finished"})
            continue

        if isinstance(event, ev.RunError):
            yield _sse({"meta": "run_error", "message": event.message})
            return
