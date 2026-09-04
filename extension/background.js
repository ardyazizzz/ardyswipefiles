var SB_URL = 'https://dmhiitzunsdqyxopqsby.supabase.co/rest/v1';
var SB_KEY = 'sb_publishable_ia350OuBQjG4Dw5V623eJw_m9Ftgn9F';
var SB_HEADERS = { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json' };

var SB_STORAGE_URL = 'https://dmhiitzunsdqyxopqsby.supabase.co/storage/v1';
var STORAGE_BUCKET = 'swipe-assets';
var STORAGE_URL_CACHE = {};

function isStoredMediaUrl(url) {
  return url.indexOf('/storage/v1/object/public/' + STORAGE_BUCKET + '/') !== -1
    || url.indexOf('/storage/v1/object/' + STORAGE_BUCKET + '/') !== -1;
}

function isEmbedLink(url) {
  return /youtube\.com|youtu\.be|vimeo\.com/i.test(url);
}

function mediaExt(url, type) {
  if (type) {
    if (type === 'image/jpeg') return 'jpg';
    if (type === 'image/png') return 'png';
    if (type === 'image/gif') return 'gif';
    if (type === 'image/webp') return 'webp';
    if (type === 'video/mp4') return 'mp4';
    if (type === 'video/webm') return 'webm';
  }
  var m = /\.(jpg|jpeg|png|gif|webp|mp4|webm|mov)(?:\?|$)/i.exec(url);
  if (m) { var e = m[1].toLowerCase(); return e === 'jpeg' ? 'jpg' : e; }
  return '';
}

function fetchMedia(url) {
  var ctrl = new AbortController();
  var timer = setTimeout(function () { ctrl.abort(); }, 20000);
  return fetch(url, { cache: 'no-store', signal: ctrl.signal }).then(function (res) {
    clearTimeout(timer);
    if (!res.ok) throw new Error('download ' + res.status);
    return res.arrayBuffer().then(function (buf) {
      return { buf: buf, type: (res.headers.get('content-type') || '').split(';')[0].toLowerCase().trim() };
    });
  }).catch(function (e) { clearTimeout(timer); throw e; });
}

function uploadMedia(path, buf, contentType) {
  return fetch(SB_STORAGE_URL + '/object/' + STORAGE_BUCKET + '/' + path, {
    method: 'POST',
    headers: {
      apikey: SB_KEY,
      Authorization: 'Bearer ' + SB_KEY,
      'Content-Type': contentType || 'application/octet-stream'
    },
    body: buf
  }).then(function (res) {
    // The path contains a content hash, so a 409 means another capture
    // already uploaded the exact same bytes. Treat that as success while
    // keeping anonymous Storage access insert-only (no public overwrite).
    if (!res.ok && res.status !== 409) throw new Error('upload ' + res.status);
    return res.text();
  });
}

function mediaHash(buf) {
  return crypto.subtle.digest('SHA-256', buf).then(function (digest) {
    return Array.prototype.map.call(new Uint8Array(digest), function (b) {
      return b.toString(16).padStart(2, '0');
    }).join('');
  });
}

function storeOneMedia(url, swipeId, idx) {
  url = (url || '').trim();
  if (!url || isStoredMediaUrl(url) || isEmbedLink(url)) return Promise.resolve(url);
  if (STORAGE_URL_CACHE[url]) return Promise.resolve(STORAGE_URL_CACHE[url]);
  return fetchMedia(url).then(function (r) {
    var ext = mediaExt(url, r.type);
    if (!ext) throw new Error('unsupported type: ' + r.type);
    return mediaHash(r.buf).then(function (hash) {
      var path = 's' + swipeId + (idx > 0 ? '_' + idx : '') + '_' + hash.slice(0, 20) + '.' + ext;
      return uploadMedia(path, r.buf, r.type).then(function () {
        var pub = SB_STORAGE_URL + '/object/public/' + STORAGE_BUCKET + '/' + path;
        STORAGE_URL_CACHE[url] = pub;
        return pub;
      });
    });
  }).catch(function (e) {
    console.warn('[swipeardy] media store failed (' + url.slice(0, 100) + '):', e.message);
    return url;
  });
}

function storeItemMedia(item) {
  var image = (item.image || '').trim();
  if (!image) return Promise.resolve(item);
  var urls = image.split(',').map(function (u) { return u.trim(); }).filter(function (u) { return u; });
  if (urls.length === 0) return Promise.resolve(item);
  var tasks = [];
  for (var i = 0; i < urls.length; i++) tasks.push(storeOneMedia(urls[i], item.id, i));
  return Promise.all(tasks).then(function (stored) {
    item.image = stored.join(',');
    return item;
  });
}

var STORAGE_SEEN_KEY = 'swipeardyBookmarksSeen';
var STORAGE_BASELINE_KEY = 'swipeardyBaselineEstablished';
var STORAGE_VERSION_KEY = 'swipeardyCaptureVersion';
var CAPTURE_VERSION = 1;
var STORAGE_TEMPLATE_KEY = 'swipeardyRefreshTemplate';

var BOOKMARK_POLL_ALARM = 'swipeardyBookmarkPoll';
var BOOKMARK_POLL_PERIOD_MINUTES = 2;
var BOOKMARK_POLL_THROTTLE_MS = 30 * 1000;
var STORAGE_LAST_POLL_KEY = 'swipeardyLastPollAt';
var STORAGE_BOOKMARK_AUTO_SAVE_KEY = 'swipeardyBookmarkAutoSaveEnabled';
var lastTabId = null;

function getBookmarkAutoSaveEnabled() {
  return new Promise(function (resolve) {
    var defaults = {};
    defaults[STORAGE_BOOKMARK_AUTO_SAVE_KEY] = true;
    chrome.storage.local.get(defaults, function (data) {
      resolve(data[STORAGE_BOOKMARK_AUTO_SAVE_KEY] !== false);
    });
  });
}

function syncBookmarkPollAlarm(enabled) {
  return new Promise(function (resolve) {
    if (enabled) {
      ensureBookmarkPollAlarm();
      resolve();
      return;
    }
    chrome.alarms.clear(BOOKMARK_POLL_ALARM, function () { resolve(); });
  });
}

function setBookmarkAutoSaveEnabled(enabled) {
  enabled = enabled !== false;
  return getBookmarkAutoSaveEnabled().then(function (wasEnabled) {
    return new Promise(function (resolve) {
      var update = {};
      update[STORAGE_BOOKMARK_AUTO_SAVE_KEY] = enabled;
      if (enabled && !wasEnabled) {
        // The first snapshot after resuming becomes the new baseline. Tweets
        // bookmarked while paused are not imported retroactively.
        update[STORAGE_BASELINE_KEY] = false;
        update[STORAGE_LAST_POLL_KEY] = 0;
      }
      chrome.storage.local.set(update, function () {
        syncBookmarkPollAlarm(enabled).then(function () {
          if (enabled && !wasEnabled) {
            maybePollBookmarks().then(function () { resolve(enabled); });
          } else {
            resolve(enabled);
          }
        });
      });
    });
  });
}

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (!message) return;
  if (message.type === 'SWIPEAR:DY_BOOKMARK_AUTO_GET') {
    getBookmarkAutoSaveEnabled().then(function (enabled) {
      sendResponse({ ok: true, enabled: enabled });
    });
    return true;
  }
  if (message.type === 'SWIPEAR:DY_BOOKMARK_AUTO_SET') {
    setBookmarkAutoSaveEnabled(message.enabled !== false).then(function (enabled) {
      sendResponse({ ok: true, enabled: enabled });
    });
    return true;
  }
  if (message.type === 'SAVE_SWIPE') {
    var item = {
      id: Date.now(),
      author: message.data.author,
      date: message.data.date || new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
      platform: message.data.platform,
      text: message.data.text,
      image: message.data.image || '',
      postUrl: message.data.postUrl,
      reactions: message.data.reactions || 0,
      comments: message.data.comments || 0,
      reposts: message.data.reposts || 0,
      filters: message.data.filters || {}
    };
    storeItemMedia(item).then(function (storedItem) {
      return fetch(SB_URL + '/swipes', { method: 'POST', headers: SB_HEADERS, body: JSON.stringify(storedItem) });
    }).then(function (res) {
      return res.text().then(function (body) {
        if (!res.ok) throw new Error('HTTP ' + res.status + ' ΓÇö ' + body);
        sendResponse({ ok: true, status: res.status, body: body });
      });
    }).catch(function (err) { sendResponse({ ok: false, error: err.message }); });
    return true;
  }

  if (message.type === 'SWIPEAR:DY_BOOKMARK') {
    handleBookmarkSave(message, sendResponse);
    return true;
  }
  if (message.type === 'SWIPEAR:DY_BOOKMARK_BATCH') {
    handleBookmarkBatch(message.bookmarks);
    return false;
  }
  if (message.type === 'SWIPEAR:DY_REFRESH_TEMPLATE') {
    saveRefreshTemplate(message.url, message.authorization);
    return false;
  }
  if (message.type === 'SWIPEAR:DY_BULK_IMPORT') {
    handleBulkImport(message.posts).then(sendResponse);
    return true;
  }
  var targetTabId = lastTabId || (sender.tab && sender.tab.id);
  if ((message.type === 'EXTRACT' || message.type === 'SWIPEAR:DY_SCAN_PAGE') && targetTabId) {
    chrome.tabs.sendMessage(targetTabId, message, function (resp) {
      if (resp) { sendResponse(resp); }
      else { sendResponse({ ok: false, error: 'No response from page' }); }
    });
    return true;
  }
});

