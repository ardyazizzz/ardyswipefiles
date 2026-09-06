/* Bounded card DOM for both row grids and masonry. No framework or data writes. */
(function (root) {
  'use strict';

  function layoutItems(items, columns, width, gap, masonry, heightFor) {
    const cardWidth = (width - gap * (columns - 1)) / columns;
    const lanes = Array.from({ length: columns }, () => []);
    const bottoms = Array(columns).fill(0);
    const positions = [];
    if (masonry) {
      for (let i = 0; i < items.length; i++) {
        const column = bottoms.indexOf(Math.min(...bottoms));
        const height = Math.max(80, heightFor(items[i], cardWidth));
        const position = { index: i, id: String(items[i].id), left: column * (cardWidth + gap),
          top: bottoms[column], width: cardWidth, height };
        positions.push(position);
        lanes[column].push(position);
        bottoms[column] = position.top + height + gap;
      }
    } else {
      // A grid row is a shared visual unit: its cards get the row's tallest
      // intrinsic height so every bottom edge aligns before the next row begins.
      let rowTop = 0;
      for (let start = 0; start < items.length; start += columns) {
        const row = items.slice(start, start + columns);
        const rowHeights = row.map(item => Math.max(80, heightFor(item, cardWidth)));
        const rowHeight = Math.max(...rowHeights);
        row.forEach((item, column) => {
          const index = start + column;
          const position = { index, id: String(item.id), left: column * (cardWidth + gap),
            top: rowTop, width: cardWidth, height: rowHeight };
          positions.push(position);
          lanes[column].push(position);
          bottoms[column] = rowTop + rowHeight + gap;
        });
        rowTop += rowHeight + gap;
      }
    }
    return { positions, lanes, height: Math.max(0, ...bottoms) - (items.length ? gap : 0) };
  }

  function visibleItems(layout, top, bottom) {
    const result = [];
    layout.lanes.forEach(lane => {
      let lo = 0, hi = lane.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (lane[mid].top + lane[mid].height < top) lo = mid + 1;
        else hi = mid;
      }
      for (let i = lo; i < lane.length && lane[i].top <= bottom; i++) result.push(lane[i]);
    });
    return result.sort((a, b) => a.index - b.index);
  }

  class SwipeVirtualGrid {
    constructor(grid, callbacks) {
      this.grid = grid;
      this.callbacks = callbacks;
      this.items = [];
      this.cache = new Map();
      this.heights = new Map();
      this.mediaState = new Map();
      this.mounted = new Set();
      this.layout = { positions: [], lanes: [], height: 0 };
      this.frame = 0;
      this.active = false;
      this.dirty = true;
      this.onScroll = () => this.schedule();
      window.addEventListener('scroll', this.onScroll, { passive: true });
      window.addEventListener('resize', this.onScroll, { passive: true });
      this.resizeObserver = new ResizeObserver(entries => {
        let changed = false;
        for (const entry of entries) {
          const id = entry.target.dataset.id;
          if (!this.options?.masonry) continue;
          const height = entry.borderBoxSize?.[0]?.blockSize || entry.target.offsetHeight;
          if (height && Math.abs((this.heights.get(id) || 0) - height) > 1) {
            this.heights.set(id, height);
            changed = true;
          }
        }
        if (changed) { this.dirty = true; this.schedule(); }
      });
      this.widthObserver = new ResizeObserver(this.onScroll);
      this.widthObserver.observe(grid);
      window.addEventListener('beforeprint', () => { this.printing = true; this.flush(); });
      window.addEventListener('afterprint', () => { this.printing = false; this.schedule(); });
      grid.addEventListener('focusout', this.onScroll);
    }

    setItems(items, options) {
      const wasActive = this.active;
      const reset = wasActive && this.options.resetKey !== options.resetKey;
      this.active = true;
      this.items = items;
      this.options = options;
      this.grid.classList.add('virtual-grid');
      this.grid.style.columnCount = 'auto';
      const ids = new Set(items.map(item => String(item.id)));
      for (const [id] of this.cache) if (!ids.has(id)) this.evict(id);
      for (const id of this.heights.keys()) if (!ids.has(id)) this.heights.delete(id);
      for (const id of this.mediaState.keys()) if (!ids.has(id)) this.mediaState.delete(id);
      if (reset) {
        this.layout = { positions: [], lanes: [], height: 0 };
      }
      this.dirty = true;
      this.flush();
    }

    schedule() {
      if (!this.active || this.frame) return;
      this.frame = requestAnimationFrame(() => { this.frame = 0; this.flush(); });
    }

    rebuild(top, width, columns) {
      // Keep the same visible card at the same screen position when measured
      // heights replace estimates, including changes from fonts or Realtime.
      const anchor = visibleItems(this.layout, top, top + 1)[0];
      const previousTop = anchor?.top;
      this.layout = layoutItems(this.items, columns, width, 16, this.options.masonry,
        item => this.heights.get(String(item.id)) || this.options.estimate(item));
      this.grid.style.height = this.layout.height + 'px';
      this.dirty = false;
      if (anchor && top > 0) {
        const next = this.layout.positions.find(position => position.id === anchor.id);
        if (next && Math.abs(next.top - previousTop) > 1) {
          const delta = next.top - previousTop;
          window.scrollBy({ top: delta, behavior: 'instant' });
          return top + delta;
        }
      }
      return top;
    }

    flush() {
      if (!this.active) return;
      const width = this.grid.clientWidth;
      if (!width) return;
      const columns = this.options.columns(width);
      const sizeKey = [width, columns, this.options.masonry, this.options.auth].join(':');
      if (sizeKey !== this.sizeKey) {
        this.sizeKey = sizeKey;
        this.heights.clear();
        this.dirty = true;
      }
      let top = -this.grid.getBoundingClientRect().top;
      if (this.dirty) top = this.rebuild(top, width, columns);
      // Two bounded passes settle the initially visible cards before returning.
      for (let pass = 0; pass < 2; pass++) {
        const positions = this.printing ? this.layout.positions :
          visibleItems(this.layout, top - 1000, top + window.innerHeight + 1000);
        const focused = document.activeElement?.closest('.card');
        if (focused && this.grid.contains(focused) && !positions.some(p => p.id === focused.dataset.id)) {
          const pinned = this.layout.positions.find(p => p.id === focused.dataset.id);
          if (pinned) positions.push(pinned);
        }
        positions.sort((a, b) => a.index - b.index);
        const wanted = new Set(positions.map(p => p.id));
        for (const id of this.mounted) if (!wanted.has(id)) this.detach(id);
        const newNodes = [];
        positions.forEach((position, index) => {
          const item = this.items[position.index];
          const html = this.callbacks.html(item, position.index);
          let entry = this.cache.get(position.id);
          if (!entry || entry.html !== html) {
            if (entry) this.evict(position.id);
            this.heights.delete(position.id);
            const template = document.createElement('template');
            template.innerHTML = html.trim();
            entry = { node: template.content.firstElementChild, html };
            this.cache.set(position.id, entry);
          }
          const node = entry.node;
          node.style.width = position.width + 'px';
          node.style.left = position.left + 'px';
          node.style.top = position.top + 'px';
          const isNew = !this.mounted.has(position.id);
          // New grid cards first measure their natural content. On the next
          // pass they receive the tallest height in their row.
          node.style.height = this.options.masonry || isNew ? '' : position.height + 'px';
          node.setAttribute('aria-posinset', position.index + 1);
          node.setAttribute('aria-setsize', this.items.length);
          node.setAttribute('role', 'listitem');
          const existing = this.grid.children[index];
          if (existing !== node) this.grid.insertBefore(node, existing || null);
          if (isNew) {
            this.mounted.add(position.id);
            this.restoreState(position.id, node);
            this.callbacks.mount(node);
            if (this.options.masonry) this.resizeObserver.observe(node);
            newNodes.push(node);
          }
          this.cache.delete(position.id);
          this.cache.set(position.id, entry); // LRU order
        });
        let measured = false;
        for (const node of newNodes) {
          const height = node.offsetHeight;
          if (height && Math.abs((this.heights.get(node.dataset.id) || 0) - height) > 1) {
            this.heights.set(node.dataset.id, height);
            measured = true;
          }
        }
        if (!measured) break;
        top = this.rebuild(top, width, columns);
        // Update positions even on the final pass (no one-frame card overlaps).
        for (const p of this.layout.positions) {
          if (this.mounted.has(p.id)) {
            const node = this.cache.get(p.id).node;
            node.style.top = p.top + 'px';
            node.style.left = p.left + 'px';
            node.style.height = this.options.masonry ? '' : p.height + 'px';
          }
        }
      }
      for (const [id] of Array.from(this.cache)) {
        if (this.cache.size <= Math.max(120, this.mounted.size)) break;
        if (!this.mounted.has(id)) this.evict(id);
      }
    }

    detach(id) {
      const entry = this.cache.get(id);
      if (!entry) return;
      const track = entry.node.querySelector('.card-hero-track');
      if (track && track.clientWidth) {
        // Keep carousel continuity without retaining state for an unbounded library.
        this.mediaState.delete(id);
        this.mediaState.set(id, {
          slide: Math.round(track.scrollLeft / track.clientWidth), source: track.dataset.images
        });
        while (this.mediaState.size > 300) this.mediaState.delete(this.mediaState.keys().next().value);
      }
      this.resizeObserver.unobserve(entry.node);
      this.callbacks.detach(entry.node);
      entry.node.remove();
      this.mounted.delete(id);
    }

    restoreState(id, node) {
      const state = this.mediaState.get(id);
      const track = node.querySelector('.card-hero-track');
      if (state && track && track.dataset.images === state.source) {
        track.scrollLeft = state.slide * track.clientWidth;
      }
    }

    evict(id) {
      const entry = this.cache.get(id);
      if (!entry) return;
      this.detach(id);
      this.callbacks.dispose(entry.node);
      this.cache.delete(id);
    }

    clear() {
      this.active = false;
      if (this.frame) cancelAnimationFrame(this.frame);
      this.frame = 0;
      for (const [id] of this.cache) this.evict(id);
      this.heights.clear();
      this.mediaState.clear();
      this.items = [];
      this.layout = { positions: [], lanes: [], height: 0 };
      this.grid.classList.remove('virtual-grid');
      this.grid.style.height = '';
      this.grid.removeAttribute('role');
      this.sizeKey = '';
    }
  }

  root.SwipeVirtualGrid = SwipeVirtualGrid;
  if (typeof module !== 'undefined') module.exports = { layoutItems, visibleItems };
})(typeof window === 'undefined' ? globalThis : window);
