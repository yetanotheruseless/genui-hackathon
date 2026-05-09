"""Protocol-neutral render primitives.

Tools return a list of `RenderBlock`s. Each protocol adapter chooses how to
surface them: AG-UI streams them as frontend-tool args; MCP Apps inlines them
into a sandboxed HTML resource; A2UI maps them to its declarative catalog;
Goose surfaces them as MCP `content` items.

These shapes are deliberately small and JSON-serialisable.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


class Markdown(BaseModel):
    kind: Literal["markdown"] = "markdown"
    text: str


class Latex(BaseModel):
    """A standalone LaTeX equation block (no $$ wrappers — the renderer adds them)."""

    kind: Literal["latex"] = "latex"
    tex: str


class PlotSpec(BaseModel):
    """A 1D or 2D plot as raw arrays. Renderers pick their library (recharts,
    plotly, matplotlib, vega) to draw it."""

    kind: Literal["plot"] = "plot"
    title: str
    plot_type: Literal["line", "scatter", "heatmap", "surface"] = "line"
    x: list[float] = Field(default_factory=list)
    y: list[float] = Field(default_factory=list)
    z: list[list[float]] | None = None  # for heatmap/surface
    x_label: str = ""
    y_label: str = ""


class DiagramSpec(BaseModel):
    """A Mermaid-source diagram. Universally renderable: mermaid.js in the
    browser, mermaid CLI for terminals."""

    kind: Literal["diagram"] = "diagram"
    title: str
    mermaid: str


class Card(BaseModel):
    """A labelled key/value card. Used for parameter summaries, model
    metadata, and the like."""

    kind: Literal["card"] = "card"
    title: str
    fields: dict[str, str | float | int] = Field(default_factory=dict)
    body: str = ""


class Table(BaseModel):
    kind: Literal["table"] = "table"
    title: str
    columns: list[str]
    rows: list[list[Any]]


RenderBlock = Markdown | Latex | PlotSpec | DiagramSpec | Card | Table


def to_dict(blocks: list[RenderBlock]) -> list[dict[str, Any]]:
    """Serialise a list of render blocks to plain dicts (for JSON wire formats)."""

    return [b.model_dump() for b in blocks]
