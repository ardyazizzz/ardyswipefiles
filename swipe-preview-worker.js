/* Local-only thumbnails. Original URLs and Supabase records are never changed. */
'use strict';
const jobs = [];
const controllers = new Map();
let running = 0;
let database;
let cacheWrites = 0;
const MAX_SOURCE_BYTES = 12 * 1024 * 1024;
const MAX_CACHE_BYTES = 32 * 1024 * 1024;

function openCache() {
  if (!database) database = new Promise(resolve => {
    const request = indexedDB.open('swipeardy_previews_v1', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('images', { keyPath: 'url' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
  return database;
}

async function cached(url) {
  const db = await openCache();
  if (!db) return null;
  return new Promise(resolve => {
    try {
      const request = db.transaction('images').objectStore('images').get(url);
      request.onsuccess = () => resolve(request.result?.blob || null);
      request.onerror = () => resolve(null);
    } catch (_) { resolve(null); }
  });
}

async function save(url, blob) {
  const db = await openCache();
  if (!db) return;
  try {
    const tx = db.transaction('images', 'readwrite');
    tx.objectStore('images').put({ url, blob, size: blob.size, saved: Date.now() });
    if (++cacheWrites % 8) return;
    const request = tx.objectStore('images').getAll();
    request.onsuccess = () => {
      const rows = request.result.sort((a, b) => b.saved - a.saved);
      let bytes = 0;
      rows.forEach((row, i) => {
        bytes += row.size;
        if (i >= 300 || bytes > MAX_CACHE_BYTES) tx.objectStore('images').delete(row.url);
      });
    };
  } catch (_) { /* Cache quota/private browsing must never hide a preview. */ }
}

async function thumbnail(url, signal) {
  const hit = await cached(url);
  if (hit) return hit;
  const response = await fetch(url, { signal, credentials: 'omit' });
  if (!response.ok) throw new Error('source');
  // Leave animated GIF/WebP/AVIF intact. APNG is detected before conversion.
  const type = (response.headers.get('content-type') || '').split(';')[0];
  if (!['image/jpeg', 'image/png'].includes(type)) {
    await response.body?.cancel();
    throw new Error('keep-original');
  }
  if (Number(response.headers.get('content-length')) > MAX_SOURCE_BYTES) {
    await response.body?.cancel();
    throw new Error('large-source');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    size += result.value.length;
    if (size > MAX_SOURCE_BYTES) { await reader.cancel(); throw new Error('large-source'); }
    chunks.push(result.value);
  }
  const source = new Blob(chunks, { type });
  if (type === 'image/png') {
    const bytes = new Uint8Array(await source.arrayBuffer());
    const view = new DataView(bytes.buffer);
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const length = view.getUint32(offset);
      const chunkType = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
      if (chunkType === 'acTL') throw new Error('keep-animation');
      if (chunkType === 'IDAT') break;
      offset += 12 + length;
    }
  }
  let bitmap;
  try {
    bitmap = await createImageBitmap(source);
    if (signal.aborted) throw new Error('cancelled');
    const scale = Math.min(1, 800 / Math.max(bitmap.width, bitmap.height));
    const canvas = new OffscreenCanvas(Math.max(1, Math.round(bitmap.width * scale)),
      Math.max(1, Math.round(bitmap.height * scale)));
    const context = canvas.getContext('2d');
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.86 });
    await save(url, blob);
    return blob;
  } finally { bitmap?.close(); }
}

function pump() {
  while (running < 2 && jobs.length) {
    const job = jobs.shift();
    if (!controllers.has(job.id)) continue;
    running++;
    const controller = controllers.get(job.id);
    const timeout = setTimeout(() => controller.abort(), 10000);
    thumbnail(job.url, controller.signal).then(blob => {
      if (controllers.has(job.id)) postMessage({ id: job.id, blob });
    }).catch(() => {
      if (controllers.has(job.id)) postMessage({ id: job.id, fallback: true });
    }).finally(() => {
      clearTimeout(timeout);
      controllers.delete(job.id);
      running--;
      pump();
    });
  }
}

onmessage = event => {
  const job = event.data;
  if (job.cancel) {
    controllers.get(job.id)?.abort();
    controllers.delete(job.id);
    const index = jobs.findIndex(item => item.id === job.id);
    if (index !== -1) jobs.splice(index, 1);
    return;
  }
  controllers.set(job.id, new AbortController());
  jobs.push(job);
  pump();
};
