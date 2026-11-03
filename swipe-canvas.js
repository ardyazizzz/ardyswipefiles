/* Swipe Ardy Canvas — a read-only pan/zoom board of image thumbnails grouped into sections.
 *
 * Rendering follows the approach design tools use for smooth boards:
 *  - Everything is painted on ONE <canvas>; there is no per-thumbnail DOM, so panning and
 *    zooming never trigger layout, style recalculation or element churn.
 *  - Each image is decoded once and downscaled into small cached bitmaps at a few fixed
 *    resolutions ("mip levels"). A frame only blits those small bitmaps, picking the level
 *    that matches the current zoom and falling back to any cached level while a sharper
 *    one loads.
 *  - Input only updates the viewport and requests a frame; drawing happens at most once
 *    per animation frame. Image loads are prioritised by distance from the viewport centre.
 *
 * The board never edits data. Its only persistent state is per-viewer UI preference
 * (section positions and the last viewport for each "group by" category), kept in
 * localStorage under `swipeardy_canvas_v1`.
 */
(function () {
  'use strict';

  const CELL_W = 132;
  const CELL_H = 165;
  const GAP = 8;
  const PAD = 12;
  const HEAD = 36;
  const SECTION_GAP = 56;
  const MIN_SECTION_GAP = 16;
  const MIN_SECTION_W = 120;
  const SNAP = 8;
  const MIN_SCALE = 0.05;
  const MAX_SCALE = 4;
  const PREFETCH = 240;                 // screen px around the viewport to preload
  const LEVELS = [48, 112, 240, 480];   // cached thumbnail widths in device pixels
  const MAX_INFLIGHT = 8;
  const CACHE_BYTES = 192 * 1024 * 1024;
  const SUSPENDED_CACHE_BYTES = 48 * 1024 * 1024;
  const STORE_KEY = 'swipeardy_canvas_v1';
  const MORE_KEY = '\u0000more';

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const mod = (a, n) => ((a % n) + n) % n;

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

  /* ---------- shared thumbnail cache (survives regrouping and re-renders) ---------- */

  const thumbs = new Map();   // `${level}|${url}` -> { src, w, h, bytes }  (Map order = LRU)
  let thumbBytes = 0;
  const failures = new Map(); // url -> failed attempts
  const inflight = new Set(); // `${level}|${url}`

  function thumbKey(level, url) { return level + '|' + url; }

  function storeThumb(key, entry) {
    const prior = thumbs.get(key);
    if (prior) { thumbBytes -= prior.bytes; releaseThumb(prior); thumbs.delete(key); }
    thumbs.set(key, entry);
    thumbBytes += entry.bytes;
    trimThumbs(CACHE_BYTES);
  }

  function releaseThumb(entry) {
    if (entry.src && typeof entry.src.close === 'function') entry.src.close();
  }

  function trimThumbs(limit) {
    while (thumbBytes > limit && thumbs.size) {
      const [key, oldest] = thumbs.entries().next().value;
      thumbs.delete(key);
      thumbBytes -= oldest.bytes;
      releaseThumb(oldest);
    }
  }

  /** The exact level if cached, else the closest cached level (sharper preferred). */
  function bestThumb(url, levelIndex) {
    const exact = thumbs.get(thumbKey(LEVELS[levelIndex], url));
    if (exact) return { entry: exact, exact: true };
    for (let i = levelIndex + 1; i < LEVELS.length; i++) {
      const e = thumbs.get(thumbKey(LEVELS[i], url));
      if (e) return { entry: e, exact: true }; // sharper than needed is fine
    }
    for (let i = levelIndex - 1; i >= 0; i--) {
      const e = thumbs.get(thumbKey(LEVELS[i], url));
      if (e) return { entry: e, exact: false };
    }
    return null;
  }

  async function downscale(img, width) {
    const nw = img.naturalWidth, nh = img.naturalHeight;
    if (!nw || !nh) throw new Error('empty image');
    const w = Math.max(1, Math.min(width, nw));
    const h = Math.max(1, Math.round(w * nh / nw));
    if (typeof createImageBitmap === 'function') {
      try {
        // Off-main-thread resize where supported; cross-origin images are allowed
        // (the board never reads pixels back).
        const bmp = await createImageBitmap(img, { resizeWidth: w, resizeHeight: h, resizeQuality: 'medium' });
        if (bmp.width === w && bmp.height === h) return { src: bmp, w, h, bytes: w * h * 4 };
        if (bmp.close) bmp.close();
      } catch (_) { /* fall back to a canvas resize */ }
    }
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const x = c.getContext('2d');
    x.imageSmoothingEnabled = true;
    x.imageSmoothingQuality = 'high';
    x.drawImage(img, 0, 0, w, h);
    return { src: c, w, h, bytes: w * h * 4 };
  }

  /* ---------- board ---------- */

  class SwipeCanvas {
    constructor(host, options) {
      this.host = host;
      this.options = options || {};
      this.sections = [];
      this.byName = new Map();
      this.view = { x: 0, y: 0, s: 1 };
      this.groupKey = null;
      this.raf = 0;
      this.saveTimer = 0;
      this.pointers = new Map();
      this.gesture = null;
      this.hover = null;
      this.queue = [];
      this.queueIndex = 0;
      this.labelRects = [];
      this.lastDrawn = 0;
      this.dpr = 1;
      this.cw = 1;
      this.ch = 1;

      host.classList.add('sc-host');
      host.tabIndex = 0;
      this.canvas = el('canvas', 'sc-canvas');
      this.canvas.setAttribute('role', 'img');
      this.canvas.setAttribute('aria-label', 'Canvas of post images grouped into sections');
      this.ctx = this.canvas.getContext('2d', { alpha: false });
      this.empty = el('div', 'sc-empty');
      this.empty.innerHTML = '<i class="ri-image-line" aria-hidden="true"></i>';
      this.empty.title = 'No images match these filters';
      this.toolbar = this.buildToolbar();
      host.replaceChildren(this.canvas, this.empty, this.toolbar);

      const c = this.canvas;
      c.addEventListener('pointerdown', e => this.onPointerDown(e));
      c.addEventListener('pointermove', e => this.onPointerMove(e));
      c.addEventListener('pointerup', e => this.onPointerUp(e));
      c.addEventListener('pointercancel', e => this.onPointerUp(e, true));
      c.addEventListener('pointerleave', () => this.setHover(null));
      c.addEventListener('wheel', e => this.onWheel(e), { passive: false });
      c.addEventListener('contextmenu', e => { if (this.gesture) e.preventDefault(); });
      host.addEventListener('keydown', e => this.onKey(e));

      this.readTheme();
      this.themeObserver = new MutationObserver(() => { this.readTheme(); this.requestDraw(); });
      this.themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(host);
      this.resize();
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

    readTheme() {
      const css = getComputedStyle(document.documentElement);
      const v = (name, fallback) => (css.getPropertyValue(name) || '').trim() || fallback;
      this.theme = {
        board: v('--bg-secondary', '#f4f5f7'),
        frame: v('--bg', '#ffffff'),
        cell: v('--bg-tertiary', '#f7f8fa'),
        border: v('--border', '#e7e9ee'),
        dot: v('--border-strong', '#d5d9e0'),
        accent: v('--accent', '#4f46e5'),
        text: v('--text-primary', '#111827'),
        muted: v('--text-tertiary', '#727c8c'),
        danger: '#ef4444'
      };
    }

    resize() {
      const w = Math.max(1, this.host.clientWidth);
      const h = Math.max(1, this.host.clientHeight);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      if (w === this.cw && h === this.ch && dpr === this.dpr) return;
      this.cw = w; this.ch = h; this.dpr = dpr;
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
      this.requestDraw();
    }

    /* ---------- data & layout ---------- */

    setData(groupKey, sections) {
      const groupChanged = groupKey !== this.groupKey;
      this.groupKey = groupKey;
      this.sections = sections.map(section => {
        // A section limited by the host ends with a "+N more" tile that expands it.
        const total = Math.max(section.total || 0, section.items.length);
        const hidden = total - section.items.length;
        const items = hidden > 0 ? section.items.concat([{ key: MORE_KEY, more: hidden, src: '' }]) : section.items;
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
      this.hover = null;
      this.empty.style.display = this.sections.length ? 'none' : 'flex';
      if (groupChanged) {
        const saved = (readStore()[groupKey] || {}).view;
        if (saved && Number.isFinite(saved.s)) this.view = { x: saved.x, y: saved.y, s: clamp(saved.s, MIN_SCALE, MAX_SCALE) };
        else this.initialView();
      }
      this.requestDraw();
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

    initialView() {
      const b = this.bounds();
      const w = this.cw, h = this.ch;
      const fitScale = Math.min((w - 64) / b.w, (h - 64) / b.h, 1);
      if (fitScale >= 0.35) { this.fit(true); return; }
      // Large boards start readable and anchored top-left rather than microscopic.
      const s = clamp(Math.min((h - 64) / b.h, 1), 0.35, 1);
      this.view = { s, x: 32 - b.x * s, y: 48 - b.y * s };
    }

    fit(silent) {
      const b = this.bounds();
      const w = this.cw, h = this.ch;
      const s = clamp(Math.min((w - 64) / b.w, (h - 64) / b.h, 1), MIN_SCALE, MAX_SCALE);
      this.view = { s, x: (w - b.w * s) / 2 - b.x * s, y: Math.max(48, (h - b.h * s) / 2) - b.y * s };
      if (!silent) { this.requestDraw(); this.saveView(); }
    }

    zoomAt(px, py, factor) {
      const s = clamp(this.view.s * factor, MIN_SCALE, MAX_SCALE);
      const wx = (px - this.view.x) / this.view.s;
      const wy = (py - this.view.y) / this.view.s;
      this.view = { s, x: px - wx * s, y: py - wy * s };
      this.requestDraw();
      this.saveView();
    }

    zoomBy(factor) { this.zoomAt(this.cw / 2, this.ch / 2, factor); }
    zoomTo(scale) { this.zoomBy(scale / this.view.s); }

    panBy(dx, dy) {
      this.view.x += dx;
      this.view.y += dy;
      this.requestDraw();
      this.saveView();
    }

    saveView() {
      clearTimeout(this.saveTimer);
      this.saveTimer = setTimeout(() => {
        if (!this.groupKey) return;
        const store = readStore();
        store[this.groupKey] = Object.assign({}, store[this.groupKey], { view: this.view });
        writeStore(store);
      }, 400);
    }

    resetLayout() {
      const store = readStore();
      if (store[this.groupKey]) delete store[this.groupKey].positions;
      writeStore(store);
      this.place();
      this.fit();
    }

    /** Release decoded thumbnails beyond a small budget while the canvas is hidden. */
    suspend() {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
      this.queue = [];
      trimThumbs(SUSPENDED_CACHE_BYTES);
    }

    /* ---------- drawing ---------- */

    requestDraw() {
      if (this.raf) return;
      this.raf = requestAnimationFrame(() => { this.raf = 0; this.draw(); });
    }

    levelIndex() {
      const need = CELL_W * this.view.s * this.dpr;
      for (let i = 0; i < LEVELS.length; i++) if (LEVELS[i] >= need) return i;
      return LEVELS.length - 1;
    }

    draw() {
      if (!this.host.isConnected || this.host.hidden) return;
      const ctx = this.ctx, t = this.theme, dpr = this.dpr;
      const W = this.cw, H = this.ch;
      const { x, y, s } = this.view;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = t.board;
      ctx.fillRect(0, 0, W, H);

      // Dot grid (screen space, cheap), hidden when it would only add noise.
      if (s >= 0.2) {
        let step = 24 * s;
        while (step < 16) step *= 2;
        ctx.fillStyle = t.dot;
        const ox = mod(x, step), oy = mod(y, step);
        for (let gx = ox; gx < W; gx += step) for (let gy = oy; gy < H; gy += step) ctx.fillRect(gx - 0.6, gy - 0.6, 1.2, 1.2);
      }

      const level = this.levelIndex();
      const levelW = LEVELS[level];
      const wx0 = (-x - PREFETCH) / s, wy0 = (-y - PREFETCH) / s;
      const wx1 = (W - x + PREFETCH) / s, wy1 = (H - y + PREFETCH) / s;
      const cx = (W / 2 - x) / s, cy = (H / 2 - y) / s;
      const stepX = CELL_W + GAP, stepY = CELL_H + GAP;
      const cellW = CELL_W * s, cellH = CELL_H * s;
      const radius = Math.min(14 * s, 14);
      const wanted = [];
      let drawn = 0;
      const dragging = this.gesture && this.gesture.type === 'section' ? this.gesture.section : null;
      const order = dragging ? this.sections.filter(sec => sec !== dragging).concat([dragging]) : this.sections;

      order.forEach(section => {
        if (section.x > wx1 || section.x + section.w < wx0 || section.y > wy1 || section.y + section.h < wy0) return;
        const sx = x + section.x * s, sy = y + section.y * s, sw = section.w * s, sh = section.h * s;
        ctx.fillStyle = t.frame;
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(sx, sy, sw, sh, radius); else ctx.rect(sx, sy, sw, sh);
        ctx.fill();
        if (section === dragging) {
          ctx.lineWidth = 2;
          ctx.strokeStyle = this.gesture.blocked ? t.danger : t.accent;
        } else {
          ctx.lineWidth = 1;
          ctx.strokeStyle = t.border;
        }
        ctx.stroke();

        const bx = section.x + PAD, by = section.y + HEAD;
        const r0 = clamp(Math.floor((wy0 - by) / stepY), 0, section.rows - 1);
        const r1 = clamp(Math.floor((wy1 - by) / stepY), 0, section.rows - 1);
        const c0 = clamp(Math.floor((wx0 - bx) / stepX), 0, section.cols - 1);
        const c1 = clamp(Math.floor((wx1 - bx) / stepX), 0, section.cols - 1);
        for (let r = r0; r <= r1; r++) {
          for (let c = c0; c <= c1; c++) {
            const i = r * section.cols + c;
            if (i >= section.items.length) break;
            const item = section.items[i];
            const px = x + (bx + c * stepX) * s, py = y + (by + r * stepY) * s;
            const onScreen = px < W && py < H && px + cellW > 0 && py + cellH > 0;
            if (item.more) {
              if (!onScreen) continue;
              ctx.fillStyle = t.cell;
              ctx.fillRect(px, py, cellW, cellH);
              if (cellW > 22) {
                ctx.fillStyle = t.muted;
                ctx.font = '600 ' + Math.round(clamp(cellW * 0.16, 9, 22)) + 'px Inter, -apple-system, sans-serif';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText('+' + item.more, px + cellW / 2, py + cellH / 2);
              }
              continue;
            }
            const best = bestThumb(item.src, level);
            if (onScreen) {
              ctx.fillStyle = t.cell;
              ctx.fillRect(px, py, cellW, cellH);
              if (best) {
                const e = best.entry;
                const k = Math.min(cellW / e.w, cellH / e.h);
                const dw = e.w * k, dh = e.h * k;
                ctx.drawImage(e.src, px + (cellW - dw) / 2, py + (cellH - dh) / 2, dw, dh);
                drawn++;
              }
              if (this.hover && this.hover.section === section && this.hover.index === i) {
                ctx.lineWidth = 2;
                ctx.strokeStyle = t.accent;
                ctx.strokeRect(px + 1, py + 1, cellW - 2, cellH - 2);
              }
            }
            if ((!best || !best.exact) && (failures.get(item.src) || 0) < 2) {
              const ddx = bx + c * stepX - cx, ddy = by + r * stepY - cy;
              wanted.push({ url: item.src, level: levelW, d: ddx * ddx + ddy * ddy + (onScreen ? 0 : 1e12) });
            }
          }
        }
      });

      this.drawLabels(order);
      this.lastDrawn = drawn;
      const zoomText = Math.round(s * 100) + '%';
      if (this.zoomLabel.textContent !== zoomText) this.zoomLabel.textContent = zoomText;

      wanted.sort((a, b) => a.d - b.d);
      this.queue = wanted;
      this.queueIndex = 0;
      this.pump();
    }

    /* Section names stay a constant, readable size at any zoom (screen space). */
    drawLabels(order) {
      const ctx = this.ctx, t = this.theme;
      const { x, y, s } = this.view;
      const W = this.cw, H = this.ch;
      ctx.font = '600 12px Inter, -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      this.labelRects = [];
      const headH = HEAD * s;
      const inHeader = headH >= 26;
      order.forEach(section => {
        const sx = x + section.x * s, sy = y + section.y * s, sw = section.w * s;
        if (sx > W || sy > H || sx + sw < 0 || sy + section.h * s < 0) return;
        const maxW = Math.max(60, sw + SECTION_GAP * s - 12);
        let text = section.label;
        let tw = ctx.measureText(text).width;
        if (tw + 18 > maxW) {
          while (text.length > 1 && ctx.measureText(text + '…').width + 18 > maxW) text = text.slice(0, -1);
          text += '…';
          tw = ctx.measureText(text).width;
        }
        // Zoomed out, the label sits just above the frame (like Figma) so no thumbnail is covered.
        const lx = inHeader ? sx + 8 : sx, ly = inHeader ? sy + headH / 2 - 11 : sy - 26;
        const lw = tw + 18, lh = 22;
        if (!inHeader) {
          ctx.fillStyle = t.frame;
          ctx.beginPath();
          if (ctx.roundRect) ctx.roundRect(lx, ly, lw, lh, 6); else ctx.rect(lx, ly, lw, lh);
          ctx.fill();
          ctx.lineWidth = 1;
          ctx.strokeStyle = t.border;
          ctx.stroke();
        }
        ctx.fillStyle = section.color || t.muted;
        ctx.beginPath();
        ctx.arc(lx + 8, ly + lh / 2, 3.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = t.text;
        ctx.fillText(text, lx + 15, ly + lh / 2 + 0.5);
        this.labelRects.push({ section, x: lx, y: ly, w: lw, h: lh });
      });
    }

    /* ---------- loading ---------- */

    pump() {
      while (inflight.size < MAX_INFLIGHT && this.queueIndex < this.queue.length) {
        const job = this.queue[this.queueIndex++];
        const key = thumbKey(job.level, job.url);
        if (thumbs.has(key) || inflight.has(key) || (failures.get(job.url) || 0) >= 2) continue;
        this.load(job.url, job.level, key);
      }
    }

    load(url, level, key) {
      inflight.add(key);
      const img = new Image();
      img.decoding = 'async';
      const done = () => { inflight.delete(key); this.requestDraw(); };
      img.onload = () => {
        downscale(img, level).then(entry => {
          storeThumb(key, entry);
          // Keep a tiny copy too, so zooming far out never needs a refetch.
          const tinyKey = thumbKey(LEVELS[0], url);
          if (level !== LEVELS[0] && !thumbs.has(tinyKey)) return downscale(img, LEVELS[0]).then(t => storeThumb(tinyKey, t));
        }).catch(() => failures.set(url, 2)).then(done);
      };
      img.onerror = () => { failures.set(url, (failures.get(url) || 0) + 1); done(); };
      img.src = url;
    }

    /* ---------- hit testing ---------- */

    toWorld(px, py) {
      return { x: (px - this.view.x) / this.view.s, y: (py - this.view.y) / this.view.s };
    }

    sectionAt(px, py) {
      const w = this.toWorld(px, py);
      for (let i = this.sections.length - 1; i >= 0; i--) {
        const s = this.sections[i];
        if (w.x >= s.x && w.x <= s.x + s.w && w.y >= s.y && w.y <= s.y + s.h) return s;
      }
      return null;
    }

    handleAt(px, py) {
      for (let i = this.labelRects.length - 1; i >= 0; i--) {
        const r = this.labelRects[i];
        if (px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h) return r.section;
      }
      const section = this.sectionAt(px, py);
      if (section && this.toWorld(px, py).y <= section.y + HEAD) return section;
      return null;
    }

    cellAt(px, py) {
      const section = this.sectionAt(px, py);
      if (!section) return null;
      const w = this.toWorld(px, py);
      const lx = w.x - section.x - PAD, ly = w.y - section.y - HEAD;
      if (lx < 0 || ly < 0) return null;
      const c = Math.floor(lx / (CELL_W + GAP)), r = Math.floor(ly / (CELL_H + GAP));
      if (c >= section.cols || lx - c * (CELL_W + GAP) > CELL_W || ly - r * (CELL_H + GAP) > CELL_H) return null;
      const index = r * section.cols + c;
      if (index >= section.items.length) return null;
      return { section, index, item: section.items[index] };
    }

    /** Screen rectangle (relative to the canvas) of one cell; used by tests. */
    cellRect(sectionName, index) {
      const section = this.byName.get(sectionName);
      if (!section || index >= section.items.length) return null;
      const { x, y, s } = this.view;
      const c = index % section.cols, r = Math.floor(index / section.cols);
      return {
        x: x + (section.x + PAD + c * (CELL_W + GAP)) * s,
        y: y + (section.y + HEAD + r * (CELL_H + GAP)) * s,
        w: CELL_W * s, h: CELL_H * s
      };
    }

    activate(hit) {
      if (!hit) return;
      if (hit.item.more) { if (this.options.onExpand) this.options.onExpand(hit.section.name); }
      else if (this.options.onOpen) this.options.onOpen(hit.item);
    }

    setHover(hit) {
      const prev = this.hover;
      const next = hit && !hit.item.more ? { section: hit.section, index: hit.index } : null;
      if ((prev && next && prev.section === next.section && prev.index === next.index) || (!prev && !next)) return;
      this.hover = next;
      this.requestDraw();
    }

    /* ---------- input ---------- */

    localPoint(e) {
      const rect = this.canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }

    onPointerDown(e) {
      if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 1) return;
      this.host.focus({ preventScroll: true });
      try { this.canvas.setPointerCapture(e.pointerId); } catch (_) { /* synthetic or already-ended pointer */ }
      const p = this.localPoint(e);
      this.pointers.set(e.pointerId, p);
      if (this.pointers.size === 2) {
        const [a, b] = Array.from(this.pointers.values());
        if (this.gesture && this.gesture.type === 'section') this.cancelSectionDrag();
        this.gesture = { type: 'pinch', dist: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
        return;
      }
      if (this.pointers.size > 2) return;
      const handle = e.button === 0 ? this.handleAt(p.x, p.y) : null;
      if (handle) {
        this.gesture = { type: 'section', section: handle, start: p, origin: { x: handle.x, y: handle.y }, moved: false, blocked: false };
        this.canvas.style.cursor = 'move';
      } else {
        this.gesture = { type: 'pan', start: p, last: p, moved: false, hit: this.cellAt(p.x, p.y) };
        this.canvas.style.cursor = 'grabbing';
      }
      this.setHover(null);
    }

    onPointerMove(e) {
      const p = this.localPoint(e);
      if (!this.gesture || !this.pointers.has(e.pointerId)) {
        if (e.pointerType === 'mouse') {
          const hit = this.cellAt(p.x, p.y);
          this.setHover(hit);
          this.canvas.style.cursor = this.handleAt(p.x, p.y) ? 'move' : hit ? 'zoom-in' : 'grab';
        }
        return;
      }
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
        else this.requestDraw();
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
        g.blocked = this.sections.some(o => o !== g.section && overlaps(o, g.section, MIN_SECTION_GAP));
        this.requestDraw();
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
          this.gesture = { type: 'pan', start: last, last, moved: true, hit: null };
        }
        return;
      }
      this.gesture = null;
      this.canvas.style.cursor = 'grab';
      if (g.type === 'pan') {
        if (!cancelled && !g.moved) this.activate(g.hit);
        return;
      }
      if (!g.moved) { this.requestDraw(); return; }
      if (cancelled || g.blocked) { this.cancelSectionDrag(g); return; }
      // Snapshot every visible section so moving one never reshuffles the others.
      const store = readStore();
      const entry = store[this.groupKey] = Object.assign({}, store[this.groupKey]);
      entry.positions = Object.assign({}, entry.positions);
      this.sections.forEach(s => { entry.positions[s.name] = { x: s.x, y: s.y }; });
      writeStore(store);
      this.requestDraw();
    }

    cancelSectionDrag(g) {
      g = g || this.gesture;
      if (!g || g.type !== 'section') return;
      g.section.x = g.origin.x;
      g.section.y = g.origin.y;
      if (this.gesture === g) this.gesture = null;
      this.requestDraw();
    }

    onWheel(e) {
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.ch : 1;
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

  SwipeCanvas.stats = () => ({ thumbnails: thumbs.size, bytes: thumbBytes, loading: inflight.size });
  window.SwipeCanvas = SwipeCanvas;
})();
