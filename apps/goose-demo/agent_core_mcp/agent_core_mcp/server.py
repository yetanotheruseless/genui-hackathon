"""Wrap agent_core tools as a stdio MCP server.

Goose (`goose run` / desktop), Claude Desktop, Claude Code, and VS Code
Copilot all consume MCP servers over stdio. By exposing the same tools
via this thin wrapper, the *brain* (Goose's agent loop) drives our
*tools* — no separate Python web service required.

This is the "Goose angle" of the four-protocol comparison: AG-UI, MCP
Apps, and A2UI all answer "how does an agent paint UI?". Goose answers
"how do you ship an agent at all?", and reuses MCP for the tool layer.

Each wrapper has an explicit signature so FastMCP's auto-introspection
produces a clean JSON schema — Goose / Claude Desktop / etc. then surface
the args correctly to the model.
"""

from __future__ import annotations

import json
from typing import Annotated, Literal

from mcp.server.fastmcp import FastMCP
from pydantic import Field

from agent_core.tools import call_tool

mcp = FastMCP("agent_core")


def _to_json(name: str, arguments: dict) -> str:
    blocks = call_tool(name, arguments)
    return json.dumps({"blocks": [b.model_dump() for b in blocks]}, indent=2)


@mcp.tool(description="Evaluate a short symbolic / numerical expression. Returns LaTeX + numeric value.")
def wolfram_query(
    expression: Annotated[str, Field(description="A symbolic expression in plain text.")],
) -> str:
    return _to_json("wolfram_query", {"expression": expression})


@mcp.tool(description="Solve a 2D PDE on a square domain. Returns a markdown summary + a heatmap PlotSpec.")
def solve_pde_2d(
    equation: Annotated[str, Field(description="Plain-text equation, e.g. 'phi_xx + phi_yy - V_prime(phi) = 0'.")],
    extent: Annotated[float, Field(description="Half-width of the square domain.")] = 5.0,
    grid: Annotated[int, Field(description="Grid resolution per axis.")] = 64,
) -> str:
    return _to_json("solve_pde_2d", {"equation": equation, "extent": extent, "grid": grid})


@mcp.tool(description="Run a small lattice Monte-Carlo simulation. Returns a trace plot + summary card.")
def lattice_simulate(
    model: Annotated[str, Field(description="Lattice model, e.g. 'ising_2d', 'phi4', 'su2_pure_gauge'.")],
    beta: Annotated[float, Field(description="Inverse temperature.")] = 0.44,
    steps: Annotated[int, Field(description="Number of MC sweeps.")] = 200,
) -> str:
    return _to_json("lattice_simulate", {"model": model, "beta": beta, "steps": steps})


@mcp.tool(description="Plot a single-variable function. Supports: sin, cos, exp, gaussian, sech2, tanh.")
def plot_fn(
    expression: Annotated[Literal["sin", "cos", "exp", "gaussian", "sech2", "tanh"], Field(description="Which function to plot.")],
    x_min: float = -5.0,
    x_max: float = 5.0,
    samples: int = 200,
) -> str:
    return _to_json(
        "plot_fn",
        {"expression": expression, "x_min": x_min, "x_max": x_max, "samples": samples},
    )


@mcp.tool(description="Emit a small diagram as Mermaid source.")
def render_diagram(
    kind: Annotated[Literal["bubble_nucleation", "phase_diagram", "causal_chain"], Field(description="Which canned diagram to emit.")],
    title: str = "Diagram",
) -> str:
    return _to_json("render_diagram", {"kind": kind, "title": title})


def main() -> None:
    mcp.run()


if __name__ == "__main__":
    main()