function handleBookmarkSave(msg, sendResponse) {
  getBookmarkAutoSaveEnabled().then(function (enabled) {
    if (!enabled) {
      return markSeen([msg.tweetId]).then(function () {
        sendResponse({ ok: true, paused: true });
      });
    }
    return trySaveBookmark(buildBookmarkItem(msg), msg.tweetId).then(function (result) {
      sendResponse(result);
    });
  }).catch(function (err) {
    sendResponse({ ok: false, error: err.message });
  });
}

function buildBookmarkItem(msg) {
  var tm = msg.tweetMeta || {};
  var date = '';
  if (tm.createdAt) {
    var d = new Date(tm.createdAt);
    if (!isNaN(d.getTime())) date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }
  if (!date) date = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  return {
    id: Date.now(),
    author: tm.authorName || '',
    date: date,
    platform: 'X',
    text: tm.caption || '',
    image: (tm.imageUrls && tm.imageUrls.length > 0) ? tm.imageUrls.filter(function(u){ return !/^blob:/i.test(u); }).join(',') : (msg.imageUrl || msg.videoUrl || (tm.videoUrl || '')),
    postUrl: msg.pageUrl,
    reactions: typeof tm.reactions === 'number' ? tm.reactions : 0,
    comments: typeof tm.comments === 'number' ? tm.comments : 0,
    reposts: typeof tm.reposts === 'number' ? tm.reposts : 0,
    filters: { Platform: 'X', Source: 'x:bookmark' }
  };
}

