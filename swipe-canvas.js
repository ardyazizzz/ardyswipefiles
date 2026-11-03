/* Swipe Ardy Canvas — a read-only pan/zoom board of image thumbnails grouped into sections.
 *
 * The board never edits data. Its only persistent state is per-viewer UI preference
 * (section positions and the last viewport for each "group by" category), kept in
 * localStorage under `swipeardy_canvas_v1`.
 *
 * Inside a section the thumbnails sit on a fixed grid, so their positions are pure
 * arithmetic. That lets the board mount only the cells near the viewport and keep
 * the DOM bounded no matter how many images the library holds.
 */
(function () {
  'use strict';

  const CELL_W = 132;
  const CELL_H = 165;
  const GAP = 8;
  const PAD = 14;
  const HEAD = 46;
  const SECTION_GAP = 56;
  const MIN_SECTION_GAP = 16;
  const MIN_SECTION_W = 232;
  const SNAP = 8;
  const MIN_SCALE = 0.08;
  const MAX_SCALE = 4;
  const MAX_MOUNTED = 900;
  const CULL_MARGIN = 360;
  // Below this zoom the in-frame title is too small to read or grab, so a screen-sized
  // label (also a drag handle) is shown at each section's corner instead.
  const LABEL_SCALE = 0.6;
  const STORE_KEY = 'swipeardy_canvas_v1';
  const MORE_KEY = '\u0000more';

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  function readStore() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch (_) { return {}; }
  }
  function writeStore(store) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch (_) {}
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function columnsFor(count) {
    if (count <= 2) return Math.max(1, count);
    // Aim for sections that read as tall columns, like frames on a design board.
    return clamp(Math.ceil(Math.sqrt(count * CELL_H / CELL_W / 1.8)), 2, 16);
  }

  function overlaps(a, b, margin) {
    return a.x < b.x + b.w + margin && a.x + a.w + margin > b.x &&
      a.y < b.y + b.h + margin && a.y + a.h + margin > b.y;
  }

  class SwipeCanvas {
    constructor(host, options) {
      this.host = host;
      this.options = options || {};
      this.sections = [];
      this.byName = new Map();
      this.frames = new Map();
      this.cells = new Map();
      this.view = { x: 0, y: 0, s: 1 };
      this.groupKey = null;
      this.frame = 0;
      this.saveTimer = 0;
      this.pointers = new Map();
      this.gesture = null;

      host.classList.add('sc-host');
      host.tabIndex = 0;
      this.viewport = el('div', 'sc-viewport');
      this.world = el('div', 'sc-world');
      this.labels = el('div', 'sc-labels');
      this.viewport.append(this.world, this.labels);
      this.empty = el('div', 'sc-empty');
      this.empty.innerHTML = '<i class="ri-image-line" aria-hidden="true"></i><p>No images match these filters</p><small>Only posts with an image appear on the canvas.</small>';
      this.toolbar = this.buildToolbar();
      this.hint = el('div', 'sc-hint', 'Drag to pan · Ctrl/⌘ + scroll to zoom · Drag a section title to move it');
      host.replaceChildren(this.viewport, this.empty, this.toolbar, this.hint);

      this.viewport.addEventListener('pointerdown', e => this.onPointerDown(e));
      this.viewport.addEventListener('pointermove', e => this.onPointerMove(e));
      this.viewport.addEventListener('pointerup', e => this.onPointerUp(e));
      this.viewport.addEventListener('pointercancel', e => this.onPointerUp(e, true));
      this.viewport.addEventListener('wheel', e => this.onWheel(e), { passive: false });
      this.viewport.addEventListener('dragstart', e => e.preventDefault());
      host.addEventListener('keydown', e => this.onKey(e));
      this.resizeObserver = new ResizeObserver(() => this.schedule());
      this.resizeObserver.observe(this.viewport);
    }

    buildToolbar() {
      const bar = el('div', 'sc-toolbar');
      const button = (icon, title, fn) => {
        const b = el('button', 'sc-tool');
        b.type = 'button';
        b.title = title;
        b.setAttribute('aria-label', title);
        b.innerHTML = '<i class="' + icon + '" aria-hidden="true"></i>';
        b.addEventListener('click', fn);
        return b;
      };
      this.zoomLabel = el('button', 'sc-tool sc-zoom-label', '100%');
      this.zoomLabel.type = 'button';
      this.zoomLabel.title = 'Zoom to 100%';
      this.zoomLabel.addEventListener('click', () => this.zoomTo(1));
      bar.append(
        button('ri-subtract-line', 'Zoom out', () => this.zoomBy(1 / 1.25)),
        this.zoomLabel,
        button('ri-add-line', 'Zoom in', () => this.zoomBy(1.25)),
        el('span', 'sc-tool-sep'),
        button('ri-fullscreen-line', 'Fit all sections', () => this.fit()),
        button('ri-layout-column-line', 'Reset section positions', () => this.resetLayout())
      );
      return bar;
    }

    /* ---------- data & layout ---------- */

    setData(groupKey, sections) {
      const groupChanged = groupKey !== this.groupKey;
      if (groupChanged) {
        this.clearAll();
        this.groupKey = groupKey;
      }
      this.sections = sections.map(section => {
        // A section limited by the host ends with a "+N more" tile that expands it.
        const total = Math.max(section.total || 0, section.items.length);
        const hidden = total - section.items.length;
        const items = hidden > 0 ? section.items.concat([{ key: MORE_KEY, more: hidden, src: 'more:' + hidden }]) : section.items;
        const count = items.length;
        const cols = columnsFor(count);
        const rows = Math.ceil(count / cols);
        return {
          name: section.name, label: section.label, color: section.color, items,
          shown: section.items.length, total,
          cols, rows,
          w: Math.max(MIN_SECTION_W, PAD * 2 + cols * CELL_W + (cols - 1) * GAP),
          h: HEAD + PAD + rows * CELL_H + Math.max(0, rows - 1) * GAP,
          x: 0, y: 0,
          index: new Map(items.map((item, i) => [item.key, i]))
        };
      });
      this.byName = new Map(this.sections.map(s => [s.name, s]));
      this.place();
      this.syncFrames();
      this.empty.style.display = this.sections.length ? 'none' : 'flex';

      if (groupChanged) {
        const saved = (readStore()[groupKey] || {}).view;
        if (saved && Number.isFinite(saved.s)) this.view = { x: saved.x, y: saved.y, s: clamp(saved.s, MIN_SCALE, MAX_SCALE) };
        else this.initialView();
      }
      this.applyTransform();
      this.schedule();
    }

    positionsStore() {
      const store = readStore();
      return (store[this.groupKey] && store[this.groupKey].positions) || {};
    }

    /* Saved positions are preferences: a section is pushed right until it no longer
       touches an already-placed one, so sections can never overlap. */
    place() {
      const saved = this.positionsStore();
      const placed = [];
      const resolve = section => {
        for (let guard = 0; guard < 1000; guard++) {
          const hit = placed.find(p => overlaps(p, section, MIN_SECTION_GAP));
          if (!hit) break;
          section.x = hit.x + hit.w + SECTION_GAP;
        }
        placed.push(section);
      };
      this.sections.filter(s => saved[s.name]).forEach(s => { s.x = saved[s.name].x; s.y = saved[s.name].y; resolve(s); });
      let cursor = 0;
      this.sections.filter(s => !saved[s.name]).forEach(s => {
        s.x = cursor; s.y = 0;
        resolve(s);
        cursor = s.x + s.w + SECTION_GAP;
      });
    }

    syncFrames() {
      const live = new Set(this.sections.map(s => s.name));
      this.frames.forEach((frame, name) => {
        if (live.has(name)) return;
        frame.root.remove();
        frame.chip.remove();
        this.frames.delete(name);
      });
      this.cells.forEach((cell, key) => {
        const section = this.byName.get(cell.section);
        if (!section || !section.index.has(cell.itemKey)) this.unmount(key);
      });
      this.sections.forEach(section => {
        let frame = this.frames.get(section.name);
        if (!frame) {
          const root = el('section', 'sc-section');
          root.dataset.section = section.name;
          const head = el('div', 'sc-head');
          head.dataset.section = section.name;
          const dot = el('span', 'sc-dot');
          const label = el('span', 'sc-label');
          const count = el('span', 'sc-count');
          head.append(dot, label, count);
          const body = el('div', 'sc-body');
          root.append(head, body);
          this.world.append(root);
          const chip = el('div', 'sc-chip');
          chip.dataset.section = section.name;
          const chipDot = el('span', 'sc-dot');
          const chipLabel = el('span', 'sc-label');
          const chipCount = el('span', 'sc-count');
          chip.append(chipDot, chipLabel, chipCount);
          this.labels.append(chip);
          frame = { root, head, dot, label, count, body, chip, chipDot, chipLabel, chipCount };
          this.frames.set(section.name, frame);
        }
        frame.label.textContent = section.label;
        const countText = section.shown < section.total ? section.shown + ' of ' + section.total : String(section.total);
        frame.count.textContent = countText;
        frame.dot.style.background = frame.chipDot.style.background = section.color || 'var(--text-tertiary)';
        frame.chipLabel.textContent = section.label;
        frame.chipCount.textContent = countText;
        frame.chip.title = section.label + ' · ' + countText + ' — drag to move this section';
        frame.root.style.left = section.x + 'px';
        frame.root.style.top = section.y + 'px';
        frame.root.style.width = section.w + 'px';
        frame.root.style.height = section.h + 'px';
      });
    }

    bounds() {
      if (!this.sections.length) return { x: 0, y: 0, w: 1, h: 1 };
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      this.sections.forEach(s => {
        x0 = Math.min(x0, s.x); y0 = Math.min(y0, s.y);
        x1 = Math.max(x1, s.x + s.w); y1 = Math.max(y1, s.y + s.h);
      });
      return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }

    /* ---------- viewport ---------- */

    size() {
      return { w: this.viewport.clientWidth || 1, h: this.viewport.clientHeight || 1 };
    }

    initialView() {
      const b = this.bounds();
      const { w, h } = this.size();
      const fitScale = Math.min((w - 64) / b.w, (h - 64) / b.h, 1);
      if (fitScale >= 0.35) { this.fit(true); return; }
      // Large boards start readable and anchored top-left rather than microscopic.
      const s = clamp(Math.min((h - 64) / b.h, 1), 0.35, 1);
      this.view = { s, x: 32 - b.x * s, y: 32 - b.y * s };
    }

    fit(silent) {
      const b = this.bounds();
      const { w, h } = this.size();
      const s = clamp(Math.min((w - 64) / b.w, (h - 64) / b.h, 1), MIN_SCALE, MAX_SCALE);
      this.view = { s, x: (w - b.w * s) / 2 - b.x * s, y: Math.max(24, (h - b.h * s) / 2) - b.y * s };
      if (!silent) { this.applyTransform(); this.schedule(); this.saveView(); }
    }

    zoomAt(px, py, factor) {
      const s = clamp(this.view.s * factor, MIN_SCALE, MAX_SCALE);
      const wx = (px - this.view.x) / this.view.s;
      const wy = (py - this.view.y) / this.view.s;
      this.view = { s, x: px - wx * s, y: py - wy * s };
      this.applyTransform();
      this.schedule();
      this.saveView();
    }

    zoomBy(factor) {
      const { w, h } = this.size();
      this.zoomAt(w / 2, h / 2, factor);
    }

    zoomTo(scale) {
      this.zoomBy(scale / this.view.s);
    }

    panBy(dx, dy) {
      this.view.x += dx;
      this.view.y += dy;
      this.applyTransform();
      this.schedule();
      this.saveView();
    }

    applyTransform() {
      const { x, y, s } = this.view;
      this.world.style.transform = 'translate(' + x + 'px,' + y + 'px) scale(' + s + ')';
      let step = 24 * s;
      while (step < 14) step *= 2;
      this.viewport.style.backgroundSize = step + 'px ' + step + 'px';
      this.viewport.style.backgroundPosition = x + 'px ' + y + 'px';
      this.zoomLabel.textContent = Math.round(s * 100) + '%';
      this.host.classList.toggle('sc-small', s < LABEL_SCALE);
      this.frames.forEach((frame, name) => this.positionChip(frame, this.byName.get(name)));
    }

    positionChip(frame, section) {
      if (!frame || !section) return;
      const { x, y, s } = this.view;
      frame.chip.style.transform = 'translate(' + (x + section.x * s + 6) + 'px,' + (y + section.y * s + 6) + 'px)';
      frame.chip.style.maxWidth = Math.max(56, (section.w + SECTION_GAP) * s - 16) + 'px';
    }

    saveView() {
      clearTimeout(this.saveTimer);
      this.saveTimer = setTimeout(() => {
        if (!this.groupKey) return;
        const store = readStore();
        store[this.groupKey] = Object.assign({}, store[this.groupKey], { view: this.view });
        writeStore(store);
      }, 300);
    }

    resetLayout() {
      const store = readStore();
      if (store[this.groupKey]) delete store[this.groupKey].positions;
      writeStore(store);
      this.place();
      this.syncFrames();
      this.fit();
    }

    /* ---------- culling ---------- */

    schedule() {
      if (this.frame) return;
      this.frame = requestAnimationFrame(() => { this.frame = 0; this.cull(); });
    }

    cull() {
      if (!this.host.isConnected || this.host.hidden) return;
      const { w, h } = this.size();
      const { x, y, s } = this.view;
      const wx0 = (-x - CULL_MARGIN) / s, wy0 = (-y - CULL_MARGIN) / s;
      const wx1 = (w - x + CULL_MARGIN) / s, wy1 = (h - y + CULL_MARGIN) / s;
      const cx = (w / 2 - x) / s, cy = (h / 2 - y) / s;
      const stepX = CELL_W + GAP, stepY = CELL_H + GAP;
      const wanted = [];
      this.sections.forEach(section => {
        if (section.x > wx1 || section.x + section.w < wx0 || section.y > wy1 || section.y + section.h < wy0) return;
        const bx = section.x + PAD, by = section.y + HEAD;
        const r0 = clamp(Math.floor((wy0 - by) / stepY), 0, section.rows - 1);
        const r1 = clamp(Math.floor((wy1 - by) / stepY), 0, section.rows - 1);
        const c0 = clamp(Math.floor((wx0 - bx) / stepX), 0, section.cols - 1);
        const c1 = clamp(Math.floor((wx1 - bx) / stepX), 0, section.cols - 1);
        for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
          const i = r * section.cols + c;
          if (i >= section.items.length) continue;
          const px = bx + c * stepX + CELL_W / 2, py = by + r * stepY + CELL_H / 2;
          wanted.push({ section, i, d: (px - cx) * (px - cx) + (py - cy) * (py - cy) });
        }
      });
      // At very low zoom the whole library can be in view; mount the cells nearest
      // the centre first and keep the DOM (and image downloads) bounded.
      if (wanted.length > MAX_MOUNTED) wanted.sort((a, b) => a.d - b.d).length = MAX_MOUNTED;
      const keep = new Set();
      wanted.forEach(({ section, i }) => {
        const item = section.items[i];
        const key = section.name + '\u0000' + item.key;
        keep.add(key);
        let cell = this.cells.get(key);
        if (!cell) cell = this.mount(key, section, item);
        else if (cell.src !== item.src) { this.unmount(key); cell = this.mount(key, section, item); }
        const left = PAD + (i % section.cols) * stepX;
        const top = HEAD + Math.floor(i / section.cols) * stepY;
        if (cell.left !== left || cell.top !== top) {
          cell.left = left; cell.top = top;
          cell.node.style.transform = 'translate(' + left + 'px,' + top + 'px)';
        }
      });
      this.cells.forEach((cell, key) => { if (!keep.has(key)) this.unmount(key); });
    }

    mount(key, section, item) {
      if (item.more) return this.mountMore(key, section, item);
      const node = el('div', 'sc-cell');
      node.dataset.key = key;
      node.title = item.title || '';
      const wrap = el('div', 'img-wrap sc-thumb');
      const img = document.createElement('img');
      img.className = 'card-img';
      img.alt = item.title || '';
      img.decoding = 'async';
      img.draggable = false;
      img.dataset.previewSrc = item.src;
      wrap.append(img);
      node.append(wrap);
      if (item.images && item.images.length > 1) {
        const badge = el('span', 'sc-badge');
        badge.innerHTML = '<i class="ri-stack-line" aria-hidden="true"></i>';
        badge.append(String(item.images.length));
        node.append(badge);
      }
      const frame = this.frames.get(section.name);
      frame.body.append(node);
      const cell = { node, src: item.src, section: section.name, itemKey: item.key, left: null, top: null };
      this.cells.set(key, cell);
      if (window.SwipePreview) {
        img.addEventListener('load', () => window.SwipePreview.loaded(img));
        img.addEventListener('error', () => window.SwipePreview.error(img));
        window.SwipePreview.load(img);
      } else {
        img.src = item.src;
      }
      return cell;
    }

    mountMore(key, section, item) {
      const node = el('div', 'sc-cell sc-more');
      node.dataset.key = key;
      node.title = 'Show all ' + section.total + ' images in ' + section.label;
      node.append(el('strong', '', '+' + item.more), el('span', '', 'Show all'));
      this.frames.get(section.name).body.append(node);
      const cell = { node, src: item.src, section: section.name, itemKey: item.key, left: null, top: null };
      this.cells.set(key, cell);
      return cell;
    }

    unmount(key) {
      const cell = this.cells.get(key);
      if (!cell) return;
      if (window.SwipePreview) window.SwipePreview.release(cell.node);
      cell.node.remove();
      this.cells.delete(key);
    }

    clearAll() {
      Array.from(this.cells.keys()).forEach(key => this.unmount(key));
      this.frames.forEach(frame => { frame.root.remove(); frame.chip.remove(); });
      this.frames.clear();
    }

    /** Release every mounted image while the canvas is hidden. */
    suspend() {
      Array.from(this.cells.keys()).forEach(key => this.unmount(key));
    }

    itemFor(cellNode) {
      const cell = cellNode && this.cells.get(cellNode.dataset.key);
      if (!cell) return null;
      const section = this.byName.get(cell.section);
      const index = section && section.index.get(cell.itemKey);
      return index === undefined ? null : { item: section.items[index], section: section.name };
    }

    activate(cellNode) {
      const hit = this.itemFor(cellNode);
      if (!hit) return;
      if (hit.item.more) { if (this.options.onExpand) this.options.onExpand(hit.section); }
      else if (this.options.onOpen) this.options.onOpen(hit.item);
    }

    /* ---------- input ---------- */

    localPoint(e) {
      const rect = this.viewport.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }

    onPointerDown(e) {
      if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 1) return;
      this.host.focus({ preventScroll: true });
      try { this.viewport.setPointerCapture(e.pointerId); } catch (_) { /* synthetic or already-ended pointer */ }
      this.pointers.set(e.pointerId, this.localPoint(e));
      if (this.pointers.size === 2) {
        const [a, b] = Array.from(this.pointers.values());
        if (this.gesture && this.gesture.type === 'section') this.cancelSectionDrag();
        this.gesture = { type: 'pinch', dist: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
        return;
      }
      if (this.pointers.size > 2) return;
      const handle = e.button === 0 && e.target.closest('.sc-head, .sc-chip');
      const start = this.localPoint(e);
      if (handle) {
        const name = handle.dataset.section;
        const section = this.byName.get(name);
        if (!section) return;
        this.gesture = { type: 'section', section, start, origin: { x: section.x, y: section.y }, moved: false };
        this.frames.get(name).root.classList.add('sc-dragging');
      } else {
        this.gesture = { type: 'pan', start, last: start, moved: false, target: e.target.closest('.sc-cell') };
        this.viewport.classList.add('sc-panning');
      }
    }

    onPointerMove(e) {
      if (!this.pointers.has(e.pointerId) || !this.gesture) return;
      const p = this.localPoint(e);
      this.pointers.set(e.pointerId, p);
      const g = this.gesture;
      if (g.type === 'pinch') {
        if (this.pointers.size < 2) return;
        const [a, b] = Array.from(this.pointers.values());
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        this.view.x += mid.x - g.mid.x;
        this.view.y += mid.y - g.mid.y;
        if (g.dist > 0) this.zoomAt(mid.x, mid.y, dist / g.dist);
        else { this.applyTransform(); this.schedule(); }
        g.dist = dist; g.mid = mid;
        return;
      }
      if (!g.moved && Math.hypot(p.x - g.start.x, p.y - g.start.y) > 4) g.moved = true;
      if (!g.moved) return;
      if (g.type === 'pan') {
        this.panBy(p.x - g.last.x, p.y - g.last.y);
        g.last = p;
      } else if (g.type === 'section') {
        const s = this.view.s;
        g.section.x = Math.round((g.origin.x + (p.x - g.start.x) / s) / SNAP) * SNAP;
        g.section.y = Math.round((g.origin.y + (p.y - g.start.y) / s) / SNAP) * SNAP;
        const root = this.frames.get(g.section.name).root;
        root.style.left = g.section.x + 'px';
        root.style.top = g.section.y + 'px';
        this.positionChip(this.frames.get(g.section.name), g.section);
        const blocked = this.sections.some(o => o !== g.section && overlaps(o, g.section, MIN_SECTION_GAP));
        root.classList.toggle('sc-blocked', blocked);
      }
    }

    onPointerUp(e, cancelled) {
      if (!this.pointers.has(e.pointerId)) return;
      this.pointers.delete(e.pointerId);
      const g = this.gesture;
      if (!g) return;
      if (g.type === 'pinch') {
        if (this.pointers.size === 0) this.gesture = null;
        else {
          // One finger remains: continue as a pan without a click at the end.
          const last = Array.from(this.pointers.values())[0];
          this.gesture = { type: 'pan', start: last, last, moved: true, target: null };
        }
        return;
      }
      this.gesture = null;
      this.viewport.classList.remove('sc-panning');
      if (g.type === 'pan') {
        if (!cancelled && !g.moved && g.target) this.activate(g.target);
        return;
      }
      const root = this.frames.get(g.section.name).root;
      root.classList.remove('sc-dragging', 'sc-blocked');
      if (!g.moved) return;
      const blocked = cancelled || this.sections.some(o => o !== g.section && overlaps(o, g.section, MIN_SECTION_GAP));
      if (blocked) {
        this.cancelSectionDrag(g);
        return;
      }
      // Snapshot every visible section so moving one never reshuffles the others.
      const store = readStore();
      const entry = store[this.groupKey] = Object.assign({}, store[this.groupKey]);
      entry.positions = Object.assign({}, entry.positions);
      this.sections.forEach(s => { entry.positions[s.name] = { x: s.x, y: s.y }; });
      writeStore(store);
      this.schedule();
    }

    cancelSectionDrag(g) {
      g = g || this.gesture;
      if (!g || g.type !== 'section') return;
      g.section.x = g.origin.x;
      g.section.y = g.origin.y;
      const root = this.frames.get(g.section.name).root;
      root.classList.remove('sc-dragging', 'sc-blocked');
      root.classList.add('sc-revert');
      root.style.left = g.section.x + 'px';
      root.style.top = g.section.y + 'px';
      this.positionChip(this.frames.get(g.section.name), g.section);
      setTimeout(() => root.classList.remove('sc-revert'), 260);
      if (this.gesture === g) this.gesture = null;
    }

    onWheel(e) {
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.size().h : 1;
      let dx = e.deltaX * unit, dy = e.deltaY * unit;
      if (e.ctrlKey || e.metaKey) {
        const p = this.localPoint(e);
        this.zoomAt(p.x, p.y, Math.exp(-clamp(dy, -60, 60) * 0.006));
        return;
      }
      if (e.shiftKey && !dx) { dx = dy; dy = 0; }
      this.panBy(-dx, -dy);
    }

    onKey(e) {
      if (e.target !== this.host || e.ctrlKey || e.metaKey || e.altKey) return;
      if (this.options.keysEnabled && !this.options.keysEnabled()) return;
      const step = 80;
      const keys = {
        '+': () => this.zoomBy(1.25), '=': () => this.zoomBy(1.25), '-': () => this.zoomBy(1 / 1.25),
        '0': () => this.zoomTo(1), '!': () => this.fit(),
        ArrowLeft: () => this.panBy(step, 0), ArrowRight: () => this.panBy(-step, 0),
        ArrowUp: () => this.panBy(0, step), ArrowDown: () => this.panBy(0, -step)
      };
      const fn = keys[e.key];
      if (!fn) return;
      e.preventDefault();
      fn();
    }
  }

  window.SwipeCanvas = SwipeCanvas;
})();
