/**
 * @genui/star-sim — pure simulation primitives shared between the
 * star-systems server and the cockpit iframe. No DOM, no Three.js,
 * no network. Numerical / state-only.
 *
 * Pass 1 (current): physics constants, throttle/brake math, warp
 * alignment math, formatters. Both the iframe's tick() and the
 * server's tools import these.
 *
 * Pass 2+: a full `stepShip(ship, dt, world, intent)` that the
 * server's 20 Hz Colyseus Room tick consumes; iframe stops mutating
 * its own ship and switches to render-only.
 */

export * from "./constants.js";
export * from "./throttle.js";
export * from "./format.js";
export * from "./warp.js";