function trySaveBookmark(item, tweetId, opts) {
  opts = opts || {};
  return doDedupCheck(item.postUrl).then(function (isDup) {
    if (isDup) {
      if (tweetId) return markSeen([tweetId]).then(function () { return { ok: true, duplicate: true }; });
      return { ok: true, duplicate: true };
    }
    return storeItemMedia(item).then(function (storedItem) {
      return fetch(SB_URL + '/swipes', { method: 'POST', headers: SB_HEADERS, body: JSON.stringify(storedItem) });
    }).then(function (res) {
      return res.text().then(function (body) {
        if (!res.ok) throw new Error('HTTP ' + res.status + ' ΓÇö ' + body);
        return Promise.resolve().then(function () {
          if (tweetId) return markSeen([tweetId]);
        }).then(function () {
          return { ok: true, duplicate: false };
        });
      });
    });
  });
}

function batchDedupCheck(urls) {
  if (!urls || urls.length === 0) return Promise.resolve({});
  var encoded = urls.map(function (u) { return encodeURIComponent(u); }).join(',');
  return fetch(SB_URL + '/swipes?postUrl=in.(' + encoded + ')&select=postUrl', {
    headers: SB_HEADERS
  }).then(function (res) {
    return res.text().then(function (text) {
      if (!res.ok) return {};
      try {
        var rows = JSON.parse(text);
        var set = {};
        if (Array.isArray(rows)) {
          for (var i = 0; i < rows.length; i++) {
            if (rows[i] && rows[i].postUrl) set[rows[i].postUrl] = true;
          }
        }
        return set;
      } catch (e) { return {}; }
    });
  }).catch(function () { return {}; });
}

