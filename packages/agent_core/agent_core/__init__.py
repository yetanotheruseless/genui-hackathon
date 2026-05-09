"""Shared agent core for the generative-UI hackathon.

Exposes:
- A registry of mock physics-research tools (`tools.TOOLS`).
- Protocol-neutral render primitives (`render`).
- A Claude tool-use loop that yields protocol-neutral events (`loop.run`).

Each protocol adapter (AG-UI, MCP Apps, A2UI, Goose) translates these neutral
events into its native wire format. The agent brain is identical across demos.
"""

from agent_core import events, loop, render, tools

__all__ = ["events", "loop", "render", "tools"]
