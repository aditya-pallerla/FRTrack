/**
 * Road-network router over the bundled OpenStreetMap graph (Dijkstra, travel time).
 *
 * Why a local graph router: it removes BLOCKED segments exactly, so "no route" really means the
 * settlement is unreachable in the mapped network (CUT OFF), and results are identical every run.
 * It always returns real road geometry — there is no straight-line fallback anywhere.
 */
import type { RoadSegment, RoadState, RouteResult } from '../../../shared/types.js';
import { ACCESS } from '../engine/config.js';

interface Edge { to: string; seg: RoadSegment; forward: boolean }
interface TreeEdge extends Edge { fromNode: string }
export interface PathTree { from: string; dist: Map<string, number>; prev: Map<string, TreeEdge> }

export const NO_ROUTE: RouteResult = { status: 'no_route', coords: [], segment_ids: [], distance_m: 0, duration_s: 0, uses_at_risk: [] };

export class RoadGraph {
  readonly segments: Map<string, RoadSegment>;
  /** Node positions (from segment end points). */
  readonly nodes = new Map<string, { lat: number; lng: number }>();
  private readonly adj = new Map<string, Edge[]>();

  constructor(segments: RoadSegment[]) {
    this.segments = new Map(segments.map((s) => [s.id, s]));
    for (const s of segments) {
      const a = s.coords[0];
      const b = s.coords[s.coords.length - 1];
      this.nodes.set(s.from, { lat: a[0], lng: a[1] });
      this.nodes.set(s.to, { lat: b[0], lng: b[1] });
      this.add(s.from, { to: s.to, seg: s, forward: true });
      if (!s.oneway) this.add(s.to, { to: s.from, seg: s, forward: false });
    }
  }

  private add(node: string, e: Edge) {
    const list = this.adj.get(node);
    if (list) list.push(e); else this.adj.set(node, [e]);
  }

  private cacheSig = '';
  private cache = new Map<string, PathTree>();

  /**
   * tree() with memoisation per road-status snapshot: when no road status changed since the last
   * evaluation (most replay steps), trees are reused instead of recomputed.
   */
  cachedTree(from: string, statuses: Map<string, RoadState>): PathTree {
    const sig = [...statuses.values()].map((s) => `${s.segment_id}:${s.status}`).sort().join('|');
    if (sig !== this.cacheSig) { this.cache.clear(); this.cacheSig = sig; }
    let t = this.cache.get(from);
    if (!t) { t = this.tree(from, statuses); this.cache.set(from, t); }
    return t;
  }

  hasNode(id: string) { return this.adj.has(id); }
  get nodeCount() { return this.adj.size; }

  /**
   * Fastest route from → to. BLOCKED segments are removed; AT_RISK segments are allowed but penalised
   * (so a safer road is preferred when one exists). Reported duration is the unpenalised travel time.
   */
  route(from: string, to: string, statuses: Map<string, RoadState> = new Map(), opts: { penalise?: boolean } = {}): RouteResult {
    if (!this.adj.has(from) || !this.adj.has(to)) return NO_ROUTE;
    return this.pathTo(this.tree(from, statuses, { ...opts, target: to }), to, statuses);
  }

  /** Shortest-path tree from one node (optionally stopping once `target` is settled). */
  tree(from: string, statuses: Map<string, RoadState> = new Map(), opts: { penalise?: boolean; target?: string } = {}): PathTree {
    const penalise = opts.penalise ?? true;
    const dist = new Map<string, number>([[from, 0]]);
    const prev = new Map<string, TreeEdge>();
    if (!this.adj.has(from)) return { from, dist, prev };
    const heap = new MinHeap();
    heap.push(0, from);
    while (heap.size) {
      const [d, node] = heap.pop()!;
      if (d > (dist.get(node) ?? Infinity)) continue;
      if (node === opts.target) break;
      for (const e of this.adj.get(node) ?? []) {
        const st = statuses.get(e.seg.id)?.status;
        if (st === 'BLOCKED') continue;
        const nd = d + travelSeconds(e.seg) * (penalise && st === 'AT_RISK' ? ACCESS.at_risk_penalty : 1);
        if (nd < (dist.get(e.to) ?? Infinity)) {
          dist.set(e.to, nd);
          prev.set(e.to, { ...e, fromNode: node });
          heap.push(nd, e.to);
        }
      }
    }
    return { from, dist, prev };
  }

  /** Extracts the route to `to` from a tree built by tree(). */
  pathTo(tree: PathTree, to: string, statuses: Map<string, RoadState> = new Map()): RouteResult {
    const { from, prev } = tree;
    if (from !== to && !prev.has(to)) return NO_ROUTE;
    const edges: TreeEdge[] = [];
    for (let n = to; n !== from;) { const e = prev.get(n)!; edges.push(e); n = e.fromNode; }
    edges.reverse();
    const coords: [number, number][] = [];
    let distance = 0;
    let duration = 0;
    const atRisk: string[] = [];
    for (const e of edges) {
      const pts = e.forward ? e.seg.coords : [...e.seg.coords].reverse();
      coords.push(...(coords.length ? pts.slice(1) : pts));
      distance += e.seg.length_m;
      duration += travelSeconds(e.seg);
      if (statuses.get(e.seg.id)?.status === 'AT_RISK') atRisk.push(e.seg.id);
    }
    return {
      status: 'ok', coords, segment_ids: edges.map((e) => e.seg.id),
      distance_m: Math.round(distance), duration_s: Math.round(duration), uses_at_risk: atRisk,
    };
  }

  /** Every node reachable from `from` when BLOCKED segments are removed (ground truth for CUT OFF checks). */
  reachable(from: string, statuses: Map<string, RoadState>): Set<string> {
    const seen = new Set<string>([from]);
    const stack = [from];
    while (stack.length) {
      const n = stack.pop()!;
      for (const e of this.adj.get(n) ?? []) {
        if (statuses.get(e.seg.id)?.status === 'BLOCKED' || seen.has(e.to)) continue;
        seen.add(e.to);
        stack.push(e.to);
      }
    }
    return seen;
  }
}

export const travelSeconds = (s: RoadSegment) => s.length_m / ((s.speed_kmh * 1000) / 3600);

class MinHeap {
  private k: number[] = [];
  private v: string[] = [];
  get size() { return this.k.length; }
  push(key: number, val: string) {
    this.k.push(key); this.v.push(val);
    let i = this.k.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.k[p] <= this.k[i]) break;
      this.swap(i, p); i = p;
    }
  }
  pop(): [number, string] | undefined {
    if (!this.k.length) return undefined;
    const top: [number, string] = [this.k[0], this.v[0]];
    const lk = this.k.pop()!; const lv = this.v.pop()!;
    if (this.k.length) {
      this.k[0] = lk; this.v[0] = lv;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < this.k.length && this.k[l] < this.k[m]) m = l;
        if (r < this.k.length && this.k[r] < this.k[m]) m = r;
        if (m === i) break;
        this.swap(i, m); i = m;
      }
    }
    return top;
  }
  private swap(a: number, b: number) {
    [this.k[a], this.k[b]] = [this.k[b], this.k[a]];
    [this.v[a], this.v[b]] = [this.v[b], this.v[a]];
  }
}