function doDedupCheck(postUrl) {
  if (!postUrl) return Promise.resolve(false);
  return fetch(SB_URL + '/swipes?postUrl=eq.' + encodeURIComponent(postUrl) + '&select=id&limit=1', {
    headers: SB_HEADERS
  }).then(function (res) {
    return res.text().then(function (text) {
      if (!res.ok) return false;
      try { var arr = JSON.parse(text); return Array.isArray(arr) && arr.length > 0; }
      catch (e) { return false; }
    });
  }).catch(function () { return false; });
}

function syncBookmarkToSupabase(b, forceOpt) {
  forceOpt = forceOpt || {};
  var tm = b.tweetMeta || {};
  var hasMedia = (Array.isArray(tm.imageUrls) && tm.imageUrls.length > 0) || tm.videoUrl || b.imageUrl || b.videoUrl;
  var hasText = !!(tm.caption || b.caption || '').trim();
  if (!hasMedia && !hasText) return Promise.resolve({ ok: false, dismissed: true });

  var item = buildBookmarkItem({
    tweetMeta: {
      authorName: b.authorName || (tm.authorName || ''),
      authorHandle: b.authorHandle || (tm.authorHandle || ''),
      authorAvatarUrl: b.authorAvatarUrl || (tm.authorAvatarUrl || ''),
      caption: b.caption || (tm.caption || ''),
      imageUrls: b.imageUrls || (tm.imageUrls || []),
      videoUrl: b.videoUrl || (tm.videoUrl || null),
      posterUrl: b.posterUrl || (tm.posterUrl || ''),
      quoted: b.quoted || (tm.quoted || null),
      createdAt: b.createdAt || (tm.createdAt || ''),
      reactions: typeof b.reactions === 'number' ? b.reactions : (typeof tm.reactions === 'number' ? tm.reactions : 0),
      comments: typeof b.comments === 'number' ? b.comments : (typeof tm.comments === 'number' ? tm.comments : 0),
      reposts: typeof b.reposts === 'number' ? b.reposts : (typeof tm.reposts === 'number' ? tm.reposts : 0)
    },
    pageUrl: b.tweetUrl || '',
    imageUrl: b.imageUrl || ''
  });

  return doDedupCheck(item.postUrl).then(function (isDup) {
    if (isDup) return { ok: true, duplicate: true };
    return storeItemMedia(item).then(function (storedItem) {
      return fetch(SB_URL + '/swipes', { method: 'POST', headers: SB_HEADERS, body: JSON.stringify(storedItem) });
    }).then(function (res) {
      return res.text().then(function (body) {
        if (!res.ok) throw new Error('HTTP ' + res.status + ' ΓÇö ' + body);
        return { ok: true, duplicate: false };
      });
    });
  }).catch(function (err) { throw err; });
}

function readSeenSet() {
  return new Promise(function (resolve) {
    chrome.storage.local.get([STORAGE_SEEN_KEY, STORAGE_BASELINE_KEY, STORAGE_VERSION_KEY], function (data) {
      var arr = data[STORAGE_SEEN_KEY];
      var seen = {};
      if (Array.isArray(arr)) {
        for (var i = 0; i < arr.length; i++) { if (arr[i]) seen[arr[i]] = true; }
      }
      resolve({
        seen: seen,
        baseline: !!data[STORAGE_BASELINE_KEY],
        version: Number(data[STORAGE_VERSION_KEY]) || 0
      });
    });
  });
}

function writeSeenSet(seenKeys, opts) {
  opts = opts || {};
  var update = {};
  update[STORAGE_SEEN_KEY] = seenKeys;
  if (typeof opts.baseline === 'boolean') update[STORAGE_BASELINE_KEY] = opts.baseline;
  if (typeof opts.version === 'number') update[STORAGE_VERSION_KEY] = opts.version;
  return new Promise(function (resolve) {
    chrome.storage.local.set(update, function () { resolve(); });
  });
}

