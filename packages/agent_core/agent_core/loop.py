"""Provider-agnostic tool-use loop, yielding protocol-neutral events.

Routes through LiteLLM, so any provider with tool-use semantics works:
Anthropic, OpenAI, Google (Gemini AI Studio + Vertex), plus the long tail.

Selection
---------
Set env vars:
    LLM_PROVIDER  ∈ {anthropic, openai, gemini, vertex_ai, ...}   (default: anthropic)
    LLM_MODEL     model name (default: claude-sonnet-4-6 for anthropic; sane
                  defaults for the other providers)

Or set `LLM_MODEL` to a fully-qualified name like `openai/gpt-5.5` or
`gemini/gemini-2.5-flash` and `LLM_PROVIDER` is ignored.

API keys come from the provider's standard env var (ANTHROPIC_API_KEY,
OPENAI_API_KEY, GEMINI_API_KEY, etc) — LiteLLM picks them up automatically.

Adapters consume this generator and translate events into AG-UI / A2UI / ...
wire formats. The loop itself is protocol- *and* provider-agnostic.
"""

from __future__ import annotations

import json
import os
import uuid
from collections.abc import AsyncIterator
from typing import Any

import litellm

from agent_core import events as ev
from agent_core.tools import TOOLS, call_tool

DEFAULT_PROVIDER_MODELS = {
    "anthropic": "claude-sonnet-4-6",
    "openai": "gpt-5.5",
    "gemini": "gemini-2.5-flash",
    "vertex_ai": "gemini-2.5-flash",
}

DEFAULT_SYSTEM = (
    "You are a theoretical-physics research assistant. You can call tools to "
    "compute symbolic results, solve toy PDEs, run lattice simulations, plot "
    "functions, and emit diagrams. Prefer calling a tool to render a result "
    "over describing it in prose. After tool results arrive, give a one- or "
    "two-sentence interpretation."
)

# Quiet LiteLLM's default chatter; surface only real errors.
litellm.suppress_debug_info = True


def resolve_model() -> str:
    """Return a fully-qualified `provider/model` string for litellm."""
    explicit = os.environ.get("LLM_MODEL")
    provider = os.environ.get("LLM_PROVIDER", "anthropic")
    # Allow `LLM_MODEL=anthropic/claude-...` to override provider.
    if explicit and "/" in explicit:
        return explicit
    model = explicit or DEFAULT_PROVIDER_MODELS.get(provider, "claude-sonnet-4-6")
    return f"{provider}/{model}"


def _openai_tool_specs() -> list[dict[str, Any]]:
    """Convert agent_core tools to the OpenAI / LiteLLM tool format."""
    return [
        {
            "type": "function",
            "function": {
                "name": t.name,
                "description": t.description,
                "parameters": t.input_schema,
            },
        }
        for t in TOOLS.values()
    ]


