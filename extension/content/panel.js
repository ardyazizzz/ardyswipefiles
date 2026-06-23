(function () {
  if (window.__SWIPEARDY_PANEL__) return;
  window.__SWIPEARDY_PANEL__ = true;

  var existing = document.getElementById('swipeardy-panel-host');
  if (existing) { existing.remove(); return; }

  var host = document.createElement('div');
  host.id = 'swipeardy-panel-host';
  host.style.cssText = 'position:fixed;top:20px;right:20px;z-index:2147483647;font-family:Inter,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;';
  var shadow = host.attachShadow({ mode: 'open' });
  document.documentElement.appendChild(host);

  shadow.innerHTML = '<style>' +
    ':host{all:initial}*{box-sizing:border-box;margin:0;padding:0}' +
    '.panel{width:340px;background:#fff;color:#14181f;border-radius:14px;box-shadow:0 10px 40px rgba(15,23,42,.18),0 2px 8px rgba(15,23,42,.08);font-size:13px;line-height:1.5;font-family:Inter,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;overflow:hidden}' +
    '.header{background:#1c1c1e;color:#fff;padding:10px 14px;display:flex;align-items:center;justify-content:space-between;cursor:grab;user-select:none;-webkit-user-select:none}' +
    '.header:active{cursor:grabbing}' +
    '.header-left{display:flex;align-items:center;gap:8px;min-width:0}' +
    '.header-title{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '.header-btn{border:0;background:rgba(255,255,255,.1);color:rgba(255,255,255,.8);width:28px;height:28px;border-radius:7px;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:15px;transition:background .15s}' +
    '.header-btn:hover{background:rgba(255,255,255,.2);color:#fff}' +
    '.body{padding:16px;max-height:calc(100vh - 120px);overflow-y:auto}' +
    '.body.collapsed{display:none}' +
    '.brand{display:flex;align-items:center;gap:8px;margin-bottom:12px}' +
    '.brand-icon{width:22px;height:22px;border-radius:6px;background:#4f46e5;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:12px;flex-shrink:0}' +
    '.brand-name{font-size:14px;font-weight:700;color:#14181f}' +
    '.badge{padding:2px 8px;border-radius:20px;font-size:10px;font-weight:700;border:1px solid}' +
    '.badge.linkedin{border-color:#eef0fe;color:#4f46e5;background:#eef0fe}' +
    '.badge.twitter{border-color:#e7e9ee;color:#5b6472;background:#f4f5f7}' +
    '.badge.pinterest{border-color:#fee2e2;color:#e0483f;background:#fdecea}' +
    '.state{text-align:center;width:100%}' +
    '.state-icon{font-size:28px;margin-bottom:8px}' +
    '.success{color:#22c55e}.err{color:#e0483f}' +
    '.spinner{width:24px;height:24px;border:3px solid #f7f8fa;border-top-color:#4f46e5;border-radius:50%;animation:sp .6s linear infinite;margin:0 auto 10px}' +
    '@keyframes sp{to{transform:rotate(360deg)}}' +
    '.hint{color:#9aa3b2;font-size:11px;margin-top:4px;line-height:1.5}' +
    '.btn{display:inline-flex;align-items:center;justify-content:center;width:100%;padding:9px 14px;border-radius:10px;border:0;cursor:pointer;font-weight:600;font-size:13px;line-height:1;font-family:inherit;transition:background .18s cubic-bezier(.4,0,.2,1),transform .1s,box-shadow .18s}' +
    '.btn-primary{background:#4f46e5;color:#fff;box-shadow:0 1px 2px rgba(79,70,229,.25)}.btn-primary:hover{background:#4338ca;box-shadow:0 4px 14px rgba(79,70,229,.32)}.btn-primary:active{transform:translateY(1px)}.btn-primary:focus-visible{outline:none;box-shadow:0 0 0 3px rgba(79,70,229,.18)}' +
    '.btn-ghost{background:#fff;color:#5b6472;border:1px solid #e7e9ee;box-shadow:0 1px 2px rgba(16,24,40,.04)}.btn-ghost:hover{background:#f7f8fa;border-color:#c3c8d2;color:#14181f}.btn-ghost:active{transform:translateY(1px)}' +
    '.btn-secondary{background:#fff;color:#5b6472;border:1px solid #e7e9ee;box-shadow:0 1px 2px rgba(16,24,40,.04)}.btn-secondary:hover{background:#f7f8fa;border-color:#c3c8d2;color:#14181f}.btn-secondary:active{transform:translateY(1px)}' +
    '.btn:disabled{opacity:.4;cursor:not-allowed}' +
    '.divider{height:1px;background:#d8dbe2;margin:12px 0}' +
    '.desc{font-size:11px;color:#9aa3b2;margin-top:3px;text-align:left}' +
    '.scan-results{text-align:center}' +
    '.scan-count{font-size:13px;font-weight:600;color:#14181f;margin-bottom:6px}' +
    '.scan-actions{display:flex;gap:8px}.scan-actions .btn{flex:1}' +
    '.scan-status{font-size:11px;color:#9aa3b2;margin-top:6px}' +
    '.field{margin-bottom:8px;text-align:left}' +
    '.field label{display:block;font-size:10px;font-weight:600;color:#5b6472;margin-bottom:3px;text-transform:uppercase;letter-spacing:.5px}' +
    '.input{width:100%;padding:8px 11px;border-radius:10px;border:1px solid #d8dbe2;background:#fff;color:#14181f;font-size:12px;font-family:inherit;outline:none;transition:border-color .18s,box-shadow .18s}' +
    '.input:focus{border-color:#4f46e5;box-shadow:0 0 0 3px rgba(79,70,229,.18)}.input::placeholder{color:#9aa3b2}' +
    '.input[readonly]{color:#9aa3b2;cursor:default;background:#f4f5f7}' +
    'textarea.input{resize:vertical;min-height:50px}' +
    '.field-row{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}' +
    '.actions{display:flex;gap:6px;margin-top:4px}.actions .btn{flex:1}' +
    '.preview{width:100%;text-align:left}' +
    '.hidden{display:none!important}' +
    '.debug-section{border-top:1px solid #e7e9ee;margin-top:10px;padding-top:8px}' +
    '.debug-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:4px}' +
    '.debug-title{font-size:10px;font-weight:700;color:#9aa3b2;text-transform:uppercase;letter-spacing:.5px}' +
    '.debug-copy{padding:2px 6px;border-radius:4px;border:1px solid #e7e9ee;background:#f4f5f7;color:#9aa3b2;cursor:pointer;font-size:9px;font-family:inherit}' +
    '.debug-copy:hover{color:#14181f}' +
    '.debug-log{max-height:120px;overflow-y:auto;font-family:Consolas,monospace;font-size:9px;line-height:1.5;color:#9aa3b2;white-space:pre-wrap;word-break:break-all}' +
    '.debug-log .s{color:#4f46e5}.debug-log .ok{color:#22c55e}.debug-log .er{color:#e0483f}' +
    '</style>' +

    '<div class="panel">' +
    '<div class="header" id="hdr">' +
      '<div class="header-left"><span class="header-title">Swipe.ardy</span></div>' +
      '<div style="display:flex;gap:4px">' +
        '<button class="header-btn" id="minBtn" title="Minimize">&#9472;</button>' +
        '<button class="header-btn" id="closeBtn" title="Close">&#10005;</button>' +
      '</div>' +
    '</div>' +
    '<div class="body" id="pbody">' +
      '<div class="brand">' +
        '<div class="brand-icon">S</div>' +
        '<div class="brand-name">Swipe.ardy</div>' +
        '<span class="badge hidden" id="badge"></span>' +
      '</div>' +
      '<div id="sCheck" class="state"><div class="spinner"></div><p>Checking page...</p></div>' +
      '<div id="sUnsupported" class="state hidden"><div class="state-icon">&#9888;</div><p>This page is not supported.</p><p class="hint">Navigate to a LinkedIn, Twitter/X, or Pinterest page.</p></div>' +
      '<div id="sReady" class="state hidden">' +
        '<div class="state-icon">&#128196;</div>' +
        '<p>Ready to extract</p>' +
        '<button class="btn btn-primary" id="extractBtn" style="margin-top:12px">Extract the post</button>' +
        '<div class="divider"></div>' +
        '<button class="btn btn-ghost" id="scanBtn">Scan Page</button>' +
        '<p class="desc">Find and import all visible posts</p>' +
        '<div id="scanResults" class="scan-results hidden"><div class="divider"></div><p class="scan-count" id="scanCount"></p><div class="scan-actions"><button class="btn btn-secondary" id="rescanBtn">Rescan</button><button class="btn btn-primary" id="importBtn">Import All</button></div><p class="scan-status" id="scanStatus"></p></div>' +
      '</div>' +
      '<div id="sExtracting" class="state hidden"><div class="spinner"></div><p>Extracting...</p></div>' +
      '<div id="sPreview" class="state hidden"><form class="preview" id="pform"><div class="field"><label>Author</label><input class="input" id="fAuthor"></div><div class="field"><label>Caption</label><textarea class="input" id="fText" rows="3"></textarea></div><div class="field-row"><div class="field"><label>Likes</label><input type="number" class="input" id="fReactions"></div><div class="field"><label>Comments</label><input type="number" class="input" id="fComments"></div><div class="field"><label>Reposts</label><input type="number" class="input" id="fReposts"></div></div><div class="field"><label>Post URL</label><input class="input" id="fUrl" readonly></div><div class="field"><label>Image</label><input class="input" id="fImage" readonly></div><div class="field"><label>Date</label><input class="input" id="fDate" readonly></div><div class="actions"><button type="button" class="btn btn-secondary" id="reExtBtn">Re-extract</button><button type="button" class="btn btn-primary" id="saveBtn">Save to Swipe.ardy</button></div></form></div>' +
      '<div id="sSaving" class="state hidden"><div class="spinner"></div><p>Saving...</p></div>' +
      '<div id="sSuccess" class="state hidden"><div class="state-icon success">&#10003;</div><p>Saved!</p></div>' +
      '<div id="sError" class="state hidden"><div class="state-icon err">&#10007;</div><p id="errMsg"></p><button class="btn btn-secondary" id="retryBtn" style="margin-top:8px">Try Again</button></div>' +
      '<div class="debug-section"><div class="debug-head"><span class="debug-title">Debug</span><button class="debug-copy" id="dbgCopy">Copy</button></div><div class="debug-log" id="dbgLog"></div></div>' +
    '</div>' +
    '</div>';

  var $ = function (sel) { return shadow.querySelector(sel); };
  var panel = $('.panel');
  var body = $('#pbody');
  var scannedPosts = [];
  var currentPlatform = '';
  var minimized = false;

  function showState(name) {
    var all = shadow.querySelectorAll('.state');
    for (var i = 0; i < all.length; i++) all[i].classList.add('hidden');
    var target = shadow.getElementById(name);
    if (target) target.classList.remove('hidden');
  }

  function fillForm(data) {
    $('#fAuthor').value = data.author || '';
    $('#fText').value = data.text || '';
    $('#fReactions').value = data.reactions || 0;
    $('#fComments').value = data.comments || 0;
    $('#fReposts').value = data.reposts || 0;
    $('#fUrl').value = data.postUrl || '';
    $('#fImage').value = data.image || '';
    $('#fDate').value = data.date || '';
  }

  function setBadge(platform) {
    var b = $('#badge');
    b.textContent = platform;
    b.className = 'badge ' + (platform === 'LinkedIn' ? 'linkedin' : platform === 'Pinterest' ? 'pinterest' : 'twitter');
    b.classList.remove('hidden');
  }

  function now() { return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }

  function clog(label, detail, cls) {
    var log = $('#dbgLog');
    var line = document.createElement('div');
    var html = '<span class="s">[' + now() + '] ' + label + '</span>';
    if (detail !== undefined) {
      var str = typeof detail === 'object' ? JSON.stringify(detail, null, 2) : String(detail);
      html += '<span class="' + (cls || '') + '">' + escHtml(str) + '</span>';
    }
    line.innerHTML = html;
    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
  }

  function escHtml(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  function showError(msg) {
    clog('ERROR', msg, 'er');
    $('#errMsg').textContent = msg;
    showState('sError');
  }

  function init() {
    showState('sReady');
    scannedPosts = [];
    $('#scanResults').classList.add('hidden');
    clog('init', 'Panel opened');
  }

  // Drag
  var dragging = false, startX = 0, startY = 0, baseX = 0, baseY = 0;
  var hdr = $('#hdr');
  hdr.addEventListener('pointerdown', function (e) {
    if (e.target.closest('.header-btn')) return;
    dragging = true;
    startX = e.clientX; startY = e.clientY;
    var r = host.getBoundingClientRect();
    baseX = r.left; baseY = r.top;
    hdr.setPointerCapture(e.pointerId);
  });
  hdr.addEventListener('pointermove', function (e) {
    if (!dragging) return;
    host.style.left = (baseX + e.clientX - startX) + 'px';
    host.style.top = (baseY + e.clientY - startY) + 'px';
    host.style.right = 'auto';
  });
  hdr.addEventListener('pointerup', function () { dragging = false; try { hdr.releasePointerCapture(event.pointerId); } catch(e) {} });

  // Minimize
  $('#minBtn').addEventListener('click', function () {
    minimized = !minimized;
    body.classList.toggle('collapsed', minimized);
    $('#minBtn').innerHTML = minimized ? '&#9633;' : '&#9472;';
    $('#minBtn').title = minimized ? 'Restore' : 'Minimize';
  });

  // Close
  $('#closeBtn').addEventListener('click', function () { host.remove(); window.__SWIPEARDY_PANEL__ = false; });

  // Scan
  $('#scanBtn').addEventListener('click', function () {
    clog('SCAN', 'Scanning...');
    $('#scanBtn').disabled = true; $('#scanBtn').textContent = 'Scanning...';
    chrome.runtime.sendMessage({ type: 'SWIPEAR:DY_SCAN_PAGE' }, function (resp) {
      $('#scanBtn').disabled = false; $('#scanBtn').textContent = 'Scan Page';
      if (chrome.runtime.lastError || !resp || !resp.ok) { clog('SCAN', chrome.runtime.lastError ? chrome.runtime.lastError.message : 'Failed', 'er'); return; }
      scannedPosts = resp.posts || [];
      clog('SCAN', 'Found ' + scannedPosts.length + ' posts', 'ok');
      if (scannedPosts.length > 0 && scannedPosts[0].platform) { currentPlatform = scannedPosts[0].platform; setBadge(scannedPosts[0].platform); }
      $('#scanCount').textContent = 'Found ' + scannedPosts.length + ' post' + (scannedPosts.length !== 1 ? 's' : '');
      $('#importBtn').textContent = 'Import ' + scannedPosts.length + ' Post' + (scannedPosts.length !== 1 ? 's' : '');
      $('#scanResults').classList.remove('hidden');
      $('#scanStatus').textContent = '';
    });
  });

  // Rescan
  $('#rescanBtn').addEventListener('click', function () { $('#scanBtn').click(); });

  // Import
  $('#importBtn').addEventListener('click', function () {
    if (!scannedPosts.length) return;
    clog('IMPORT', 'Importing ' + scannedPosts.length + ' posts...');
    $('#importBtn').disabled = true; $('#importBtn').textContent = 'Importing...';
    $('#scanStatus').textContent = 'Saving...';
    chrome.runtime.sendMessage({ type: 'SWIPEAR:DY_BULK_IMPORT', posts: scannedPosts }, function (resp) {
      $('#importBtn').disabled = false; $('#importBtn').textContent = 'Import ' + scannedPosts.length + ' Post' + (scannedPosts.length !== 1 ? 's' : '');
      if (resp && resp.ok) {
        var msg = 'Imported ' + (resp.saved || 0) + ' post' + ((resp.saved || 0) !== 1 ? 's' : '');
        if ((resp.duplicates || 0) > 0) msg += ' (' + resp.duplicates + ' duplicate' + (resp.duplicates !== 1 ? 's' : '') + ' skipped)';
        $('#scanStatus').textContent = msg; clog('IMPORT', msg, 'ok');
      } else { $('#scanStatus').textContent = 'Import failed'; clog('IMPORT', 'Failed', 'er'); }
    });
  });

  // Extract
  $('#extractBtn').addEventListener('click', function () {
    showState('sExtracting'); clog('EXTRACT', 'Extracting...');
    chrome.runtime.sendMessage({ type: 'EXTRACT' }, function (resp) {
      if (chrome.runtime.lastError || !resp) { clog('EXTRACT', chrome.runtime.lastError ? chrome.runtime.lastError.message : 'No response', 'er'); showError('Could not communicate with the page.'); return; }
      if (!resp.ok) { clog('EXTRACT', resp.error, 'er'); showError(resp.error || 'Extraction failed.'); return; }
      fillForm(resp.data);
      if (resp.data && resp.data.platform) { currentPlatform = resp.data.platform; setBadge(resp.data.platform); }
      clog('EXTRACT', 'Done', 'ok'); showState('sPreview');
    });
  });

  // Re-extract
  $('#reExtBtn').addEventListener('click', function () { $('#extractBtn').click(); });

  // Save
  $('#saveBtn').addEventListener('click', function () {
    var data = {
      author: $('#fAuthor').value.trim(), text: $('#fText').value.trim(),
      reactions: parseInt($('#fReactions').value) || 0,
      comments: parseInt($('#fComments').value) || 0,
      reposts: parseInt($('#fReposts').value) || 0,
      postUrl: $('#fUrl').value.trim(), image: $('#fImage').value.trim(),
      date: $('#fDate').value.trim(), platform: currentPlatform,
      filters: {}
    };
    if (!data.author) { showError('Author name is required.'); return; }
    data.filters = { Platform: currentPlatform };
    clog('SAVE', 'Saving...');
    showState('sSaving');
    function doSave(attempt) {
      chrome.runtime.sendMessage({ type: 'SAVE_SWIPE', data: data }, function (resp) {
        if (chrome.runtime.lastError || !resp) {
          if (attempt === 1) { setTimeout(function () { doSave(2); }, 500); return; }
          showError('Could not reach the server.'); return;
        }
        if (!resp.ok) { showError(resp.error || 'Failed.'); return; }
        showState('sSuccess');
        clog('SAVED', 'Done', 'ok');
      });
    }
    doSave(1);
  });

  // Retry
  $('#retryBtn').addEventListener('click', function () { init(); });

  // Debug copy
  $('#dbgCopy').addEventListener('click', function () {
    var text = $('#dbgLog').innerText;
    navigator.clipboard.writeText(text).then(function () { clog('[copy]', 'Copied', 'ok'); });
  });

  init();
})();
