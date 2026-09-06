(function () {
  'use strict';
  const pending = new Map();
  let worker;
  let unavailable = false;
  let nextId = 0;

  function useOriginal(image) {
    if (image.dataset.previewObjectUrl) {
      URL.revokeObjectURL(image.dataset.previewObjectUrl);
      delete image.dataset.previewObjectUrl;
    }
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
    load(image) {
      if (image.dataset.previewLoaded || image.dataset.previewJob) return;
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
              image.dataset.previewObjectUrl = URL.createObjectURL(event.data.blob);
              image.src = image.dataset.previewObjectUrl;
              image.dataset.previewLoaded = '1';
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
      if (image.dataset.previewObjectUrl) { useOriginal(image); return; }
      image.dataset.previewError = '1';
      image.alt = 'Preview unavailable — open original post';
      // The reserved media area stays stable even for broken source URLs.
    },
    release(root) {
      root.querySelectorAll('img[data-preview-src]').forEach(image => {
        const id = Number(image.dataset.previewJob);
        if (id) { worker?.postMessage({ id, cancel: true }); pending.delete(id); }
        if (image.dataset.previewObjectUrl) URL.revokeObjectURL(image.dataset.previewObjectUrl);
        delete image.dataset.previewObjectUrl;
        delete image.dataset.previewJob;
        delete image.dataset.previewLoaded;
        image.removeAttribute('src');
      });
    }
  };
})();
