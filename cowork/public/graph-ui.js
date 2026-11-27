'use strict';

/**
 * High-Craft Interactive Project Knowledge Graph Renderer for mx-Cowork
 *
 * Features:
 *  - 3 instant layout modes: Clustered Force, Radial Hubs, and Layered Hierarchy
 *  - Soft translucent Cluster Zone hulls with cluster headings (from Fast Model or folders)
 *  - Collision-free spacing + smooth quadratic Bezier edges with directional arrows
 *  - Crisp pill labels (zero line-through clutter) + floating hover tooltip with Fast-Model AI Role
 *  - Distinct node shapes: Folder (rounded rect), Package (hexagon), Files (hub-scaled circles)
 *  - Edge-type toggles (Imports, AI Semantic Links, Folder Tree) + Cluster spotlighting
 *  - Cursor-centered zoom, drag-to-pan, drag-to-pin nodes, double-click to edit file
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

  const CLUSTER_PALETTE = [
    '#c96442', '#2f855a', '#5b67ca', '#c07b18', '#0d9488', '#b85c7e', '#7c3aed', '#0284c7',
  ];

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
      this.clusterMap = new Map(); // clusterName -> { name, color, cx, cy, count }

      this.visibleFilters = new Set(['code', 'doc', 'config', 'test', 'style', 'data', 'file', 'folder', 'package']);
      this.showTreeEdges = true;
      this.layoutMode = 'force'; // 'force' | 'radial' | 'hierarchy'
      this.activeCluster = '';
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
      this.pointerScreen = { x: 0, y: 0 };

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
      this.activeCluster = '';
      this._rebuildFiltered(true);
      this.applyLayout(this.layoutMode);
    }

    setFilters(filterSet) {
      this.visibleFilters = new Set(filterSet);
      this._rebuildFiltered(false);
      this.applyLayout(this.layoutMode);
    }

    setShowTreeEdges(show) {
      this.showTreeEdges = Boolean(show);
      this.draw();
    }

    setClusterFocus(clusterName) {
      this.activeCluster = this.activeCluster === clusterName ? '' : String(clusterName || '');
      if (this.activeCluster) {
        const members = this.nodes.filter((n) => n._cluster === this.activeCluster);
        if (members.length) this._fitNodes(members);
      } else {
        this.fitToView();
      }
      this.draw();
    }

    setSearch(q) {
      this.searchQuery = String(q || '').trim().toLowerCase();
      if (this.searchQuery) {
        const hit = this.nodes.find((n) => this._matchesSearch(n));
        if (hit) this.centerOnNode(hit);
      }
      this.draw();
    }

    _matchesSearch(n) {
      if (!this.searchQuery) return true;
      const q = this.searchQuery;
      if ((n.label || '').toLowerCase().includes(q)) return true;
      if ((n.path || '').toLowerCase().includes(q)) return true;
      if ((n.aiRole || '').toLowerCase().includes(q)) return true;
      if ((n._cluster || '').toLowerCase().includes(q)) return true;
      if (Array.isArray(n.symbols) && n.symbols.some((s) => (s.name || '').toLowerCase().includes(q))) return true;
      return false;
    }

    _resolveNodeCluster(n) {
      if (n.cluster) return n.cluster;
      if (n.kind === 'package') return 'Dependencies';
      if (n.isRoot) return 'Root';
      if (n.path) {
        const seg = n.path.split('/')[0];
        return n.path.includes('/') ? seg : 'Root';
      }
      return 'Root';
    }

    _rebuildFiltered(freshPositions = false) {
      if (!this.rawGraph) return;
      const prevPos = new Map();
      if (!freshPositions) {
        for (const n of this.nodes) prevPos.set(n.id, { x: n.x, y: n.y, fx: n.fx, fy: n.fy });
      }

      const filtered = (this.rawGraph.nodes || []).filter((n) => this.visibleFilters.has(n.kind || 'file'));

      // Assign clusters & evenly spaced cluster anchors around a ring
      const clusterNames = [];
      const clusterSet = new Set();
      for (const n of filtered) {
        const cname = this._resolveNodeCluster(n);
        if (!clusterSet.has(cname)) {
          clusterSet.add(cname);
          clusterNames.push(cname);
        }
      }

      this.clusterMap = new Map();
      const cCount = Math.max(1, clusterNames.length);
      const ringR = cCount <= 2 ? 120 : Math.min(340, 150 + cCount * 24);
      clusterNames.forEach((name, idx) => {
        const ang = (idx / cCount) * Math.PI * 2 - Math.PI / 2;
        const isCenter = name === 'Root' && cCount > 2;
        this.clusterMap.set(name, {
          name,
          color: CLUSTER_PALETTE[idx % CLUSTER_PALETTE.length],
          cx: isCenter ? 0 : Math.cos(ang) * ringR,
          cy: isCenter ? 0 : Math.sin(ang) * ringR,
          count: 0,
        });
      });

      this.nodes = filtered.map((n, i) => {
        const prev = prevPos.get(n.id);
        const cname = this._resolveNodeCluster(n);
        const cl = this.clusterMap.get(cname);
        if (cl) cl.count++;

        const semDeg = (n.inDegree || 0) * 1.8 + (n.outDegree || 0);
        const nodeR = n.isRoot
          ? 14
          : n.kind === 'folder'
            ? 10
            : n.kind === 'package'
              ? 8
              : Math.max(6, Math.min(16, 6 + Math.sqrt(semDeg) * 2.3));

        const localAng = (i * 2.39996); // golden angle spiral inside cluster
        const localR = n.isRoot ? 0 : 18 + Math.sqrt((cl?.count || 1)) * 22;

        return {
          ...n,
          _cluster: cname,
          x: prev ? prev.x : (cl ? cl.cx : 0) + Math.cos(localAng) * localR,
          y: prev ? prev.y : (cl ? cl.cy : 0) + Math.sin(localAng) * localR,
          vx: 0,
          vy: 0,
          fx: prev ? prev.fx : null,
          fy: prev ? prev.fy : null,
          r: nodeR,
          hubScore: semDeg,
        };
      });

      this.nodeMap = new Map(this.nodes.map((n) => [n.id, n]));
      this.edges = (this.rawGraph.edges || [])
        .filter((e) => this.nodeMap.has(e.source) && this.nodeMap.has(e.target))
        .map((e) => ({
          source: this.nodeMap.get(e.source),
          target: this.nodeMap.get(e.target),
          type: e.type,
          label: e.label || '',
        }));
    }

    applyLayout(mode = 'force') {
      this.layoutMode = mode;
      for (const n of this.nodes) { n.fx = null; n.fy = null; n.vx = 0; n.vy = 0; }

      if (mode === 'radial') {
        this.paused = true;
        this.alpha = 0;
        const sorted = [...this.nodes].sort((a, b) => (b.isRoot ? 999 : b.hubScore) - (a.isRoot ? 999 : a.hubScore));
        const inner = sorted.slice(0, Math.min(8, sorted.length));
        const mid = sorted.slice(inner.length, Math.min(inner.length + 28, sorted.length));
        const outer = sorted.slice(inner.length + mid.length);

        const placeRing = (arr, radius, offset = 0) => {
          const cnt = Math.max(1, arr.length);
          arr.forEach((n, idx) => {
            if (n.isRoot && radius === 0) { n.x = 0; n.y = 0; return; }
            const a = offset + (idx / cnt) * Math.PI * 2 - Math.PI / 2;
            n.x = Math.cos(a) * radius;
            n.y = Math.sin(a) * radius;
          });
        };
        if (inner.length === 1) { inner[0].x = 0; inner[0].y = 0; }
        else placeRing(inner, Math.max(70, inner.length * 16));
        placeRing(mid, Math.max(190, mid.length * 9), 0.25);
        placeRing(outer, Math.max(330, outer.length * 7.5), 0.5);
        this.fitToView();
        return;
      }

      if (mode === 'hierarchy') {
        this.paused = true;
        this.alpha = 0;
        const cols = new Map();
        for (const n of this.nodes) {
          let depth = 0;
          if (n.isRoot) depth = 0;
          else if (n.kind === 'package') depth = 4;
          else if (n.kind === 'folder') depth = 1 + (n.path.split('/').length - 1);
          else depth = 1 + (n.path ? n.path.split('/').length : 1);
          depth = Math.min(5, depth);
          if (!cols.has(depth)) cols.set(depth, []);
          cols.get(depth).push(n);
        }
        const sortedDepths = [...cols.keys()].sort((a, b) => a - b);
        const colSpacing = 220;
        sortedDepths.forEach((d, ci) => {
          const list = cols.get(d).sort((a, b) => (a._cluster || '').localeCompare(b._cluster || '') || a.label.localeCompare(b.label));
          const rowGap = Math.max(34, Math.min(52, 560 / Math.max(1, list.length)));
          const totalH = (list.length - 1) * rowGap;
          list.forEach((n, ri) => {
            n.x = (ci - (sortedDepths.length - 1) / 2) * colSpacing;
            n.y = ri * rowGap - totalH / 2;
          });
        });
        this.fitToView();
        return;
      }

      // Default: Clustered Force layout — warm up 45 ticks synchronously so initial frame already looks crisp!
      this.paused = false;
      this.alpha = 0.95;
      for (let i = 0; i < 45; i++) this._stepPhysics();
      this.fitToView();
      this._startLoop();
    }

    reheat(amount = 0.75) {
      if (this.layoutMode !== 'force') return;
      this.alpha = Math.max(this.alpha, amount);
      this.paused = false;
      this._startLoop();
    }

    _fitNodes(nodeList) {
      this.resize();
      if (!this.w || !this.h || !nodeList.length) return;
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const n of nodeList) {
        if (n.x - n.r < minX) minX = n.x - n.r;
        if (n.x + n.r > maxX) maxX = n.x + n.r;
        if (n.y - n.r < minY) minY = n.y - n.r;
        if (n.y + n.r > maxY) maxY = n.y + n.r;
      }
      const bw = Math.max(140, maxX - minX + 110);
      const bh = Math.max(140, maxY - minY + 110);
      this.scale = Math.max(0.22, Math.min(1.55, Math.min((this.w - 36) / bw, (this.h - 36) / bh)));
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      this.tx = this.w / 2 - cx * this.scale;
      this.ty = this.h / 2 - cy * this.scale;
      this.draw();
    }

    fitToView() {
      this._fitNodes(this.nodes);
    }

    zoomBy(factor) {
      this._zoomAt((this.w || 400) / 2, (this.h || 300) / 2, factor);
    }

    centerOnNode(nodeOrId) {
      const n = typeof nodeOrId === 'string' ? this.nodeMap.get(nodeOrId) : nodeOrId;
      if (!n || !this.w || !this.h) return;
      this.scale = Math.max(this.scale, 1.15);
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
        if (e.source === node) outgoing.push({ node: e.target, type: e.type, label: e.label });
        else if (e.target === node) incoming.push({ node: e.source, type: e.type, label: e.label });
      }
      return { incoming, outgoing };
    }

    _screenToWorld(sx, sy) {
      return { x: (sx - this.tx) / this.scale, y: (sy - this.ty) / this.scale };
    }

    _zoomAt(sx, sy, factor) {
      const prev = this.scale;
      const next = Math.max(0.18, Math.min(3.8, prev * factor));
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
        this._zoomAt(p.x, p.y, e.deltaY < 0 ? 1.14 : 1 / 1.14);
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
          this.reheat(0.3);
        } else {
          this.panning = true;
        }
      });

      window.addEventListener('mousemove', (e) => {
        if (!this.canvas.isConnected) return;
        const p = getPos(e);
        this.pointerScreen = p;
        if (this.draggingNode) {
          if (Math.abs(p.x - this.lastMouse.x) + Math.abs(p.y - this.lastMouse.y) > 2) this.dragMoved = true;
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
        const rect = this.canvas.getBoundingClientRect();
        if (e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom) {
          const hit = this._hitTest(p.x, p.y);
          if (hit !== this.hovered || hit) {
            this.hovered = hit;
            this.canvas.style.cursor = hit ? 'pointer' : 'grab';
            this.draw();
          }
        } else if (this.hovered) {
          this.hovered = null;
          this.draw();
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
      const repulse = n > 160 ? 1550 : 2400;
      const damp = 0.80;

      // Cluster gravity + pairwise repulsion + hard collision separation
      for (let i = 0; i < n; i++) {
        const a = nodes[i];
        const cl = this.clusterMap.get(a._cluster);
        if (cl) {
          a.vx += (cl.cx - a.x) * 0.045 * alpha;
          a.vy += (cl.cy - a.y) * 0.045 * alpha;
        } else {
          a.vx += -a.x * 0.015 * alpha;
          a.vy += -a.y * 0.015 * alpha;
        }

        for (let j = i + 1; j < n; j++) {
          const b = nodes[j];
          let dx = a.x - b.x;
          let dy = a.y - b.y;
          let d2 = dx * dx + dy * dy;
          if (d2 > 180000) continue;
          if (d2 < 2) { dx = (Math.random() - 0.5) * 4; dy = (Math.random() - 0.5) * 4; d2 = 16; }
          const dist = Math.sqrt(d2);
          const nx = dx / dist;
          const ny = dy / dist;

          // Repulsion
          const sameCluster = a._cluster === b._cluster;
          const f = ((sameCluster ? repulse * 0.85 : repulse * 1.3) * alpha) / d2;
          a.vx += nx * f; a.vy += ny * f;
          b.vx -= nx * f; b.vy -= ny * f;

          // Anti-overlap collision separation
          const minSep = a.r + b.r + 22;
          if (dist < minSep) {
            const push = (minSep - dist) * 0.36;
            a.vx += nx * push; a.vy += ny * push;
            b.vx -= nx * push; b.vy -= ny * push;
          }
        }
      }

      // Edge springs
      for (const e of edges) {
        const a = e.source;
        const b = e.target;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const targetLen = e.type === 'contains' ? 70 : e.type === 'depends_on' ? 115 : 95;
        const k = (e.type === 'imports' || e.type === 'links_to' || e.type === 'semantic') ? 0.07 : 0.032;
        const f = (dist - targetLen) * k * alpha;
        const fx = (dx / dist) * f;
        const fy = (dy / dist) * f;
        a.vx += fx; a.vy += fy;
        b.vx -= fx; b.vy -= fy;
      }

      for (const nd of nodes) {
        if (nd.fx != null && nd.fy != null) {
          nd.x = nd.fx; nd.y = nd.fy; nd.vx = 0; nd.vy = 0;
          continue;
        }
        nd.vx *= damp;
        nd.vy *= damp;
        nd.x += Math.max(-20, Math.min(20, nd.vx));
        nd.y += Math.max(-20, Math.min(20, nd.vy));
      }

      this.alpha *= 0.96;
    }

    _startLoop() {
      if (this.rafId) return;
      const tick = () => {
        if (this.paused || this.alpha < 0.014) {
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

    _drawHexagon(ctx, x, y, r) {
      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = (Math.PI / 3) * i - Math.PI / 6;
        const px = x + r * Math.cos(a);
        const py = y + r * Math.sin(a);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
    }

    _drawClusterZones(ctx, dark) {
      if (this.layoutMode !== 'force' || this.clusterMap.size < 2) return;
      const groups = new Map();
      for (const n of this.nodes) {
        if (!groups.has(n._cluster)) groups.set(n._cluster, []);
        groups.get(n._cluster).push(n);
      }

      for (const [cname, members] of groups.entries()) {
        if (members.length < 2) continue;
        const cl = this.clusterMap.get(cname);
        const color = cl?.color || '#85786c';
        let cx = 0, cy = 0;
        for (const m of members) { cx += m.x; cy += m.y; }
        cx /= members.length; cy /= members.length;
        let maxR = 40;
        for (const m of members) {
          const d = Math.hypot(m.x - cx, m.y - cy) + m.r + 22;
          if (d > maxR) maxR = d;
        }
        maxR = Math.min(maxR, 260);
        const focused = !this.activeCluster || this.activeCluster === cname;

        ctx.save();
        ctx.globalAlpha = focused ? (dark ? 0.10 : 0.075) : 0.025;
        ctx.beginPath();
        ctx.arc(cx, cy, maxR, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();

        ctx.globalAlpha = focused ? (dark ? 0.30 : 0.22) : 0.06;
        ctx.setLineDash([5, 5]);
        ctx.lineWidth = 1.1 / Math.sqrt(this.scale);
        ctx.strokeStyle = color;
        ctx.stroke();
        ctx.setLineDash([]);

        // Cluster Zone Heading
        ctx.globalAlpha = focused ? 0.72 : 0.18;
        ctx.font = `700 ${Math.max(10, Math.min(13, 11.5 / Math.pow(this.scale, 0.25)))}px Inter, system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillStyle = color;
        ctx.fillText(cname.toUpperCase(), cx, cy - maxR - 5);
        ctx.restore();
      }
    }

    _drawTooltip(ctx, dark) {
      const n = this.hovered;
      if (!n) return;
      const pad = 10;
      const maxW = Math.min(280, this.w - 24);
      const title = n.label || n.id;
      const sub = n.path || (n.kind === 'package' ? `Package ${n.version || ''}` : '');
      const role = n.aiRole || '';
      const meta = `${n.kind || 'file'}${n._cluster ? ' · ' + n._cluster : ''}${n.lines ? ' · ' + n.lines + ' lines' : ''} · ${n.inDegree || 0} in / ${n.outDegree || 0} out`;

      ctx.save();
      ctx.font = '600 12px Inter, system-ui, sans-serif';
      const wTitle = ctx.measureText(title).width;
      ctx.font = '11px Inter, system-ui, sans-serif';
      const wMeta = ctx.measureText(meta).width;
      const wRole = role ? Math.min(maxW - pad * 2, ctx.measureText(role).width) : 0;
      const boxW = Math.min(maxW, Math.max(160, wTitle, wMeta, wRole) + pad * 2);
      const boxH = pad * 2 + 16 + (sub ? 14 : 0) + (role ? 16 : 0) + 15;

      let bx = this.pointerScreen.x + 14;
      let by = this.pointerScreen.y + 14;
      if (bx + boxW > this.w - 8) bx = Math.max(8, this.pointerScreen.x - boxW - 14);
      if (by + boxH > this.h - 8) by = Math.max(8, this.pointerScreen.y - boxH - 14);

      ctx.fillStyle = dark ? 'rgba(31,30,29,0.96)' : 'rgba(255,255,255,0.97)';
      ctx.strokeStyle = dark ? '#4a4944' : '#d6d3c6';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(bx, by, boxW, boxH, 9);
      ctx.fill();
      ctx.stroke();

      let y = by + pad + 11;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.font = '600 12px Inter, system-ui, sans-serif';
      ctx.fillStyle = dark ? '#f4f3ec' : '#1f1e1d';
      ctx.fillText(title.slice(0, 34), bx + pad, y);
      y += 14;

      if (sub) {
        ctx.font = '10.5px ui-monospace, Menlo, monospace';
        ctx.fillStyle = dark ? '#93918a' : '#7d7b72';
        ctx.fillText(sub.length > 38 ? '…' + sub.slice(-37) : sub, bx + pad, y);
        y += 15;
      }

      if (role) {
        ctx.font = '500 11px Inter, system-ui, sans-serif';
        ctx.fillStyle = dark ? '#f0b49d' : '#8f3f22';
        ctx.fillText(role.length > 42 ? role.slice(0, 41) + '…' : role, bx + pad, y);
        y += 15;
      }

      ctx.font = '10.5px Inter, system-ui, sans-serif';
      ctx.fillStyle = dark ? '#93918a' : '#7d7b72';
      ctx.fillText(meta, bx + pad, y);
      ctx.restore();
    }

    draw() {
      if (!this.w || !this.h) return;
      const ctx = this.ctx;
      const dark = this._isDark();

      ctx.clearRect(0, 0, this.w, this.h);

      // Architectural dot grid background
      ctx.save();
      const gridStep = Math.max(22, 34 * this.scale);
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
          if (!this.showTreeEdges && e.type === 'contains') continue;
          if (e.source === focus) connected.add(e.target.id);
          else if (e.target === focus) connected.add(e.source.id);
        }
      }

      ctx.save();
      ctx.translate(this.tx, this.ty);
      ctx.scale(this.scale, this.scale);

      // 1. Soft Cluster Zone Backgrounds
      this._drawClusterZones(ctx, dark);

      // 2. Curved Edges
      for (const e of this.edges) {
        if (!this.showTreeEdges && e.type === 'contains') continue;
        const isFocusEdge = focus && (e.source === focus || e.target === focus);
        const isImport = e.type === 'imports' || e.type === 'links_to';
        const isAiLink = e.type === 'semantic';
        const clusterDim = this.activeCluster && e.source._cluster !== this.activeCluster && e.target._cluster !== this.activeCluster;

        const mx = (e.source.x + e.target.x) / 2;
        const my = (e.source.y + e.target.y) / 2;
        const dx = e.target.x - e.source.x;
        const dy = e.target.y - e.source.y;
        const dist = Math.hypot(dx, dy) || 1;
        const curveOffset = (isImport || isAiLink) ? Math.min(26, dist * 0.14) : 0;
        const cpx = mx - (dy / dist) * curveOffset;
        const cpy = my + (dx / dist) * curveOffset;

        ctx.beginPath();
        ctx.setLineDash(isAiLink ? [4, 3] : []);
        ctx.moveTo(e.source.x, e.source.y);
        if (curveOffset) ctx.quadraticCurveTo(cpx, cpy, e.target.x, e.target.y);
        else ctx.lineTo(e.target.x, e.target.y);

        if (isFocusEdge) {
          const isOut = e.source === focus;
          ctx.strokeStyle = isAiLink
            ? (dark ? '#a78bfa' : '#7c3aed')
            : isOut
              ? (dark ? '#e58a6c' : '#c96442')
              : (dark ? '#34d399' : '#059669');
          ctx.lineWidth = 2.0 / Math.sqrt(this.scale);
        } else if (focus || clusterDim) {
          ctx.strokeStyle = dark ? 'rgba(255,255,255,0.035)' : 'rgba(31,30,29,0.04)';
          ctx.lineWidth = 0.7;
        } else if (isAiLink) {
          ctx.strokeStyle = dark ? 'rgba(167,139,250,0.52)' : 'rgba(124,58,237,0.44)';
          ctx.lineWidth = 1.3;
        } else if (isImport) {
          ctx.strokeStyle = dark ? 'rgba(217,119,87,0.46)' : 'rgba(201,100,66,0.40)';
          ctx.lineWidth = 1.3;
        } else if (e.type === 'depends_on') {
          ctx.strokeStyle = dark ? 'rgba(129,140,248,0.28)' : 'rgba(91,103,202,0.24)';
          ctx.lineWidth = 0.9;
        } else {
          ctx.strokeStyle = dark ? 'rgba(255,255,255,0.09)' : 'rgba(31,30,29,0.09)';
          ctx.lineWidth = 0.8;
        }
        ctx.stroke();
        ctx.setLineDash([]);

        // Arrowhead along curve tangent
        if ((isImport || isAiLink || isFocusEdge) && !clusterDim && dist > e.target.r + 8) {
          const txDir = curveOffset ? (e.target.x - cpx) : dx;
          const tyDir = curveOffset ? (e.target.y - cpy) : dy;
          const tLen = Math.hypot(txDir, tyDir) || 1;
          const ax = e.target.x - (txDir / tLen) * (e.target.r + 3.5);
          const ay = e.target.y - (tyDir / tLen) * (e.target.r + 3.5);
          const ang = Math.atan2(tyDir, txDir);
          const al = isFocusEdge ? 7 : 5;
          ctx.beginPath();
          ctx.moveTo(ax, ay);
          ctx.lineTo(ax - al * Math.cos(ang - 0.42), ay - al * Math.sin(ang - 0.42));
          ctx.lineTo(ax - al * Math.cos(ang + 0.42), ay - al * Math.sin(ang + 0.42));
          ctx.closePath();
          ctx.fillStyle = ctx.strokeStyle;
          ctx.fill();
        }

        // Edge semantic label on hover/focus
        if (isFocusEdge && e.label) {
          const lx = 0.25 * e.source.x + 0.5 * cpx + 0.25 * e.target.x;
          const ly = 0.25 * e.source.y + 0.5 * cpy + 0.25 * e.target.y;
          ctx.font = '600 9.5px Inter, system-ui, sans-serif';
          const tw = ctx.measureText(e.label).width;
          ctx.fillStyle = dark ? 'rgba(38,38,36,0.92)' : 'rgba(250,249,245,0.92)';
          ctx.beginPath();
          ctx.roundRect(lx - tw / 2 - 4, ly - 7, tw + 8, 14, 4);
          ctx.fill();
          ctx.fillStyle = dark ? '#c4b5fd' : '#6d28d9';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(e.label, lx, ly);
        }
      }

      // 3. Nodes (with distinct shapes & hub rings)
      const showAllLabels = this.scale > 0.95 || this.nodes.length <= 36;
      const labelQueue = [];

      for (const n of this.nodes) {
        const searchMatch = this._matchesSearch(n);
        const dimByFocus = focus && !connected.has(n.id);
        const dimBySearch = this.searchQuery && !searchMatch;
        const dimByCluster = this.activeCluster && n._cluster !== this.activeCluster;
        const dimmed = dimByFocus || dimBySearch || dimByCluster;
        const color = KIND_COLORS[n.kind] || KIND_COLORS.file;

        ctx.globalAlpha = dimmed ? 0.14 : 1;

        // Hub outer ring or selection halo
        if (n === this.selected || (this.searchQuery && searchMatch)) {
          ctx.beginPath();
          ctx.arc(n.x, n.y, n.r + 5, 0, Math.PI * 2);
          ctx.fillStyle = dark ? 'rgba(217,119,87,0.32)' : 'rgba(201,100,66,0.24)';
          ctx.fill();
        } else if (n.hubScore >= 6 && !dimmed) {
          ctx.beginPath();
          ctx.arc(n.x, n.y, n.r + 2.8, 0, Math.PI * 2);
          ctx.strokeStyle = color;
          ctx.globalAlpha = 0.35;
          ctx.lineWidth = 1.4;
          ctx.stroke();
          ctx.globalAlpha = 1;
        }

        if (n.kind === 'folder') {
          ctx.beginPath();
          ctx.roundRect(n.x - n.r, n.y - n.r * 0.78, n.r * 2, n.r * 1.56, 4);
        } else if (n.kind === 'package') {
          this._drawHexagon(ctx, n.x, n.y, n.r);
        } else {
          ctx.beginPath();
          ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
        }
        ctx.fillStyle = color;
        ctx.fill();
        ctx.lineWidth = n === focus ? 2.2 : 1.2;
        ctx.strokeStyle = dark ? '#262624' : '#faf9f5';
        ctx.stroke();

        const shouldLabel = showAllLabels || n === focus || n.isRoot || n.r >= 10 || (this.searchQuery && searchMatch) || (focus && connected.has(n.id));
        if (shouldLabel && !dimmed) {
          labelQueue.push(n);
        }
      }

      // 4. Clean Non-Clashing Pill Labels (drawn on top of all nodes/edges)
      ctx.globalAlpha = 1;
      for (const n of labelQueue) {
        const isHot = n === focus || n === this.selected || n.isRoot;
        const fontSize = Math.max(9.5, Math.min(12.5, (isHot ? 11.5 : 10.5) / Math.pow(this.scale, 0.22)));
        ctx.font = `${isHot ? '600 ' : '500 '}${fontSize}px Inter, system-ui, sans-serif`;
        const lbl = n.label.length > 26 ? n.label.slice(0, 24) + '…' : n.label;
        const tw = ctx.measureText(lbl).width;
        const ly = n.y + n.r + 5;

        ctx.fillStyle = dark ? 'rgba(38,38,36,0.84)' : 'rgba(250,249,245,0.88)';
        ctx.beginPath();
        ctx.roundRect(n.x - tw / 2 - 4, ly - 1, tw + 8, fontSize + 4, 4);
        ctx.fill();

        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillStyle = dark ? '#f4f3ec' : '#1f1e1d';
        ctx.fillText(lbl, n.x, ly + 1);
      }

      ctx.restore();

      // 5. Screen-space floating Hover Tooltip (with Fast-Model AI Role)
      this._drawTooltip(ctx, dark);
    }
  }

  window.KnowledgeGraphView = KnowledgeGraphView;
  window.GRAPH_KIND_COLORS = KIND_COLORS;
})();