async def run(
    user_message: str,
    *,
    history: list[dict[str, Any]] | None = None,
    system: str = DEFAULT_SYSTEM,
    model: str | None = None,
    max_steps: int = 6,
    max_tokens: int = 1024,
) -> AsyncIterator[ev.Event]:
    """Drive a tool-use loop against the configured provider.

    `history` lets callers maintain multi-turn state across invocations;
    each adapter decides how to persist it. The format is the OpenAI
    chat-completion message shape (LiteLLM normalises Anthropic / Gemini
    behind that), so adapters that mix history across runs are portable.
    """
    full_model = model or resolve_model()
    run_id = str(uuid.uuid4())
    yield ev.RunStarted(run_id=run_id)

    messages: list[dict[str, Any]] = list(history or []) + [
        {"role": "user", "content": user_message}
    ]
    tool_specs = _openai_tool_specs()

    for _ in range(max_steps):
        message_id = str(uuid.uuid4())
        text_buf: list[str] = []
        # Tool calls stream as partial deltas — accumulate per index.
        tool_acc: dict[int, dict[str, str]] = {}

        try:
            response = await litellm.acompletion(
                model=full_model,
                messages=[{"role": "system", "content": system}] + messages,
                tools=tool_specs,
                tool_choice="auto",
                stream=True,
                max_tokens=max_tokens,
            )
        except Exception as exc:  # noqa: BLE001 — surface provider config errors clearly
            yield ev.RunError(run_id=run_id, message=f"{full_model}: {type(exc).__name__}: {exc}")
            return

        async for chunk in response:
            if not chunk.choices:
                continue
            delta = chunk.choices[0].delta
            if delta is None:
                continue
            content = getattr(delta, "content", None)
            if content:
                yield ev.TextDelta(message_id=message_id, delta=content)
                text_buf.append(content)
            tool_calls = getattr(delta, "tool_calls", None) or []
            for tc in tool_calls:
                idx = getattr(tc, "index", 0) or 0
                slot = tool_acc.setdefault(idx, {"id": "", "name": "", "arguments": ""})
                if getattr(tc, "id", None):
                    slot["id"] = tc.id
                fn = getattr(tc, "function", None)
                if fn is not None:
                    if getattr(fn, "name", None):
                        slot["name"] = (slot["name"] or "") + (fn.name or "")
                    if getattr(fn, "arguments", None):
                        slot["arguments"] = (slot["arguments"] or "") + (fn.arguments or "")

        text_content = "".join(text_buf)

        # Build assistant message in OpenAI shape — LiteLLM round-trips this.
        if tool_acc:
            assistant_msg: dict[str, Any] = {
                "role": "assistant",
                "content": text_content or None,
                "tool_calls": [
                    {
                        "id": tool_acc[i]["id"] or f"call_{i}",
                        "type": "function",
                        "function": {
                            "name": tool_acc[i]["name"],
                            "arguments": tool_acc[i]["arguments"] or "{}",
                        },
                    }
                    for i in sorted(tool_acc)
                ],
            }
        else:
            assistant_msg = {"role": "assistant", "content": text_content}
        messages.append(assistant_msg)

        if not tool_acc:
            break

        for i in sorted(tool_acc):
            slot = tool_acc[i]
            try:
                args = json.loads(slot["arguments"]) if slot["arguments"] else {}
            except json.JSONDecodeError:
                args = {}
            tool_call_id = slot["id"] or f"call_{i}"
            yield ev.ToolCallStart(tool_call_id=tool_call_id, name=slot["name"], arguments=args)
            blocks = call_tool(slot["name"], args)
            yield ev.ToolCallResult(tool_call_id=tool_call_id, name=slot["name"], blocks=blocks)
            messages.append(
                {
                    "role": "tool",
                    "tool_call_id": tool_call_id,
                    "content": _blocks_to_text(blocks),
                }
            )

    yield ev.RunFinished(run_id=run_id)


def _blocks_to_text(blocks: list[Any]) -> str:
    """Compact textual summary of render blocks for the model's next turn.

    The renderer sees the rich version; the model only needs enough to reason
    about what happened. We do NOT echo full plot data back into the context.
    """
    lines: list[str] = []
    for b in blocks:
        d = b.model_dump() if hasattr(b, "model_dump") else b
        kind = d.get("kind")
        if kind == "markdown":
            lines.append(d["text"])
        elif kind == "latex":
            lines.append(f"$$ {d['tex']} $$")
        elif kind == "plot":
            n = len(d.get("x", []))
            lines.append(f"[plot rendered: {d.get('title')!r} type={d.get('plot_type')} n={n}]")
        elif kind == "diagram":
            lines.append(f"[diagram rendered: {d.get('title')!r}]")
        elif kind == "card":
            fields = ", ".join(f"{k}={v}" for k, v in d.get("fields", {}).items())
            lines.append(f"[card {d.get('title')!r}: {fields}]")
        elif kind == "table":
            lines.append(f"[table {d.get('title')!r}: {len(d.get('rows', []))} rows]")
    return "\n".join(lines) or "(no content)"
