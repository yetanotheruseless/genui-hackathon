"""Protocol-neutral event stream emitted by the agent loop.

Each protocol adapter is responsible for translating these into its own wire
format. Keeping the events small + serialisable keeps adapters short.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel

from agent_core.render import RenderBlock


class RunStarted(BaseModel):
    type: Literal["run_started"] = "run_started"
    run_id: str


class TextDelta(BaseModel):
    type: Literal["text_delta"] = "text_delta"
    message_id: str
    delta: str


class ToolCallStart(BaseModel):
    type: Literal["tool_call_start"] = "tool_call_start"
    tool_call_id: str
    name: str
    arguments: dict[str, Any]


class ToolCallResult(BaseModel):
    type: Literal["tool_call_result"] = "tool_call_result"
    tool_call_id: str
    name: str
    blocks: list[RenderBlock]


class RunFinished(BaseModel):
    type: Literal["run_finished"] = "run_finished"
    run_id: str


class RunError(BaseModel):
    type: Literal["run_error"] = "run_error"
    run_id: str
    message: str


Event = RunStarted | TextDelta | ToolCallStart | ToolCallResult | RunFinished | RunError
