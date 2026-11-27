'use strict';

/**
 * Interactive Force-Directed Project Knowledge Graph Renderer (Zero Dependencies)
 * Renders smoothly on Retina HTML5 Canvas with pan, cursor-centered zoom,
 * node drag/pin, hover neighborhood spotlight, directional import arrows,
 * search spotlight, type filtering, and fullscreen expansion.
 */

(function () {
  const KIND_COLORS = {
    code: '#c96442',
    doc: '#2f855a',
    config: '#c07b18',
    test: '#0d9488',
    style: '#b85c7e',
    package: '#5b67ca',
    data: '#a16207',
    folder: '#85786c',
    file: '#7d7b72',
  };

  class KnowledgeGraphView {
    constructor(canvas, { onSelect, onOpenFile } = {}) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.onSelect = onSelect || (() => {});
      this.onOpenFile = onOpenFile || (() => {});

      this.rawGraph = null;
      this.nodes = [];
      this.edges = [];
      this.nodeMap = new Map();
      this.visibleFilters = new Set(['code', 'doc', 'config', 'test', 'style', 'data', 'file', 'folder', 'package']);
      this.searchQuery = '';

      this.tx = 0;
      this.ty = 0;
      this.scale = 1;

      this.hovered = null;
      this.selected = null;
      this.draggingNode = null;
      this.panning = false;
      this.dragMoved = false;
      this.lastMouse = { x: 0, y: 0 };

      this.alpha = 0;
      this.rafId = null;
      this.paused = false;

      this._bindEvents();
    }

    _isDark() {
      return document.documentElement.dataset.theme === 'dark';
    }

    resize() {
      const rect = this.canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const dpr = window.devicePixelRatio || 1;
      this.w = rect.width;
      this.h = rect.height;
      this.canvas.width = Math.round(rect.width * dpr);
      this.canvas.height = Math.round(rect.height * dpr);
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.draw();
    }

    setData(graph) {
      this.rawGraph = graph;
      this.selected = null;
      this.hovered = null;
      this._rebuildFiltered();
      this.fitToView();
      this.reheat(1.0);
    }

    setFilters(filterSet) {
      this.visibleFilters = new Set(filterSet);
      this._rebuildFiltered();
      this.reheat(0.55);
    }

    setSearch(q) {
      this.searchQuery = String(q || '').trim().toLowerCase();
      if (this.searchQuery) {
        const hit = this.nodes.find((n) => this._matchesSearch(n));
        if (hit) {
          this.centerOnNode(hit);
        }
      }
      this.draw();
    }

    _matchesSearch(n) {
      if (!this.searchQuery) return true;
      const q = this.searchQuery;
      if ((n.label || '').toLowerCase().includes(q)) return true;
      if ((n.path || '').toLowerCase().includes(q)) return true;
      if (Array.isArray(n.symbols) && n.symbols.some((s) => (s.name || '').toLowerCase().includes(q))) return true;
      return false;
    }

    _rebuildFiltered() {
      if (!this.rawGraph) return;
      const prevPos = new Map();
      for (const n of this.nodes) prevPos.set(n.id, { x: n.x, y: n.y, fx: n.fx, fy: n.fy });

      const filtered = (this.rawGraph.nodes || []).filter((n) => this.visibleFilters.has(n.kind || 'file'));
      const count = Math.max(1, filtered.length);
      const radius = Math.min(340, 80 + Math.sqrt(count) * 28);

      this.nodes = filtered.map((n, i) => {
        const prev = prevPos.get(n.id);
        const angle = (i / count) * Math.PI * 2;
        const r = n.isRoot ? 0 : (n.kind === 'folder' ? radius * 0.45 : n.kind === 'package' ? radius * 1.1 : radius * (0.65 + (i % 5) * 0.08));
        const deg = (n.inDegree || 0) * 1.6 + (n.outDegree || 0);
        const nodeR = n.isRoot ? 13 : n.kind === 'folder' ? 9 : Math.max(5.5, Math.min(14, 5.5 + Math.sqrt(deg) * 2.1));
        return {
          ...n,
          x: prev ? prev.x : Math.cos(angle) * r + (Math.random() - 0.5) * 22,
          y: prev ? prev.y : Math.sin(angle) * r + (Math.random() - 0.5) * 22,
          vx: 0,
          vy: 0,
          fx: prev ? prev.fx : null,
          fy: prev ? prev.fy : null,
          r: nodeR,
        };
      });

      this.nodeMap = new Map(this.nodes.map((n) => [n.id, n]));
      this.edges = (this.rawGraph.edges || [])
        .filter((e) => this.nodeMap.has(e.source) && this.nodeMap.has(e.target))
        .map((e) => ({
          source: this.nodeMap.get(e.source),
          target: this.nodeMap.get(e.target),
          type: e.type,
        }));
    }

    reheat(amount = 0.85) {
      this.alpha = Math.max(this.alpha, amount);
      this.paused = false;
      this._startLoop();
    }

    fitToView() {
      this.resize();
      if (!this.w || !this.h || !this.nodes.length) {
        this.tx = (this.w || 400) / 2;
        this.ty = (this.h || 300) / 2;
        this.scale = 1;
        this.draw();
        return;
      }
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const n of this.nodes) {
        if (n.x < minX) minX = n.x;
        if (n.x > maxX) maxX = n.x;
        if (n.y < minY) minY = n.y;
        if (n.y > maxY) maxY = n.y;
      }
      const bw = Math.max(120, maxX - minX + 90);
      const bh = Math.max(120, maxY - minY + 90);
      this.scale = Math.max(0.28, Math.min(1.5, Math.min((this.w - 40) / bw, (this.h - 40) / bh)));
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      this.tx = this.w / 2 - cx * this.scale;
      this.ty = this.h / 2 - cy * this.scale;
      this.draw();
    }

    zoomBy(factor) {
      const cx = (this.w || 400) / 2;
      const cy = (this.h || 300) / 2;
      this._zoomAt(cx, cy, factor);
    }

    centerOnNode(nodeOrId) {
      const n = typeof nodeOrId === 'string' ? this.nodeMap.get(nodeOrId) : nodeOrId;
      if (!n || !this.w || !this.h) return;
      this.scale = Math.max(this.scale, 1.05);
      this.tx = this.w / 2 - n.x * this.scale;
      this.ty = this.h / 2 - n.y * this.scale;
      this.selected = n;
      this.onSelect(n, this.getNeighbors(n));
      this.draw();
    }

    getNeighbors(node) {
      const incoming = [];
      const outgoing = [];
      if (!node) return { incoming, outgoing };
      for (const e of this.edges) {
        if (e.source === node) outgoing.push({ node: e.target, type: e.type });
        else if (e.target === node) incoming.push({ node: e.source, type: e.type });
      }
      return { incoming, outgoing };
    }

    _screenToWorld(sx, sy) {
      return {
        x: (sx - this.tx) / this.scale,
        y: (sy - this.ty) / this.scale,
      };
    }

    _zoomAt(sx, sy, factor) {
      const prev = this.scale;
      const next = Math.max(0.2, Math.min(3.5, prev * factor));
      const ratio = next / prev;
      this.tx = sx - (sx - this.tx) * ratio;
      this.ty = sy - (sy - this.ty) * ratio;
      this.scale = next;
      this.draw();
    }

    _hitTest(sx, sy) {
      const pt = this._screenToWorld(sx, sy);
      const pad = 6 / this.scale;
      for (let i = this.nodes.length - 1; i >= 0; i--) {
        const n = this.nodes[i];
        const dx = pt.x - n.x;
        const dy = pt.y - n.y;
        const r = n.r + pad;
        if (dx * dx + dy * dy <= r * r) return n;
      }
      return null;
    }

    _bindEvents() {
      const getPos = (e) => {
        const rect = this.canvas.getBoundingClientRect();
        return { x: e.clientX - rect.left, y: e.clientY - rect.top };
      };

      this.canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        const p = getPos(e);
        const factor = e.deltaY < 0 ? 1.13 : 1 / 1.13;
        this._zoomAt(p.x, p.y, factor);
      }, { passive: false });

      this.canvas.addEventListener('mousedown', (e) => {
        const p = getPos(e);
        this.lastMouse = p;
        this.dragMoved = false;
        const hit = this._hitTest(p.x, p.y);
        if (hit) {
          this.draggingNode = hit;
          const w = this._screenToWorld(p.x, p.y);
          hit.fx = w.x;
          hit.fy = w.y;
          this.reheat(0.35);
        } else {
          this.panning = true;
        }
      });

      window.addEventListener('mousemove', (e) => {
        if (!this.canvas.isConnected) return;
        const p = getPos(e);
        if (this.draggingNode) {
          const dx = p.x - this.lastMouse.x;
          const dy = p.y - this.lastMouse.y;
          if (Math.abs(dx) + Math.abs(dy) > 2) this.dragMoved = true;
          const w = this._screenToWorld(p.x, p.y);
          this.draggingNode.fx = w.x;
          this.draggingNode.fy = w.y;
          this.draggingNode.x = w.x;
          this.draggingNode.y = w.y;
          this.lastMouse = p;
          this.draw();
          return;
        }
        if (this.panning) {
          const dx = p.x - this.lastMouse.x;
          const dy = p.y - this.lastMouse.y;
          if (Math.abs(dx) + Math.abs(dy) > 2) this.dragMoved = true;
          this.tx += dx;
          this.ty += dy;
          this.lastMouse = p;
          this.draw();
          return;
        }
        // Hover hit-test only when pointer is inside canvas bounds
        const rect = this.canvas.getBoundingClientRect();
        if (e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom) {
          const hit = this._hitTest(p.x, p.y);
          if (hit !== this.hovered) {
            this.hovered = hit;
            this.canvas.style.cursor = hit ? 'pointer' : 'grab';
            this.draw();
          }
        }
      });

      window.addEventListener('mouseup', () => {
        if (this.draggingNode) {
          const clicked = this.draggingNode;
          if (!this.dragMoved) {
            clicked.fx = null;
            clicked.fy = null;
            this.selected = clicked;
            this.onSelect(clicked, this.getNeighbors(clicked));
          }
          this.draggingNode = null;
          this.draw();
        } else if (this.panning) {
          if (!this.dragMoved) {
            this.selected = null;
            this.onSelect(null, { incoming: [], outgoing: [] });
            this.draw();
          }
          this.panning = false;
        }
      });

      this.canvas.addEventListener('dblclick', (e) => {
        const p = getPos(e);
        const hit = this._hitTest(p.x, p.y);
        if (hit && hit.path && hit.kind !== 'folder') {
          this.onOpenFile(hit.path);
        }
      });
    }

    _stepPhysics() {
      const nodes = this.nodes;
      const edges = this.edges;
      const n = nodes.length;
      if (!n) return;

      const alpha = this.alpha;
      const repulse = n > 180 ? 1100 : 1850;
      const damp = 0.82;

      // Pairwise repulsion (capped distance for smooth speed on large projects)
      for (let i = 0; i < n; i++) {
        const a = nodes[i];
        // Gentle center pull
        a.vx += -a.x * 0.018 * alpha;
        a.vy += -a.y * 0.018 * alpha;

        for (let j = i + 1; j < n; j++) {
          const b = nodes[j];
          let dx = a.x - b.x;
          let dy = a.y - b.y;
          let d2 = dx * dx + dy * dy;
          if (d2 > 140000) continue;
          if (d2 < 4) { dx = (Math.random() - 0.5) * 4; dy = (Math.random() - 0.5) * 4; d2 = 16; }
          const f = (repulse * alpha) / d2;
          const dist = Math.sqrt(d2);
          const fx = (dx / dist) * f;
          const fy = (dy / dist) * f;
          a.vx += fx; a.vy += fy;
          b.vx -= fx; b.vy -= fy;
        }
      }

      // Edge springs
      for (const e of edges) {
        const a = e.source;
        const b = e.target;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const targetLen = e.type === 'contains' ? 56 : e.type === 'depends_on' ? 92 : 76;
        const k = e.type === 'imports' || e.type === 'links_to' ? 0.085 : 0.045;
        const f = (dist - targetLen) * k * alpha;
        const fx = (dx / dist) * f;
        const fy = (dy / dist) * f;
        a.vx += fx; a.vy += fy;
        b.vx -= fx; b.vy -= fy;
      }

      for (const nd of nodes) {
        if (nd.fx != null && nd.fy != null) {
          nd.x = nd.fx;
          nd.y = nd.fy;
          nd.vx = 0;
          nd.vy = 0;
          continue;
        }
        nd.vx *= damp;
        nd.vy *= damp;
        nd.x += Math.max(-18, Math.min(18, nd.vx));
        nd.y += Math.max(-18, Math.min(18, nd.vy));
      }

      this.alpha *= 0.965;
    }

    _startLoop() {
      if (this.rafId) return;
      const tick = () => {
        if (this.paused || this.alpha < 0.012) {
          this.rafId = null;
          this.draw();
          return;
        }
        this._stepPhysics();
        this.draw();
        this.rafId = requestAnimationFrame(tick);
      };
      this.rafId = requestAnimationFrame(tick);
    }

    draw() {
      if (!this.w || !this.h) return;
      const ctx = this.ctx;
      const dark = this._isDark();

      ctx.clearRect(0, 0, this.w, this.h);

      // Subtle architectural dot grid background
      ctx.save();
      const gridStep = Math.max(24, 34 * this.scale);
      const ox = ((this.tx % gridStep) + gridStep) % gridStep;
      const oy = ((this.ty % gridStep) + gridStep) % gridStep;
      ctx.fillStyle = dark ? 'rgba(255,255,255,0.045)' : 'rgba(31,30,29,0.055)';
      for (let gx = ox; gx < this.w; gx += gridStep) {
        for (let gy = oy; gy < this.h; gy += gridStep) {
          ctx.fillRect(gx, gy, 1.2, 1.2);
        }
      }
      ctx.restore();

      const focus = this.hovered || this.selected;
      const connected = new Set();
      if (focus) {
        connected.add(focus.id);
        for (const e of this.edges) {
          if (e.source === focus) connected.add(e.target.id);
          else if (e.target === focus) connected.add(e.source.id);
        }
      }

      ctx.save();
      ctx.translate(this.tx, this.ty);
      ctx.scale(this.scale, this.scale);

      // Edges
      for (const e of this.edges) {
        const isFocusEdge = focus && (e.source === focus || e.target === focus);
        const isSemantic = e.type === 'imports' || e.type === 'links_to';
        ctx.beginPath();
        ctx.moveTo(e.source.x, e.source.y);
        ctx.lineTo(e.target.x, e.target.y);

        if (isFocusEdge) {
          const isOut = e.source === focus;
          ctx.strokeStyle = isOut
            ? (dark ? '#e58a6c' : '#c96442')
            : (dark ? '#34d399' : '#059669');
          ctx.lineWidth = 1.9 / Math.sqrt(this.scale);
        } else if (focus) {
          ctx.strokeStyle = dark ? 'rgba(255,255,255,0.04)' : 'rgba(31,30,29,0.045)';
          ctx.lineWidth = 0.7;
        } else if (isSemantic) {
          ctx.strokeStyle = dark ? 'rgba(217,119,87,0.42)' : 'rgba(201,100,66,0.38)';
          ctx.lineWidth = 1.25;
        } else if (e.type === 'depends_on') {
          ctx.strokeStyle = dark ? 'rgba(129,140,248,0.28)' : 'rgba(91,103,202,0.26)';
          ctx.lineWidth = 0.9;
        } else {
          ctx.strokeStyle = dark ? 'rgba(255,255,255,0.11)' : 'rgba(31,30,29,0.11)';
          ctx.lineWidth = 0.85;
        }
        ctx.stroke();

        // Directional arrowhead for semantic imports & focused edges
        if (isSemantic || isFocusEdge) {
          const dx = e.target.x - e.source.x;
          const dy = e.target.y - e.source.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          if (dist > e.target.r + 6) {
            const ax = e.target.x - (dx / dist) * (e.target.r + 3);
            const ay = e.target.y - (dy / dist) * (e.target.r + 3);
            const ang = Math.atan2(dy, dx);
            const al = isFocusEdge ? 6.5 : 4.8;
            ctx.beginPath();
            ctx.moveTo(ax, ay);
            ctx.lineTo(ax - al * Math.cos(ang - 0.42), ay - al * Math.sin(ang - 0.42));
            ctx.lineTo(ax - al * Math.cos(ang + 0.42), ay - al * Math.sin(ang + 0.42));
            ctx.closePath();
            ctx.fillStyle = ctx.strokeStyle;
            ctx.fill();
          }
        }
      }

      // Nodes
      const showAllLabels = this.scale > 0.88 || this.nodes.length <= 45;
      for (const n of this.nodes) {
        const searchMatch = this._matchesSearch(n);
        const dimByFocus = focus && !connected.has(n.id);
        const dimBySearch = this.searchQuery && !searchMatch;
        const dimmed = dimByFocus || dimBySearch;
        const color = KIND_COLORS[n.kind] || KIND_COLORS.file;

        ctx.globalAlpha = dimmed ? 0.18 : 1;

        // Selection / search halo
        if (n === this.selected || (this.searchQuery && searchMatch)) {
          ctx.beginPath();
          ctx.arc(n.x, n.y, n.r + 4.5, 0, Math.PI * 2);
          ctx.fillStyle = dark ? 'rgba(217,119,87,0.28)' : 'rgba(201,100,66,0.22)';
          ctx.fill();
        }

        ctx.beginPath();
        if (n.kind === 'folder') {
          const s = n.r;
          ctx.roundRect(n.x - s, n.y - s * 0.8, s * 2, s * 1.6, 3.5);
        } else {
          ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
        }
        ctx.fillStyle = color;
        ctx.fill();
        ctx.lineWidth = n === focus ? 2 : 1.1;
        ctx.strokeStyle = dark ? '#262624' : '#faf9f5';
        ctx.stroke();

        // Label
        const shouldLabel = showAllLabels || n === focus || n.isRoot || n.r >= 9.5 || (this.searchQuery && searchMatch) || (focus && connected.has(n.id));
        if (shouldLabel && !dimmed) {
          const fontSize = Math.max(9.5, Math.min(12.5, 11 / Math.pow(this.scale, 0.25)));
          ctx.font = `${n === focus || n.isRoot ? '600 ' : '500 '}${fontSize}px Inter, system-ui, sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'top';
          ctx.fillStyle = dark ? '#f4f3ec' : '#1f1e1d';
          const lbl = n.label.length > 26 ? n.label.slice(0, 24) + '…' : n.label;
          ctx.fillText(lbl, n.x, n.y + n.r + 4);
        }
      }

      ctx.globalAlpha = 1;
      ctx.restore();
    }
  }

  window.KnowledgeGraphView = KnowledgeGraphView;
  window.GRAPH_KIND_COLORS = KIND_COLORS;
})();
