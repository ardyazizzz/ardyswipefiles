/* Browser-owned functional checks and repeatable frame timing, with local fixtures only. */
(function () {
  const panel = document.createElement('div');
  panel.id = 'testPanel';
  panel.style.cssText = 'position:fixed;right:8px;top:8px;z-index:10000;background:white;color:black;padding:8px;border:1px solid #aaa;max-width:420px;font:12px monospace;max-height:45vh;overflow:auto';
  panel.innerHTML = '<button id="runChecks">Run functional checks</button> <button id="runCanvas">Run canvas checks</button> <button id="runBenchmark">Run scrolling benchmark</button><pre id="testResults">Ready</pre>';
  document.body.append(panel);
  const report = value => document.getElementById('testResults').textContent = JSON.stringify(value, null, 2);
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const frame = () => new Promise(requestAnimationFrame);
  const assert = (condition, label) => { if (!condition) throw new Error(label); };
  const cards = () => Array.from(document.querySelectorAll('#cardGrid > .card'));
  const imageReady = img => img?.complete && img.naturalWidth > 0;
  async function settle() { await frame(); await frame(); await pause(250); }
  async function go(y) { window.scrollTo(0, y); await settle(); }
  function noOverlap() {
    const rects = cards().map(card => ({ id: card.dataset.id, rect: card.getBoundingClientRect() }));
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i].rect, b = rects[j].rect;
      assert(!(a.left < b.right - 2 && a.right > b.left + 2 && a.top < b.bottom - 2 && a.bottom > b.top + 2), 'Overlapping cards ' + rects[i].id + '/' + rects[j].id);
    }
  }
  function alignedGridRows() {
    const rows = new Map();
    cards().forEach(card => {
      const rect = card.getBoundingClientRect();
      const key = Math.round(rect.top);
      if (!rows.has(key)) rows.set(key, []);
      rows.get(key).push(rect);
    });
    for (const row of rows.values()) {
      if (row.length < 2) continue;
      const height = row[0].height;
      assert(row.every(rect => Math.abs(rect.height - height) < 2), 'Grid cards in one row must have matching heights');
    }
  }
  document.getElementById('runChecks').onclick = async () => {
    const passed = [];
    report({ running: true });
    try {
      await settle();
      assert(document.getElementById('totalBadge').textContent.includes(fixtureCount), 'Full dataset remains searchable');
      assert(cards().length < 120, 'Bounded mounted cards');
      passed.push('Full result count with bounded DOM');
      await go(0);
      await pause(500);
      const firstImage = document.querySelector('#cardGrid .card img');
      assert(imageReady(firstImage), 'Preview must actually load');
      firstImage.click();
      assert(document.getElementById('imageOverlay').style.display === 'flex', 'Lightbox opens');
      assert(document.getElementById('lightboxImage').src === firstImage.dataset.previewSrc, 'Lightbox uses original');
      nextLightboxImage();
      assert(document.getElementById('lightboxImage').src.includes('slide=2'), 'All carousel slides available');
      closeImageLightbox();
      const firstTrack = document.querySelector('.card-hero-track');
      firstTrack.scrollLeft = firstTrack.clientWidth * 5;
      await settle();
      assert(firstTrack.parentElement.querySelector('.card-hero-badge').textContent === '6 / 12', 'Carousel badge');
      assert(imageReady(firstTrack.querySelectorAll('img')[5]), 'Distant carousel slide preview loads');
      passed.push('Preview, full-resolution lightbox and 12-slide carousel');
      for (const y of [15000, 60000, 120000, 250000]) {
        await go(y);
        assert(cards().length > 0 && cards().length < 120, 'Bounded DOM at ' + y);
        noOverlap();
      }
      assert(swipeVirtualGrid.cache.size <= 120, 'Card cache bounded');
      await go(0);
      const restored = document.querySelector('.card-hero-track');
      assert(Math.round(restored.scrollLeft / restored.clientWidth) === 5, 'Carousel position survives eviction');
      passed.push('Deep jumps, no overlaps, bounded cache and carousel restoration');
      const beforeHeight = document.getElementById('cardGrid').offsetHeight;
      toggleLayout(); await settle(); noOverlap(); alignedGridRows();
      assert(document.getElementById('cardGrid').offsetHeight > 0, 'Grid height retained');
      cycleDensity(); await settle(); noOverlap(); alignedGridRows();
      toggleLayout(); await settle(); noOverlap();
      passed.push('Aligned Grid rows, Masonry and density switches');
      const input = document.getElementById('searchInput');
      input.value = 'Creator 1999'; applyFilters(); await settle();
      assert(cards().length === 1, 'Search all data including never-mounted items');
      input.value = 'no-match-xyz'; applyFilters(); await settle();
      assert(document.querySelector('.empty-state'), 'Empty state');
      input.value = 'Creator 1'; applyFilters(); await settle(); await pause(650);
      assert(document.querySelector('.media-expired')?.textContent.includes('The original CDN link has expired.'), 'Expired CDN image has a clear placeholder');
      input.value = ''; applyFilters(); await settle();
      sortSwipes('oldest'); await settle();
      assert(cards()[0].dataset.id === String(2000000000000 - fixtureCount + 1), 'Sorting order');
      sortSwipes('newest'); await settle();
      toggleFilter('Category', 'Design'); await settle();
      assert(cards().every(c => c.querySelector('.card-tags').textContent.includes('Design')), 'Filter results');
      clearAllFilters(); await settle();
      passed.push('Full-library search, empty state, sorting and filters');
      for (const mode of ['creators', 'websites', 'snippets', 'posts']) {
        setMode(mode); await settle(); assert(cards().length > 0, 'Mode ' + mode);
      }
      passed.push('All four content modes');
      updateAuthState({ user: { id: 'local-fixture' }, access_token: 'test-only' }); await settle();
      toggleSelectMode(); await settle();
      const selected = Number(cards()[0].dataset.id);
      toggleCardSelection(selected);
      await go(200000); await go(0);
      assert(document.querySelector('.card[data-id="' + selected + '"]').classList.contains('selected'), 'Selection survives eviction');
      toggleSelectMode(); await settle();
      openEditModal(selected);
      document.getElementById('e-text').value = 'Edited locally during virtual scrolling';
      updateSwipe(); await settle();
      assert(cards()[0].textContent.includes('Edited locally'), 'In-place update invalidates card');
      passed.push('Selection and editing after eviction (mock writes only)');
      _localChange = 0;
      const changed = { ...swipes[0], text: 'Realtime fixture update' };
      handleRealtimeChange({ eventType: 'UPDATE', new: changed, old: { id: changed.id, type: 'posts' } });
      await settle();
      assert(cards()[0].textContent.includes('Realtime fixture update'), 'Realtime update');
      passed.push('Realtime refresh');
      assert(fixtureErrors.length === 0, 'Browser errors: ' + fixtureErrors.join('; '));
      report({ ok: true, passed, mounted: cards().length, cached: swipeVirtualGrid.cache.size, total: fixtureCount, mockWrites: fixtureWrites.length });
    } catch (error) { report({ ok: false, passed, error: error.message, browserErrors: fixtureErrors }); }
  };
  document.getElementById('runCanvas').onclick = async () => {
    const passed = [];
    report({ running: true });
    const sectionRects = () => Array.from(document.querySelectorAll('.sc-section')).map(s => ({ name: s.dataset.section, rect: s.getBoundingClientRect() }));
    const sectionsOverlap = () => sectionRects().some((a, i, all) => all.slice(i + 1).some(b =>
      a.rect.left < b.rect.right && a.rect.right > b.rect.left && a.rect.top < b.rect.bottom && a.rect.bottom > b.rect.top));
    try {
      setLayout('canvas'); await settle();
      assert(!document.getElementById('canvasView').hidden && document.body.classList.contains('canvas-active'), 'Canvas shown');
      assert(cards().length === 0, 'Card grid released while the canvas is shown');
      setCanvasGroup('Topic' in filters ? 'Topic' : 'Format'); await settle();
      filters.Topic = ['Topic 0', 'Topic 1', 'Topic 2', 'Topic 3'];
      setCanvasGroup('Topic'); await settle();
      const sections = sectionRects().map(s => s.name);
      assert(sections.includes('Topic 3') && sections.includes('\u0000none'), 'One section per option plus ungrouped');
      const multi = swipes.find(s => canvasImages(s).length && Array.isArray(s.filters.Topic) && s.filters.Topic.length > 1);
      const inSections = swipeCanvas.sections.filter(sec => sec.index.has(String(multi.id))).length;
      assert(inSections === multi.filters.Topic.length, 'Multi-valued post appears in each matching section');
      assert(!sectionsOverlap(), 'Sections never overlap');
      swipeCanvas.fit(); await settle();
      assert(document.querySelectorAll('.sc-cell').length <= 900, 'Mounted thumbnails bounded');
      passed.push('Sections by one category, duplicates per value, no overlap, bounded DOM');
      const first = swipeCanvas.sections[0], second = swipeCanvas.sections[1];
      const origin = { x: first.x, y: first.y };
      first.x = second.x; first.y = second.y;
      const blocked = swipeCanvas.sections.some(o => o !== first && o.x < first.x + first.w && o.x + o.w > first.x);
      first.x = origin.x; first.y = origin.y;
      assert(blocked, 'Overlap detection');
      toggleFilter('Category', 'Design'); await settle();
      assert(document.getElementById('resultsLabel').textContent.includes('grouped by Topic'), 'Other filters narrow the canvas');
      assert(location.hash.includes('canvas=Topic'), 'Canvas state in URL');
      clearAllFilters(); await settle();
      passed.push('Filters, URL hash');
      const cell = document.querySelector('.sc-cell');
      cell.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 7, button: 0, clientX: 1, clientY: 1 }));
      cell.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 7, button: 0, clientX: 1, clientY: 1 }));
      assert(document.getElementById('imageOverlay').style.display === 'flex', 'Thumbnail opens the lightbox');
      closeImageLightbox();
      passed.push('Read-only lightbox');
      setCanvasLimit(6); await settle();
      assert(swipeCanvas.sections.every(sec => sec.shown <= 6), 'Per-section limit applied');
      const limited = swipeCanvas.sections.find(sec => sec.total > 6);
      assert(limited && limited.items[limited.items.length - 1].more === limited.total - 6, '+N more tile');
      expandCanvasSection(limited.name); await settle();
      assert(swipeCanvas.byName.get(limited.name).shown === limited.total, 'One section expands');
      assert(location.hash.includes('limit=6'), 'Limit in URL');
      setCanvasLimit(0); await settle();
      passed.push('Per-section limit with expandable +N more');
      setLayout('grid'); await settle();
      assert(document.getElementById('canvasView').hidden && cards().length > 0 && !document.querySelector('.sc-cell'), 'Grid restored and canvas images released');
      passed.push('Grid restored');
      assert(fixtureErrors.length === 0, 'Browser errors: ' + fixtureErrors.join('; '));
      report({ ok: true, passed, writes: fixtureWrites.length });
    } catch (error) { report({ ok: false, passed, error: error.message, browserErrors: fixtureErrors }); }
  };
  document.getElementById('runBenchmark').onclick = async () => {
    report({ running: true });
    await go(0);
    const frames = [];
    let last;
    const start = performance.now();
    for (let i = 0; i < 240; i++) {
      const now = await frame();
      if (last) frames.push(now - last);
      last = now;
      window.scrollTo(0, i * 100);
    }
    await settle();
    const sorted = frames.slice().sort((a, b) => a - b);
    report({ variant: location.pathname === '/baseline' ? 'baseline' : 'optimized', total: fixtureCount,
      elapsedMs: Math.round(performance.now() - start), mountedCards: cards().length,
      gridElements: document.getElementById('cardGrid').querySelectorAll('*').length,
      frameMedianMs: +sorted[Math.floor(sorted.length * 0.5)].toFixed(1),
      frameP95Ms: +sorted[Math.floor(sorted.length * 0.95)].toFixed(1), framesOver50Ms: frames.filter(n => n > 50).length,
      cachedCards: typeof swipeVirtualGrid === 'undefined' ? null : swipeVirtualGrid?.cache.size,
      errors: fixtureErrors });
  };
})();
