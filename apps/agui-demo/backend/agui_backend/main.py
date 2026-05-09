"""FastAPI app exposing agent_core over AG-UI's SSE wire protocol.

What this demo shows
--------------------
1. **Streaming events.** The /agent endpoint returns an SSE stream of typed
   AG-UI events: RunStarted → TextMessageStart → TextMessageContent (deltas)
   → TextMessageEnd → ToolCallStart → ToolCallArgs → ToolCallEnd →
   ToolCallResult (with rich render-block JSON) → RunFinished.

2. **Render-block-as-tool-result.** Tool results carry our protocol-neutral
   render blocks (`PlotSpec`, `DiagramSpec`, etc.) as JSON inside the
   `ToolCallResultEvent.content` field. The frontend uses CopilotKit's
   `useCopilotAction({ name, render })` to mount a custom React component
   per tool, parses the content, and renders the appropriate widget.

3. **Bridge pattern.** Notice the adapter is ~80 lines: any agent that
   yields the protocol-neutral events from `agent_core.events` can be
   surfaced as an AG-UI agent without touching the loop itself.
"""

from __future__ import annotations

import json
import uuid
from typing import AsyncIterator

from ag_ui.core import (
    EventType,
    RunAgentInput,
    RunErrorEvent,
    RunFinishedEvent,
    RunStartedEvent,
    TextMessageContentEvent,
    TextMessageEndEvent,
    TextMessageStartEvent,
    ToolCallArgsEvent,
    ToolCallEndEvent,
    ToolCallResultEvent,
    ToolCallStartEvent,
)
from ag_ui.encoder import EventEncoder
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

from agent_core import events as ev
from agent_core import loop, render

app = FastAPI(title="agui-demo backend")

# Liberal CORS for hackathon dev. Tighten before shipping anything real.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/healthz")
async def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/agent")
async def agent(input_data: RunAgentInput, request: Request) -> StreamingResponse:
    encoder = EventEncoder(accept=request.headers.get("accept"))
    return StreamingResponse(
        _stream(input_data, encoder), media_type=encoder.get_content_type()
    )


def _last_user_text(input_data: RunAgentInput) -> str:
    for m in reversed(input_data.messages):
        if getattr(m, "role", None) == "user":
            content = getattr(m, "content", "")
            if isinstance(content, str):
                return content
            # multimodal — flatten text parts
            parts = [getattr(p, "text", "") for p in (content or []) if hasattr(p, "text")]
            return " ".join(p for p in parts if p)
    return ""


async def _stream(input_data: RunAgentInput, encoder: EventEncoder) -> AsyncIterator[bytes]:
    yield encoder.encode(
        RunStartedEvent(
            type=EventType.RUN_STARTED,
            thread_id=input_data.thread_id,
            run_id=input_data.run_id,
        )
    )

    user_text = _last_user_text(input_data)
    text_message_id: str | None = None

    try:
        async for event in loop.run(user_text):
            if isinstance(event, ev.RunStarted):
                continue  # already emitted

            if isinstance(event, ev.TextDelta):
                if text_message_id is None:
                    text_message_id = event.message_id
                    yield encoder.encode(
                        TextMessageStartEvent(
                            type=EventType.TEXT_MESSAGE_START,
                            message_id=text_message_id,
                            role="assistant",
                        )
                    )
                yield encoder.encode(
                    TextMessageContentEvent(
                        type=EventType.TEXT_MESSAGE_CONTENT,
                        message_id=text_message_id,
                        delta=event.delta,
                    )
                )
                continue

            if text_message_id is not None and not isinstance(event, ev.TextDelta):
                yield encoder.encode(
                    TextMessageEndEvent(
                        type=EventType.TEXT_MESSAGE_END,
                        message_id=text_message_id,
                    )
                )
                text_message_id = None

            if isinstance(event, ev.ToolCallStart):
                parent = str(uuid.uuid4())
                yield encoder.encode(
                    ToolCallStartEvent(
                        type=EventType.TOOL_CALL_START,
                        tool_call_id=event.tool_call_id,
                        tool_call_name=event.name,
                        parent_message_id=parent,
                    )
                )
                yield encoder.encode(
                    ToolCallArgsEvent(
                        type=EventType.TOOL_CALL_ARGS,
                        tool_call_id=event.tool_call_id,
                        delta=json.dumps(event.arguments),
                    )
                )
                yield encoder.encode(
                    ToolCallEndEvent(
                        type=EventType.TOOL_CALL_END,
                        tool_call_id=event.tool_call_id,
                    )
                )

            elif isinstance(event, ev.ToolCallResult):
                # Render blocks are surfaced as the tool result content.
                # The frontend parses this JSON in its `useCopilotAction.render`.
                yield encoder.encode(
                    ToolCallResultEvent(
                        type=EventType.TOOL_CALL_RESULT,
                        message_id=str(uuid.uuid4()),
                        tool_call_id=event.tool_call_id,
                        content=json.dumps({"blocks": render.to_dict(event.blocks)}),
                        role="tool",
                    )
                )

            elif isinstance(event, ev.RunError):
                yield encoder.encode(
                    RunErrorEvent(type=EventType.RUN_ERROR, message=event.message)
                )
                return

            elif isinstance(event, ev.RunFinished):
                pass  # we emit RUN_FINISHED below
    except Exception as exc:  # noqa: BLE001 — demo-grade error path
        yield encoder.encode(
            RunErrorEvent(type=EventType.RUN_ERROR, message=f"{type(exc).__name__}: {exc}")
        )
        return

    if text_message_id is not None:
        yield encoder.encode(
            TextMessageEndEvent(
                type=EventType.TEXT_MESSAGE_END, message_id=text_message_id
            )
        )

    yield encoder.encode(
        RunFinishedEvent(
            type=EventType.RUN_FINISHED,
            thread_id=input_data.thread_id,
            run_id=input_data.run_id,
        )
    )