function markSeen(ids) {
  if (!ids || !ids.length) return Promise.resolve();
  return readSeenSet().then(function (state) {
    var changed = false;
    for (var i = 0; i < ids.length; i++) {
      if (ids[i] && !state.seen.hasOwnProperty(ids[i])) {
        state.seen[ids[i]] = true;
        changed = true;
      }
    }
    if (changed) return writeSeenSet(Object.keys(state.seen));
  });
}

function handleBookmarkBatch(bookmarks) {
  if (!Array.isArray(bookmarks) || bookmarks.length === 0) return;

  getBookmarkAutoSaveEnabled().then(function (enabled) {
    if (!enabled) {
      return markSeen(bookmarks.map(function (bookmark) {
        return bookmark && bookmark.tweetId;
      }).filter(Boolean));
    }
    return readSeenSet();
  }).then(function (state) {
    if (!state) return;
    if (!state.baseline || state.version !== CAPTURE_VERSION) {
      for (var i = 0; i < bookmarks.length; i++) {
        if (bookmarks[i] && bookmarks[i].tweetId) state.seen[bookmarks[i].tweetId] = true;
      }
      return writeSeenSet(Object.keys(state.seen), { baseline: true, version: CAPTURE_VERSION });
    }

    var toImport = [];
    for (var j = 0; j < bookmarks.length; j++) {
      var b = bookmarks[j];
      if (b && b.tweetId && !state.seen.hasOwnProperty(b.tweetId)) toImport.push(b);
    }

    function importNext(idx) {
      if (idx >= toImport.length) {
        return writeSeenSet(Object.keys(state.seen));
      }
      return getBookmarkAutoSaveEnabled().then(function (enabled) {
        if (!enabled) {
          for (var remaining = idx; remaining < toImport.length; remaining++) {
            state.seen[toImport[remaining].tweetId] = true;
          }
          return writeSeenSet(Object.keys(state.seen));
        }
        var b = toImport[idx];
        return syncBookmarkToSupabase(b).then(function () {
          state.seen[b.tweetId] = true;
          return importNext(idx + 1);
        }).catch(function () {
          state.seen[b.tweetId] = true;
          return importNext(idx + 1);
        });
      });
    }

    return importNext(0);
  }).catch(function (err) { console.warn('[swipeardy] batch sync failed:', err); });
}

function saveRefreshTemplate(url, authorization) {
  if (!url) return;
  return new Promise(function (resolve) {
    var key = {};
    key[STORAGE_TEMPLATE_KEY] = null;
    chrome.storage.local.get(key, function (data) {
      var existing = data[STORAGE_TEMPLATE_KEY];
      var next = {
        url: url,
        authorization: authorization || (existing && existing.authorization) || null,
        updatedAt: Date.now()
      };
      var set = {};
      set[STORAGE_TEMPLATE_KEY] = next;
      chrome.storage.local.set(set, resolve);
    });
  });
}

function ensureBookmarkPollAlarm() {
  chrome.alarms.create(BOOKMARK_POLL_ALARM, { periodInMinutes: BOOKMARK_POLL_PERIOD_MINUTES });
}

function maybePollBookmarks() {
  return getBookmarkAutoSaveEnabled().then(function (enabled) {
    if (!enabled) return;
    return new Promise(function (resolve) {
      var key = {};
      key[STORAGE_LAST_POLL_KEY] = 0;
      chrome.storage.local.get(key, function (data) {
        var last = data[STORAGE_LAST_POLL_KEY] || 0;
        var now = Date.now();
        if (now - last < BOOKMARK_POLL_THROTTLE_MS) { resolve(); return; }
        var set = {};
        set[STORAGE_LAST_POLL_KEY] = now;
        chrome.storage.local.set(set, function () {
          pollBookmarksRefresh().then(resolve).catch(resolve);
        });
      });
    });
  });
}

chrome.runtime.onInstalled.addListener(function () {
  getBookmarkAutoSaveEnabled().then(syncBookmarkPollAlarm);
});
chrome.runtime.onStartup.addListener(function () {
  getBookmarkAutoSaveEnabled().then(syncBookmarkPollAlarm);
});

chrome.action.onClicked.addListener(function (tab) {
  if (!tab || !tab.id) return;
  lastTabId = tab.id;
  chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/panel.js'] }).catch(function () {});
});

chrome.alarms.onAlarm.addListener(function (alarm) {
  if (alarm && alarm.name === BOOKMARK_POLL_ALARM) {
    maybePollBookmarks();
  }
});

