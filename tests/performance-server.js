// Isolated browser test server. No credentials, remote database, or dependencies.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const baseline = execFileSync('git', ['show', 'd56e067:index.html'], { cwd: root, encoding: 'utf8' });
const files = new Map([
  ['/swipe-virtual-grid.js', 'swipe-virtual-grid.js'], ['/swipe-preview.js', 'swipe-preview.js'], ['/swipe-canvas.js', 'swipe-canvas.js'],
  ['/swipe-preview-worker.js', 'swipe-preview-worker.js'], ['/fixture.js', 'tests/performance-fixture.js'],
  ['/checks.js', 'tests/browser-checks.js']
]);
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  res.setHeader('Cache-Control', 'no-store');
  if (url.pathname === '/' || url.pathname === '/baseline') {
    let html = url.pathname === '/baseline' ? baseline : fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    html = html.replace(/<link[^>]+https:[^>]+>/g, '');
    html = html.replace('<script src="supabase.js"></script>', '<script src="fixture.js"></script>');
    html = html.replace('</body>', '<script src="checks.js"></script></body>');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.end(html);
  }
  if (files.has(url.pathname)) {
    res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
    return res.end(fs.readFileSync(path.join(root, files.get(url.pathname))));
  }
  if (url.pathname === '/image.svg') {
    res.setHeader('Content-Type', 'image/svg+xml');
    return res.end(`<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1000"><rect width="800" height="1000" fill="#e6edf5"/><circle cx="400" cy="340" r="200" fill="#4f46e5"/><text x="400" y="650" font-size="70" text-anchor="middle">Slide ${Number(url.searchParams.get('slide')) || 1}</text><text x="400" y="750" font-size="30" text-anchor="middle">Original image preview</text></svg>`);
  }
  res.statusCode = 404;
  res.end('Not found');
}).listen(4173, '127.0.0.1', () => console.log('Isolated Swipe.ardy tests: http://127.0.0.1:4173/ (baseline: /baseline)'));
