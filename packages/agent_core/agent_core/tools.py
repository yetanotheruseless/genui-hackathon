"""Mock physics-research tools.

These are intentionally small and side-effect-free. Each tool returns a list
of `render.RenderBlock`s so every protocol adapter has the same data to map.

Swap in real backends (Wolfram Alpha, FEniCS, lattice MC code, sympy) when
you commit to a real demo direction.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Callable

import numpy as np

from agent_core import render
from agent_core.render import (
    Card,
    DiagramSpec,
    Latex,
    Markdown,
    PlotSpec,
    RenderBlock,
    Table,
)


@dataclass
class ToolDef:
    name: str
    description: str
    input_schema: dict[str, Any]
    fn: Callable[..., list[RenderBlock]]


TOOLS: dict[str, ToolDef] = {}


def tool(name: str, description: str, input_schema: dict[str, Any]):
    def deco(fn: Callable[..., list[RenderBlock]]) -> Callable[..., list[RenderBlock]]:
        TOOLS[name] = ToolDef(name=name, description=description, input_schema=input_schema, fn=fn)
        return fn

    return deco


# ---------------------------------------------------------------------------
# wolfram_query — symbolic compute mock
# ---------------------------------------------------------------------------


@tool(
    name="wolfram_query",
    description=(
        "Evaluate a short symbolic / numerical expression. Returns a LaTeX result "
        "and an optional plot. Use for closed-form physics calculations."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "expression": {"type": "string", "description": "A symbolic expression in plain text, e.g. 'integrate sin(x)^2 from 0 to pi'."}
        },
        "required": ["expression"],
    },
)
def wolfram_query(expression: str) -> list[RenderBlock]:
    # Tiny canned-response cache so demos look credible without an API key.
    canned = {
        "integrate sin(x)^2 from 0 to pi": (r"\int_0^{\pi} \sin^2 x\,dx = \tfrac{\pi}{2}", math.pi / 2),
        "schwarzschild radius of the sun": (r"r_s = \tfrac{2GM_\odot}{c^2} \approx 2.95\,\text{km}", 2953.0),
    }
    key = expression.strip().lower()
    if key in canned:
        tex, value = canned[key]
        return [
            Latex(tex=tex),
            Card(title="Numerical value", fields={"value": value, "expression": expression}),
        ]
    # Fallback: pretend we evaluated it.
    return [
        Markdown(text=f"Wolfram-style evaluation of `{expression}` (mock)."),
        Card(title="Result", fields={"input": expression, "value": 0.0, "note": "mock — wire to a real backend"}),
    ]


# ---------------------------------------------------------------------------
# solve_pde_2d — surface plot mock
# ---------------------------------------------------------------------------


@tool(
    name="solve_pde_2d",
    description=(
        "Solve a 2D PDE on a square domain. Returns a heatmap of the solution. "
        "Use for visualizing field configurations like wave equations or "
        "Coleman-De Luccia bounce profiles."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "equation": {"type": "string", "description": "Plain-text equation, e.g. 'phi_xx + phi_yy - V_prime(phi) = 0'."},
            "extent": {"type": "number", "description": "Half-width of the square domain.", "default": 5.0},
            "grid": {"type": "integer", "description": "Grid resolution per axis.", "default": 64},
        },
        "required": ["equation"],
    },
)
def solve_pde_2d(equation: str, extent: float = 5.0, grid: int = 64) -> list[RenderBlock]:
    xs = np.linspace(-extent, extent, grid)
    ys = np.linspace(-extent, extent, grid)
    X, Y = np.meshgrid(xs, ys)
    # A bounce-shaped radial profile: tanh of (R - r), classic CDL bubble look.
    R = np.sqrt(X**2 + Y**2)
    phi = np.tanh(2.0 - R) * 0.5 + 0.5
    return [
        Markdown(text=f"Solved `{equation}` on domain $[-{extent},{extent}]^2$ with a {grid}x{grid} grid."),
        PlotSpec(
            title="Field profile φ(x, y)",
            plot_type="heatmap",
            x=xs.tolist(),
            y=ys.tolist(),
            z=phi.tolist(),
            x_label="x",
            y_label="y",
        ),
    ]


# ---------------------------------------------------------------------------
# lattice_simulate — observable trace mock
# ---------------------------------------------------------------------------


@tool(
    name="lattice_simulate",
    description=(
        "Run a small lattice Monte-Carlo simulation. Returns a trace of an "
        "observable across iterations. Use for thermalisation plots."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "model": {"type": "string", "description": "Lattice model, e.g. 'ising_2d', 'phi4', 'su2_pure_gauge'."},
            "beta": {"type": "number", "description": "Inverse temperature.", "default": 0.44},
            "steps": {"type": "integer", "description": "Number of MC sweeps.", "default": 200},
        },
        "required": ["model"],
    },
)
def lattice_simulate(model: str, beta: float = 0.44, steps: int = 200) -> list[RenderBlock]:
    rng = np.random.default_rng(seed=hash((model, round(beta, 3), steps)) & 0xFFFF)
    # A fake equilibration: exponential decay to a stationary value plus noise.
    t = np.arange(steps)
    target = 0.7 if beta > 0.4 else 0.1
    series = target + (1 - target) * np.exp(-t / 30.0) + rng.normal(0, 0.02, size=steps)
    return [
        Markdown(text=f"Lattice MC: `{model}` at β={beta}, {steps} sweeps (mock)."),
        PlotSpec(
            title=f"Observable ⟨O⟩ over MC time ({model})",
            plot_type="line",
            x=t.tolist(),
            y=series.tolist(),
            x_label="MC sweep",
            y_label="⟨O⟩",
        ),
        Card(title="Run summary", fields={"model": model, "beta": beta, "steps": steps, "mean_late": float(series[-50:].mean())}),
    ]


# ---------------------------------------------------------------------------
# plot_fn — real numpy-backed function plotter
# ---------------------------------------------------------------------------


@tool(
    name="plot_fn",
    description=(
        "Plot a single-variable function over a range. Supports a small set of "
        "expressions: sin, cos, exp, gaussian, sech2, tanh."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "expression": {"type": "string", "description": "One of: sin, cos, exp, gaussian, sech2, tanh."},
            "x_min": {"type": "number", "default": -5.0},
            "x_max": {"type": "number", "default": 5.0},
            "samples": {"type": "integer", "default": 200},
        },
        "required": ["expression"],
    },
)
def plot_fn(expression: str, x_min: float = -5.0, x_max: float = 5.0, samples: int = 200) -> list[RenderBlock]:
    xs = np.linspace(x_min, x_max, samples)
    expr = expression.strip().lower()
    fns = {
        "sin": np.sin,
        "cos": np.cos,
        "exp": np.exp,
        "gaussian": lambda x: np.exp(-(x**2)),
        "sech2": lambda x: 1.0 / np.cosh(x) ** 2,
        "tanh": np.tanh,
    }
    if expr not in fns:
        return [Markdown(text=f"Unsupported expression `{expression}`. Try: {', '.join(fns)}.")]
    ys = fns[expr](xs)
    return [
        PlotSpec(
            title=f"y = {expr}(x)",
            plot_type="line",
            x=xs.tolist(),
            y=ys.tolist(),
            x_label="x",
            y_label=f"{expr}(x)",
        )
    ]


# ---------------------------------------------------------------------------
# render_diagram — mermaid diagram emitter
# ---------------------------------------------------------------------------


@tool(
    name="render_diagram",
    description=(
        "Emit a small diagram as Mermaid source. Useful for Penrose-style "
        "causal sketches, Feynman-graph stand-ins, or phase-space cartoons."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "kind": {
                "type": "string",
                "enum": ["bubble_nucleation", "phase_diagram", "causal_chain"],
                "description": "Which canned diagram to emit.",
            },
            "title": {"type": "string", "default": "Diagram"},
        },
        "required": ["kind"],
    },
)
def render_diagram(kind: str, title: str = "Diagram") -> list[RenderBlock]:
    diagrams = {
        "bubble_nucleation": (
            "graph LR\n"
            "  FV[False vacuum] -- thermal --> Bubble[Bubble wall]\n"
            "  Bubble -- expands --> TV[True vacuum interior]\n"
            "  Bubble -. throat .-> Baby[Disconnected baby universe]"
        ),
        "phase_diagram": (
            "graph TD\n"
            "  H[High T - disordered] -- cool --> C[Critical point]\n"
            "  C -- ordered --> L[Low T - ordered]\n"
            "  C -- quench --> M[Metastable]"
        ),
        "causal_chain": (
            "graph LR\n"
            "  A[Initial state] --> B[Tool: PDE solve]\n"
            "  B --> C[Tool: lattice MC]\n"
            "  C --> D[Hypothesis check]\n"
            "  D --> E[Refine model]"
        ),
    }
    src = diagrams.get(kind)
    if src is None:
        return [Markdown(text=f"Unknown diagram kind `{kind}`. Try: {', '.join(diagrams)}.")]
    return [DiagramSpec(title=title, mermaid=src)]


# ---------------------------------------------------------------------------
# helpers for adapters
# ---------------------------------------------------------------------------


def anthropic_tool_specs() -> list[dict[str, Any]]:
    """Convert the tool registry to Anthropic SDK `tools=` format."""

    return [
        {"name": t.name, "description": t.description, "input_schema": t.input_schema}
        for t in TOOLS.values()
    ]


def call_tool(name: str, arguments: dict[str, Any]) -> list[RenderBlock]:
    if name not in TOOLS:
        return [Markdown(text=f"Unknown tool `{name}`.")]
    try:
        return TOOLS[name].fn(**arguments)
    except TypeError as e:
        return [Markdown(text=f"Tool `{name}` rejected arguments: {e}")]
    except Exception as e:  # noqa: BLE001 — demo-grade error surface
        return [Markdown(text=f"Tool `{name}` raised: {type(e).__name__}: {e}")]