chrome.windows.onFocusChanged.addListener(function (windowId) {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  chrome.tabs.query({active: true, windowId: windowId}, function (tabs) {
    if (tabs.length === 0) return;
    var url = tabs[0].url;
    if (url && url.indexOf('x.com') === -1 && url.indexOf('twitter.com') === -1) return;
    maybePollBookmarks();
  });
});

function pollBookmarksRefresh() {
  return new Promise(function (resolve) {
    var key = {};
    key[STORAGE_TEMPLATE_KEY] = null;
    chrome.storage.local.get(key, function (data) {
      var template = data[STORAGE_TEMPLATE_KEY];
      if (!template || !template.url || !template.authorization) { resolve(); return; }

      chrome.cookies.get({ url: 'https://x.com/', name: 'ct0' }, function (cookie) {
        if (!cookie || !cookie.value) { resolve(); return; }
        fetch(template.url, {
          method: 'GET',
          credentials: 'include',
          headers: {
            authorization: template.authorization,
            'x-csrf-token': cookie.value,
            'x-twitter-active-user': 'yes',
            'x-twitter-auth-type': 'OAuth2Session',
            'x-twitter-client-language': 'en',
            accept: '*/*'
          }
        }).then(function (res) {
          if (!res.ok) { resolve(); return; }
          return res.json().then(function (json) {
            var entries = pollExtractBookmarkEntries(json);
            if (entries.length > 0) handleBookmarkBatch(entries);
            resolve();
          });
        }).catch(function (err) {
          console.warn('[swipeardy] poll fetch failed:', err);
          resolve();
        });
      });
    });
  });
}

function pollExtractBookmarkEntries(json) {
  var out = [];
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (var i = 0; i < node.length; i++) walk(node[i]);
      return;
    }
    if (typeof node.entryId === 'string' && node.entryId.indexOf('tweet-') === 0) {
      var wrapped = node.content && node.content.itemContent
        && node.content.itemContent.tweet_results
        && node.content.itemContent.tweet_results.result;
      if (wrapped) {
        var parsed = pollParseTweetForBookmark(wrapped);
        if (parsed) out.push(parsed);
      }
    }
    var keys = Object.keys(node);
    for (var j = 0; j < keys.length; j++) {
      if (keys[j] === '__typename') continue;
      walk(node[keys[j]]);
    }
  }
  walk(json);
  return out;
}

function pollExtractTweetCore(result) {
  if (!result || typeof result !== 'object') return null;
  var t = result.tweet || result;
  var legacy = t.legacy;
  if (!legacy || !legacy.id_str) return null;
  var userResult = t.core && t.core.user_results && t.core.user_results.result;
  var userCore = (userResult && userResult.core) || {};
  var userLegacy = (userResult && userResult.legacy) || {};
  var screenName = userCore.screen_name || userLegacy.screen_name || '';
  var displayName = userCore.name || userLegacy.name || '';
  var avatarUrl = (userResult && userResult.avatar && userResult.avatar.image_url)
    || userLegacy.profile_image_url_https || '';
  var mediaList = (legacy.extended_entities && legacy.extended_entities.media)
    || (legacy.entities && legacy.entities.media) || [];
  var imageUrls = [];
  for (var i = 0; i < mediaList.length; i++) {
    var m = mediaList[i];
    if (m && m.type === 'photo' && m.media_url_https) imageUrls.push(m.media_url_https + '?format=jpg&name=large');
  }
  return {
    authorName: displayName,
    authorHandle: screenName ? '@' + screenName : '',
    authorAvatarUrl: avatarUrl,
    caption: legacy.full_text || '',
    imageUrls: imageUrls,
    createdAt: legacy.created_at || ''
  };
}

