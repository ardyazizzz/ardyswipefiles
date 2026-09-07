(function () {
  'use strict';
  const pending = new Map();
  const memory = new Map();
  const MAX_MEMORY_BYTES = 16 * 1024 * 1024;
  let memoryBytes = 0;
  let worker;
  let unavailable = false;
  let nextId = 0;

  function sourceFor(image) { return image.dataset.previewSrc; }

  function clearExpired(image) {
    image.closest('.img-wrap, .slide')?.querySelector('.media-expired')?.remove();
  }

  function showExpired(image) {
    if (image.dataset.previewExpired) return;
    image.dataset.previewExpired = '1';
    image.dataset.previewError = '1';
    image.removeAttribute('src');
    const host = image.closest('.img-wrap, .slide');
    if (!host || host.querySelector('.media-expired')) return;
    const notice = document.createElement('div');
    notice.className = 'media-expired';
    notice.innerHTML = '<i class="ri-image-off-line" aria-hidden="true"></i><span>The original CDN link has expired.</span>';
    host.append(notice);
  }

  function touch(entry) {
    memory.delete(entry.source);
    memory.set(entry.source, entry);
  }

  function remember(source, blob) {
    const prior = memory.get(source);
    if (prior) {
      memoryBytes -= prior.bytes;
      URL.revokeObjectURL(prior.objectUrl);
      memory.delete(source);
    }
    const entry = { source, bytes: blob.size, objectUrl: URL.createObjectURL(blob) };
    memory.set(source, entry);
    memoryBytes += entry.bytes;
    while (memoryBytes > MAX_MEMORY_BYTES && memory.size > 1) {
      const oldest = memory.values().next().value;
      memory.delete(oldest.source);
      memoryBytes -= oldest.bytes;
      URL.revokeObjectURL(oldest.objectUrl);
    }
    return entry;
  }

  function useMemory(image, entry) {
    touch(entry);
    clearExpired(image);
    delete image.dataset.previewExpired;
    image.removeAttribute('data-preview-error');
    image.src = entry.objectUrl;
    image.dataset.previewLoaded = '1';
  }

  function useOriginal(image) {
    clearExpired(image);
    delete image.dataset.previewExpired;
    image.removeAttribute('data-preview-error');
    image.src = image.dataset.previewSrc;
    image.dataset.previewLoaded = '1';
  }

  function failWorker() {
    unavailable = true;
    worker?.terminate();
    worker = null;
    for (const [, image] of pending) {
      delete image.dataset.previewJob;
      useOriginal(image);
    }
    pending.clear();
  }

  function eligible(url) {
    try {
      const parsed = new URL(url, location.href);
      // Our immutable Storage copies, plus same-origin fixtures/assets only.
      // External CDN links continue through the browser's normal image loading.
      const ownStorage = parsed.origin === 'https://dmhiitzunsdqyxopqsby.supabase.co' &&
        parsed.pathname.startsWith('/storage/v1/object/public/');
      return (ownStorage || parsed.origin === location.origin) && /\.(png|jpe?g)$/i.test(parsed.pathname);
    } catch (_) { return false; }
  }

  window.SwipePreview = {
    loaded(image) { delete image.dataset.previewRetried; },
    load(image) {
      if (image.dataset.previewLoaded || image.dataset.previewJob) return;
      const source = sourceFor(image);
      const cached = memory.get(source);
      if (cached) { useMemory(image, cached); return; }
      if (unavailable || !window.Worker || !window.OffscreenCanvas || !eligible(image.dataset.previewSrc)) {
        useOriginal(image);
        return;
      }
      if (!worker) {
        try {
          worker = new Worker(new URL('swipe-preview-worker.js', document.baseURI));
          worker.onerror = failWorker;
          worker.onmessage = event => {
            const image = pending.get(event.data.id);
            if (!image) return;
            pending.delete(event.data.id);
            delete image.dataset.previewJob;
            if (event.data.blob) {
              useMemory(image, remember(sourceFor(image), event.data.blob));
            } else useOriginal(image);
          };
        } catch (_) { failWorker(); useOriginal(image); return; }
      }
      const id = ++nextId;
      image.dataset.previewJob = String(id);
      pending.set(id, image);
      worker.postMessage({ id, url: new URL(image.dataset.previewSrc, location.href).href });
    },
    error(image) {
      if (image.dataset.previewExpired) return;
      const source = sourceFor(image);
      const cached = memory.get(source);
      if (cached) {
        memory.delete(source);
        memoryBytes -= cached.bytes;
        URL.revokeObjectURL(cached.objectUrl);
        useOriginal(image);
        return;
      }
      if (!image.dataset.previewRetried) {
        image.dataset.previewRetried = '1';
        delete image.dataset.previewLoaded;
        image.removeAttribute('src');
        setTimeout(() => {
          if (image.isConnected && !image.dataset.previewExpired) useOriginal(image);
        }, 350);
        return;
      }
      showExpired(image);
    },
    release(root) {
      root.querySelectorAll('img[data-preview-src]').forEach(image => {
        const id = Number(image.dataset.previewJob);
        if (id) { worker?.postMessage({ id, cancel: true }); pending.delete(id); }
        delete image.dataset.previewJob;
        delete image.dataset.previewLoaded;
        image.removeAttribute('src');
      });
    }
  };
})();
