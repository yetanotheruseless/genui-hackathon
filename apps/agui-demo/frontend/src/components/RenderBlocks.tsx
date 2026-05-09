"use client";

import { useEffect, useRef } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer } from "recharts";
import "katex/dist/katex.min.css";
import { BlockMath } from "react-katex";
import mermaid from "mermaid";

import type { RenderBlock, PlotSpec, DiagramSpec, Card, Table, Markdown, Latex } from "@/lib/types";

mermaid.initialize({ startOnLoad: false, theme: "neutral" });

export function RenderBlocks({ blocks }: { blocks: RenderBlock[] }) {
  return (
    <div className="space-y-3">
      {blocks.map((b, i) => (
        <Block key={i} block={b} />
      ))}
    </div>
  );
}

function Block({ block }: { block: RenderBlock }) {
  switch (block.kind) {
    case "markdown":
      return <MarkdownBlock block={block} />;
    case "latex":
      return <LatexBlock block={block} />;
    case "plot":
      return <PlotBlock block={block} />;
    case "diagram":
      return <DiagramBlock block={block} />;
    case "card":
      return <CardBlock block={block} />;
    case "table":
      return <TableBlock block={block} />;
  }
}

function MarkdownBlock({ block }: { block: Markdown }) {
  // Minimal: render as preformatted text. Swap in react-markdown later if needed.
  return <div className="text-sm whitespace-pre-wrap">{block.text}</div>;
}

function LatexBlock({ block }: { block: Latex }) {
  return (
    <div className="rounded border border-zinc-200 dark:border-zinc-700 p-3 bg-zinc-50 dark:bg-zinc-900">
      <BlockMath math={block.tex} />
    </div>
  );
}

function PlotBlock({ block }: { block: PlotSpec }) {
  if (block.plot_type === "heatmap" || block.plot_type === "surface") {
    return <HeatmapBlock block={block} />;
  }
  const data = block.x.map((x, i) => ({ x, y: block.y[i] }));
  return (
    <figure className="rounded border border-zinc-200 dark:border-zinc-700 p-3 bg-white dark:bg-zinc-900">
      <figcaption className="text-xs text-zinc-500 mb-1">{block.title}</figcaption>
      <div className="h-56">
        <ResponsiveContainer>
          <LineChart data={data} margin={{ top: 8, right: 16, bottom: 24, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="x" type="number" domain={["auto", "auto"]} label={{ value: block.x_label, position: "insideBottom", offset: -8 }} />
            <YAxis dataKey="y" type="number" domain={["auto", "auto"]} width={48} label={{ value: block.y_label, angle: -90, position: "insideLeft" }} />
            <Tooltip />
            <Line type="monotone" dataKey="y" stroke="#0ea5e9" dot={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}

function HeatmapBlock({ block }: { block: PlotSpec }) {
  const z = block.z ?? [];
  if (z.length === 0) return <div className="text-xs text-zinc-500">empty heatmap</div>;
  const flat = z.flat();
  const min = Math.min(...flat);
  const max = Math.max(...flat);
  const span = max - min || 1;
  const cell = 4;
  return (
    <figure className="rounded border border-zinc-200 dark:border-zinc-700 p-3 bg-white dark:bg-zinc-900">
      <figcaption className="text-xs text-zinc-500 mb-2">
        {block.title} ({z.length}×{z[0]?.length ?? 0})
      </figcaption>
      <svg width={z[0].length * cell} height={z.length * cell} role="img">
        {z.map((row, i) =>
          row.map((v, j) => {
            const t = (v - min) / span;
            const r = Math.round(255 * t);
            const b = Math.round(255 * (1 - t));
            return <rect key={`${i}-${j}`} x={j * cell} y={i * cell} width={cell} height={cell} fill={`rgb(${r}, 32, ${b})`} />;
          })
        )}
      </svg>
    </figure>
  );
}

function DiagramBlock({ block }: { block: DiagramSpec }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!ref.current) return;
    const id = `mmd-${Math.random().toString(36).slice(2)}`;
    mermaid
      .render(id, block.mermaid)
      .then(({ svg }) => {
        if (ref.current) ref.current.innerHTML = svg;
      })
      .catch((e) => {
        if (ref.current) ref.current.innerText = `mermaid error: ${e}`;
      });
  }, [block.mermaid]);
  return (
    <figure className="rounded border border-zinc-200 dark:border-zinc-700 p-3 bg-white dark:bg-zinc-900">
      <figcaption className="text-xs text-zinc-500 mb-2">{block.title}</figcaption>
      <div ref={ref} />
    </figure>
  );
}

function CardBlock({ block }: { block: Card }) {
  return (
    <div className="rounded border border-zinc-200 dark:border-zinc-700 p-3 bg-zinc-50 dark:bg-zinc-900">
      <div className="text-xs uppercase tracking-wide text-zinc-500 mb-1">{block.title}</div>
      {block.body && <div className="text-sm mb-2">{block.body}</div>}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm font-mono">
        {Object.entries(block.fields).map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-zinc-500">{k}</dt>
            <dd>{String(v)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function TableBlock({ block }: { block: Table }) {
  return (
    <div className="rounded border border-zinc-200 dark:border-zinc-700 p-3 bg-white dark:bg-zinc-900 overflow-auto">
      <div className="text-xs uppercase tracking-wide text-zinc-500 mb-1">{block.title}</div>
      <table className="text-sm">
        <thead>
          <tr>{block.columns.map((c) => <th key={c} className="px-2 text-left">{c}</th>)}</tr>
        </thead>
        <tbody>
          {block.rows.map((r, i) => (
            <tr key={i}>{r.map((v, j) => <td key={j} className="px-2">{String(v)}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