function pollParseTweetForBookmark(result) {
  var t = result.tweet || result;
  var legacy = t.legacy;
  if (!legacy || !legacy.id_str) return null;
  var userResult = t.core && t.core.user_results && t.core.user_results.result;
  if (!userResult) return null;
  var userCore = userResult.core || {};
  var userLegacy = userResult.legacy || {};
  var screenName = userCore.screen_name || userLegacy.screen_name;
  var displayName = userCore.name || userLegacy.name || '';
  var avatarUrl = (userResult.avatar && userResult.avatar.image_url)
    || userLegacy.profile_image_url_https
    || '';
  if (!screenName) return null;

  var tweetId = legacy.id_str;
  var tweetUrl = 'https://x.com/' + screenName + '/status/' + tweetId;
  var mediaList = (legacy.extended_entities && legacy.extended_entities.media)
    || (legacy.entities && legacy.entities.media)
    || [];
  var imageUrls = [];
  var videoUrl = null;
  var posterUrl = '';
  for (var i = 0; i < mediaList.length; i++) {
    var m = mediaList[i];
    if (!m) continue;
    if (m.type === 'photo' && m.media_url_https) {
      imageUrls.push(m.media_url_https + '?format=jpg&name=large');
    } else if ((m.type === 'video' || m.type === 'animated_gif') && m.video_info && Array.isArray(m.video_info.variants)) {
      var best = null;
      for (var j = 0; j < m.video_info.variants.length; j++) {
        var v = m.video_info.variants[j];
        if (!v || v.content_type !== 'video/mp4' || !v.url) continue;
        var br = typeof v.bitrate === 'number' ? v.bitrate : 0;
        if (!best || br > best.bitrate) best = { url: v.url, bitrate: br };
      }
      if (best && !videoUrl) { videoUrl = best.url; posterUrl = m.media_url_https || ''; }
    }
  }
  if (imageUrls.length === 0 && !videoUrl && !(legacy.full_text || '').trim()) return null;
  return {
    tweetId: tweetId,
    tweetUrl: tweetUrl,
    authorName: displayName,
    authorHandle: '@' + screenName,
    authorAvatarUrl: avatarUrl,
    caption: legacy.full_text || '',
    imageUrls: imageUrls,
    videoUrl: videoUrl,
    posterUrl: posterUrl,
    quoted: pollExtractTweetCore(t.quoted_status_result && t.quoted_status_result.result),
    createdAt: legacy.created_at || '',
    reactions: legacy.favorite_count || 0,
    comments: legacy.reply_count || 0,
    reposts: legacy.retweet_count || 0
  };
}

function handleBulkImport(posts) {
  if (!Array.isArray(posts) || posts.length === 0) {
    return Promise.resolve({ ok: true, saved: 0, duplicates: 0 });
  }

  var urlsToCheck = [];
  for (var i = 0; i < posts.length; i++) {
    if (posts[i].postUrl) urlsToCheck.push(posts[i].postUrl);
  }

  if (urlsToCheck.length === 0) {
    return Promise.resolve({ ok: true, saved: 0, duplicates: 0 });
  }

  return batchDedupCheck(urlsToCheck).then(function (existingSet) {
    var toSave = [];
    for (var j = 0; j < posts.length; j++) {
      if (posts[j].postUrl && existingSet.hasOwnProperty(posts[j].postUrl)) continue;
      toSave.push(j);
    }

    var duplicates = posts.length - toSave.length;
    var saved = 0;
    var CHUNK = 5;

    function saveChunk(startIdx) {
      if (startIdx >= toSave.length) {
        return Promise.resolve({ ok: true, saved: saved, duplicates: duplicates });
      }
      var end = Math.min(startIdx + CHUNK, toSave.length);
      var batch = [];
      for (var k = startIdx; k < end; k++) {
        var idx = toSave[k];
        var p = posts[idx];
        var item = {
          id: Date.now() + idx,
          author: p.author || '',
          date: p.date || new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
          platform: p.platform || '',
          text: p.text || '',
          image: (p.images && p.images.length > 0) ? p.images.join(',') : (p.image || ''),
          postUrl: p.postUrl || '',
          reactions: p.reactions || 0,
          comments: p.comments || 0,
          reposts: p.reposts || 0,
          filters: p.filters || {}
        };
        batch.push(
          storeItemMedia(item).then(function (storedItem) {
            return fetch(SB_URL + '/swipes', { method: 'POST', headers: SB_HEADERS, body: JSON.stringify(storedItem) });
          }).then(function (res) {
            if (res.ok) saved++;
          }).catch(function () {})
        );
      }
      return Promise.all(batch).then(function () {
        return saveChunk(startIdx + CHUNK);
      });
    }

    return saveChunk(0);
  });
}
