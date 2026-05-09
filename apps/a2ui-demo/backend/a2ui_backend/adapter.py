"""Map agent_core render blocks → A2UI v0.9 wire messages.

Wire format reference: `@a2ui/web_core/v0_9/schema/server-to-client.ts`
(MessageProcessor.processMessages dispatches on `createSurface` /
`updateComponents` / `updateDataModel` / `deleteSurface`).

Each component is **flat**:

    { "id": "t1", "component": "Text", "text": {"literalString": "hi"},
      "usageHint": "h3" }

— `component` is a string discriminator and properties live alongside.
This is *not* the same shape as the `a2ui_pydantic` package emits
(`{"component": {"Text": {...}}}`); that one is for typed authoring, not
for the renderer wire. The flat shape is what google/A2UI sample agents
emit and what `processMessages(...)` parses.

A2UI's catalog is intentionally narrow. Plots and diagrams have no
primitive in `basicCatalog`, so we render their summaries as `Text`/`Card`
blocks. Trade-off: safety + portability + one renderer-per-platform; we
lose pixel-perfect heatmaps. (For interactive plots, see the AG-UI demo.)
"""

from __future__ import annotations

from typing import Any

from agent_core.render import (
    Card as RenderCard,
    DiagramSpec,
    Latex,
    Markdown,
    PlotSpec,
    RenderBlock,
    Table,
)

VERSION = "v0.9"
CATALOG_ID = "basic_catalog"

_id_counter = 0


def _new_id(prefix: str) -> str:
    global _id_counter
    _id_counter += 1
    return f"{prefix}_{_id_counter}"


def _text(id: str, body: str, *, hint: str | None = None) -> dict[str, Any]:
    out: dict[str, Any] = {
        "id": id,
        "component": "Text",
        "text": {"literalString": body},
    }
    if hint is not None:
        out["usageHint"] = hint
    return out


def _column(id: str, child_ids: list[str]) -> dict[str, Any]:
    return {
        "id": id,
        "component": "Column",
        "children": {"explicitList": child_ids},
    }


def _card(id: str, child_id: str) -> dict[str, Any]:
    return {"id": id, "component": "Card", "child": child_id}


def block_to_components(block: RenderBlock) -> list[dict[str, Any]]:
    """Translate one render block into a flat list of A2UI components.

    Convention: the FIRST element is the **root** for this block; its id is
    what a parent column references.
    """

    if isinstance(block, Markdown):
        return [_text(_new_id("md"), block.text)]

    if isinstance(block, Latex):
        return [_text(_new_id("tex"), f"$$ {block.tex} $$")]

    if isinstance(block, PlotSpec):
        n = len(block.x)
        ymin = min(block.y) if block.y else 0
        ymax = max(block.y) if block.y else 0
        body_id = _new_id("plot_text")
        body = _text(
            body_id,
            (
                f"**{block.title}**  \n"
                f"_type:_ {block.plot_type} · _samples:_ {n}  \n"
                f"_x:_ {block.x[0]:.3g} … {block.x[-1]:.3g}  \n"
                f"_y:_ {ymin:.3g} … {ymax:.3g}  \n"
                f"_(A2UI v0.9 catalog has no chart primitive — see the AG-UI demo for a live recharts version.)_"
            ),
        )
        card_id = _new_id("plot")
        return [_card(card_id, body_id), body]

    if isinstance(block, DiagramSpec):
        body_id = _new_id("diagram_text")
        body = _text(
            body_id,
            f"**{block.title}** _(mermaid source)_  \n```\n{block.mermaid}\n```",
        )
        card_id = _new_id("diagram")
        return [_card(card_id, body_id), body]

    if isinstance(block, RenderCard):
        children: list[dict[str, Any]] = []
        title_id = _new_id("card_title")
        children.append(_text(title_id, f"**{block.title}**"))
        if block.body:
            children.append(_text(_new_id("card_body"), block.body))
        for k, v in block.fields.items():
            children.append(_text(_new_id("card_row"), f"`{k}` · {v}"))
        col_id = _new_id("card_col")
        col = _column(col_id, [c["id"] for c in children])
        card_id = _new_id("card")
        return [_card(card_id, col_id), col, *children]

    if isinstance(block, Table):
        rows: list[dict[str, Any]] = []
        rows.append(_text(_new_id("tbl_head"), "**" + " · ".join(block.columns) + "**"))
        for r in block.rows:
            rows.append(_text(_new_id("tbl_row"), " · ".join(str(c) for c in r)))
        col_id = _new_id("tbl_col")
        col = _column(col_id, [r["id"] for r in rows])
        return [col, *rows]

    return [_text(_new_id("unknown"), f"[unsupported render block: {type(block).__name__}]")]


def create_surface(surface_id: str) -> dict[str, Any]:
    """A `createSurface` message — required before `updateComponents`."""

    return {
        "version": VERSION,
        "createSurface": {"surfaceId": surface_id, "catalogId": CATALOG_ID},
    }


def update_components(
    surface_id: str,
    *,
    header: str | None,
    blocks: list[RenderBlock],
) -> dict[str, Any]:
    """Build a single `updateComponents` message with a Column root."""

    components: list[dict[str, Any]] = []
    if header:
        components.append(_text(_new_id("hdr"), header, hint="h3"))

    block_roots: list[str] = []
    for b in blocks:
        comps = block_to_components(b)
        if comps:
            block_roots.append(comps[0]["id"])
            components.extend(comps)

    # The root component id MUST be "root" — it's what `<a2ui-surface>` mounts.
    root = _column("root", [c["id"] for c in components])
    components.insert(0, root)

    return {
        "version": VERSION,
        "updateComponents": {"surfaceId": surface_id, "components": components},
    }


def text_surface_messages(surface_id: str, body: str) -> list[dict[str, Any]]:
    """Two-message bundle: createSurface + updateComponents with one Text."""

    t_id = _new_id("text")
    return [
        create_surface(surface_id),
        {
            "version": VERSION,
            "updateComponents": {
                "surfaceId": surface_id,
                "components": [
                    _column("root", [t_id]),
                    _text(t_id, body),
                ],
            },
        },
    ]
