/**
 * Iframe UI for the lattice_simulate tool.
 *
 * Demonstrates the MCP Apps round-trip:
 *   1. The host calls `lattice_simulate(...)` and mounts this iframe.
 *   2. The first tool result arrives via `app.ontoolresult` — we paint the chart.
 *   3. The user moves the β slider or clicks "re-run". We call
 *      `app.callServerTool({...})`, the server runs it, and we redraw.
 *
 * No model intervention is needed for the slider — that's the unique value of
 * MCP Apps: an interactive UI that the host trusts to call back into the same
 * MCP server it was hosted by.
 */
import { App } from "@modelcontextprotocol/ext-apps";

type PlotSpec = {
  kind: "plot";
  title: string;
  plot_type: string;
  x: number[];
  y: number[];
  x_label?: string;
  y_label?: string;
};
type Card = { kind: "card"; title: string; fields: Record<string, string | number> };
type RenderBlock = PlotSpec | Card | { kind: "markdown"; text: string };
type ToolResult = { blocks: RenderBlock[] };

const $ = <T extends Element = Element>(sel: string) => document.querySelector(sel) as T;
const beta = $<HTMLInputElement>("#beta");
const betaVal = $("#beta-val") as HTMLSpanElement;
const steps = $<HTMLInputElement>("#steps");
const run = $<HTMLButtonElement>("#run");
const chart = $<SVGSVGElement>("#chart");
const summary = $("#summary") as HTMLDivElement;

beta.addEventListener("input", () => (betaVal.textContent = beta.value));

const app = new App({ name: "Lattice MC App", version: "0.1.0" });

app.ontoolresult = (result) => {
  const text = result.content?.find((c) => c.type === "text")?.text;
  if (!text) {
    summary.textContent = "[no content]";
    return;
  }
  try {
    paint(JSON.parse(text) as ToolResult);
  } catch (e) {
    summary.textContent = `[parse error] ${e}`;
  }
};

run.addEventListener("click", async () => {
  run.disabled = true;
  summary.textContent = "running…";
  try {
    const result = await app.callServerTool({
      name: "lattice_simulate",
      arguments: {
        model: "ising_2d",
        beta: parseFloat(beta.value),
        steps: parseInt(steps.value, 10),
      },
    });
    const text = result.content?.find((c) => c.type === "text")?.text;
    if (text) paint(JSON.parse(text) as ToolResult);
  } catch (e) {
    summary.textContent = `[error] ${e}`;
  } finally {
    run.disabled = false;
  }
});

app.connect();

function paint(result: ToolResult) {
  const plot = result.blocks.find((b): b is PlotSpec => b.kind === "plot");
  const card = result.blocks.find((b): b is Card => b.kind === "card");
  if (!plot) {
    summary.textContent = "[no plot block]";
    return;
  }
  drawLine(chart, plot.x, plot.y);
  summary.textContent = card
    ? Object.entries(card.fields)
        .map(([k, v]) => `${k}=${v}`)
        .join("  ")
    : `n=${plot.x.length}`;
}

function drawLine(svg: SVGSVGElement, xs: number[], ys: number[]) {
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  const w = svg.viewBox.baseVal.width;
  const h = svg.viewBox.baseVal.height;
  const padL = 36, padR = 8, padT = 8, padB = 24;
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const yMin = Math.min(...ys), yMax = Math.max(...ys);
  const xR = xMax - xMin || 1;
  const yR = yMax - yMin || 1;
  const X = (x: number) => padL + ((x - xMin) / xR) * (w - padL - padR);
  const Y = (y: number) => h - padB - ((y - yMin) / yR) * (h - padT - padB);

  const ns = "http://www.w3.org/2000/svg";
  const axis = (x1: number, y1: number, x2: number, y2: number) => {
    const l = document.createElementNS(ns, "line");
    l.setAttribute("x1", String(x1));
    l.setAttribute("y1", String(y1));
    l.setAttribute("x2", String(x2));
    l.setAttribute("y2", String(y2));
    l.setAttribute("stroke", "currentColor");
    l.setAttribute("stroke-opacity", "0.4");
    svg.appendChild(l);
  };
  axis(padL, h - padB, w - padR, h - padB);
  axis(padL, padT, padL, h - padB);

  const path = document.createElementNS(ns, "path");
  let d = "";
  xs.forEach((x, i) => {
    d += `${i === 0 ? "M" : "L"} ${X(x).toFixed(2)} ${Y(ys[i]).toFixed(2)} `;
  });
  path.setAttribute("d", d);
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "#0ea5e9");
  path.setAttribute("stroke-width", "1.5");
  svg.appendChild(path);

  const txt = (x: number, y: number, s: string, anchor = "start") => {
    const t = document.createElementNS(ns, "text");
    t.setAttribute("x", String(x));
    t.setAttribute("y", String(y));
    t.setAttribute("font-size", "10");
    t.setAttribute("text-anchor", anchor);
    t.setAttribute("fill", "currentColor");
    t.setAttribute("opacity", "0.6");
    t.textContent = s;
    svg.appendChild(t);
  };
  txt(padL, h - 4, `${xMin.toFixed(0)}`);
  txt(w - padR, h - 4, `${xMax.toFixed(0)}`, "end");
  txt(4, padT + 6, yMax.toFixed(2));
  txt(4, h - padB, yMin.toFixed(2));
}
