(function () {
  if (window.__SWIPEARDY_WATCHER__) return;
  window.__SWIPEARDY_WATCHER__ = true;
  console.log('[swipeardy-import] watcher: loaded');

  var BOOKMARK_TESTID = 'bookmark';

  var tweetVideoCache = {};
  var tweetThreadCache = {};
  var tweetQuotedCache = {};
  var accumulatedBookmarks = {};
  var accumulatedBookmarksCount = 0;

  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    var data = event.data;
    if (!data || data.source !== 'swipeardy-interceptor') return;
    if (data.type === 'tweet-videos' && Array.isArray(data.videos)) {
      for (var i = 0; i < data.videos.length; i++) {
        var pair = data.videos[i];
        if (pair[0] && pair[1] && pair[1].videoUrl) tweetVideoCache[pair[0]] = pair[1];
      }
    }
    if (data.type === 'thread-cache' && Array.isArray(data.threads)) {
      for (var i = 0; i < data.threads.length; i++) {
        var t = data.threads[i];
        if (t[0] && Array.isArray(t[1]) && t[1].length > 1) tweetThreadCache[t[0]] = t[1];
      }
    }
    if (data.type === 'quoted-cache' && Array.isArray(data.quoted)) {
      for (var i = 0; i < data.quoted.length; i++) {
        var q = data.quoted[i];
        if (q[0] && q[1]) tweetQuotedCache[q[0]] = q[1];
      }
    }
    if (data.type === 'bookmark-batch' && Array.isArray(data.bookmarks)) {
      for (var i = 0; i < data.bookmarks.length; i++) {
        var b = data.bookmarks[i];
        if (b && b.tweetId && !accumulatedBookmarks.hasOwnProperty(b.tweetId)) {
          accumulatedBookmarks[b.tweetId] = b;
          accumulatedBookmarksCount++;
        }
      }
      chrome.runtime.sendMessage({
        type: 'SWIPEAR:DY_BOOKMARK_BATCH',
        bookmarks: data.bookmarks
      });
    }
    if (data.type === 'bookmark-refresh-template' && data.url) {
      chrome.runtime.sendMessage({
        type: 'SWIPEAR:DY_REFRESH_TEMPLATE',
        url: data.url,
        authorization: data.authorization || null
      });
    }
  });

  function tweetIdFromUrl(url) {
    var m = (url || '').match(/\/status\/(\d+)/);
    return m ? m[1] : null;
  }

  function awaitTweetVideo(tweetId, timeoutMs) {
    timeoutMs = timeoutMs || 1500;
    return new Promise(function (resolve) {
      var cached = tweetVideoCache[tweetId];
      if (cached) { resolve(cached); return; }
      var start = Date.now();
      var interval = setInterval(function () {
        var c = tweetVideoCache[tweetId];
        if (c) { clearInterval(interval); resolve(c); return; }
        if (Date.now() - start > timeoutMs) { clearInterval(interval); resolve(null); }
      }, 80);
    });
  }

  var toastEl = null;
  var toastTimer = null;
  function showToast(message, opts) {
    opts = opts || {};
    var sticky = !!opts.sticky;
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.style.cssText = 'position:fixed;right:24px;bottom:24px;z-index:2147483647;display:flex;align-items:center;gap:8px;padding:10px 14px;font:500 13px/1.2 -apple-system,BlinkMacSystemFont,"SF Pro Display",sans-serif;color:rgba(255,255,255,0.95);background:rgba(20,20,22,0.78);backdrop-filter:blur(20px) saturate(1.8);-webkit-backdrop-filter:blur(20px) saturate(1.8);border:0.5px solid rgba(255,255,255,0.14);border-radius:999px;box-shadow:0 1px 2px rgba(0,0,0,0.2),0 8px 22px rgba(0,0,0,0.28);opacity:0;transform:translateY(8px);transition:opacity 160ms ease,transform 160ms ease;pointer-events:none';
      document.body.appendChild(toastEl);
    }
    var dotColor = 'rgba(110,220,140,0.95)';
    toastEl.innerHTML = '<span style="width:6px;height:6px;border-radius:50%;background:' + dotColor + ';display:inline-block"></span><span></span>';
    toastEl.lastChild.textContent = message;
    requestAnimationFrame(function () {
      toastEl.style.opacity = '1';
      toastEl.style.transform = 'translateY(0)';
    });
    if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
    if (!sticky) {
      toastTimer = setTimeout(function () {
        if (!toastEl) return;
        toastEl.style.opacity = '0';
        toastEl.style.transform = 'translateY(8px)';
      }, 2200);
    }
  }

  function findBookmarkButton(target) {
    var el = target;
    while (el && el !== document.body) {
      if (el.getAttribute && el.getAttribute('data-testid') === BOOKMARK_TESTID) return el;
      el = el.parentElement;
    }
    return null;
  }

  function isBookmarkAddAction(button) {
    var label = (button.getAttribute('aria-label') || '').toLowerCase();
    if (!label) return true;
    return label.indexOf('remove') === -1;
  }

  function findTweetArticle(button) {
    var el = button;
    while (el && el !== document.body) {
      if (el.tagName === 'ARTICLE') return el;
      el = el.parentElement;
    }
    return null;
  }

  function findTweetUrl(article) {
    var links = article.querySelectorAll('a[href*="/status/"]');
    for (var i = 0; i < links.length; i++) {
      var href = links[i].getAttribute('href') || '';
      var match = href.match(/^(\/[^/]+\/status\/\d+)(?:[/?#]|$)/);
      if (match) return new URL(match[1], 'https://x.com').href;
    }
    return null;
  }

  function dedupeKey(url) {
    try {
      var u = new URL(url);
      u.searchParams.delete('name');
      return u.toString();
    } catch (e) { return url; }
  }

  function findImageUrls(article) {
    var out = [];
    var seen = {};
    var PBS_PATH = /pbs\.twimg\.com\/(?:media|tweet_video_thumb|ext_tw_video_thumb|amplify_video_thumb)\//;

    function collect(rawSrc) {
      if (!rawSrc) return;
      if (!PBS_PATH.test(rawSrc)) return;
      var key = dedupeKey(rawSrc);
      if (seen.hasOwnProperty(key)) return;
      seen[key] = true;
      out.push(rawSrc);
    }

    var imgs = article.querySelectorAll('img');
    for (var i = 0; i < imgs.length; i++) {
      if (imgs[i].currentSrc) { collect(imgs[i].currentSrc); continue; }
      collect(imgs[i].getAttribute('src'));
      var srcset = imgs[i].getAttribute('srcset');
      if (srcset) {
        srcset.split(',').forEach(function (part) { collect(part.trim().split(/\s+/)[0]); });
      }
    }

    var sources = article.querySelectorAll('source');
    for (var j = 0; j < sources.length; j++) {
      var ssrc = sources[j].getAttribute('srcset') || sources[j].getAttribute('src') || '';
      ssrc.split(',').forEach(function (part) { collect(part.trim().split(/\s+/)[0]); });
    }

    var bgEls = article.querySelectorAll('[style*="background-image"]');
    for (var k = 0; k < bgEls.length; k++) {
      var style = bgEls[k].getAttribute('style') || '';
      var m = style.match(/url\(["']?([^"')]+)["']?\)/);
      if (m) collect(m[1]);
    }

    return out;
  }

  function findAuthorInfo(article) {
    var nameEl = article.querySelector('[data-testid="User-Name"]');
    if (!nameEl) return { displayName: '', handle: '' };
    var lines = nameEl.innerText.split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
    var displayName = lines[0] || '';
    var handle = '';
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].charAt(0) === '@') { handle = lines[i]; break; }
    }
    return { displayName: displayName, handle: handle };
  }

  function findAvatarUrl(article) {
    var wrap = article.querySelector('[data-testid="Tweet-User-Avatar"]');
    if (!wrap) return '';
    var img = wrap.querySelector('img');
    return img ? (img.getAttribute('src') || '') : '';
  }

  function findCaption(article) {
    var captionEl = article.querySelector('[data-testid="tweetText"]');
    return captionEl ? captionEl.innerText.trim() : '';
  }

  function findTweetVideo(article) {
    var video = article.querySelector('video');
    if (!video) return null;
    var posterUrl = video.getAttribute('poster') || '';

    var sourceEls = Array.from(video.querySelectorAll('source'));
    if (video.getAttribute('src')) sourceEls.push(video);

    var best = null;
    for (var i = 0; i < sourceEls.length; i++) {
      var src = sourceEls[i].getAttribute('src');
      if (!src) continue;
      if (!/^https?:\/\//i.test(src)) continue;
      if (!/\.mp4(\?|$)/i.test(src) && !/video\/mp4/i.test(sourceEls[i].getAttribute && sourceEls[i].getAttribute('type') || '')) continue;
      var match = src.match(/\/(\d{2,5})x(\d{2,5})\//);
      var width = match ? parseInt(match[1], 10) : 0;
      if (!best || width > best.width) best = { src: src, width: width };
    }

    if (!best) return posterUrl ? { videoUrl: null, posterUrl: posterUrl } : null;
    return { videoUrl: best.src, posterUrl: posterUrl };
  }

  function twimgLarge(url) {
    try {
      var u = new URL(url);
      u.searchParams.set('name', 'large');
      return u.toString();
    } catch (e) { return url; }
  }

  function parseNum(text) {
    if (!text) return 0;
    var cleaned = String(text).replace(/\u00a0/g, ' ').trim();
    var m = cleaned.match(/([\d,.]+)\s*([kKmM]?)/);
    if (!m) return 0;
    var num = parseFloat(m[1].replace(/,/g, ''));
    if (isNaN(num)) return 0;
    if (m[2].toLowerCase() === 'k') num *= 1000;
    if (m[2].toLowerCase() === 'm') num *= 1000000;
    return Math.round(num);
  }

  function getBtnCount(el) {
    if (!el) return 0;
    var label = el.getAttribute('aria-label') || '';
    var m = label.match(/([\d,.]+)/);
    if (m) return parseNum(m[1]);
    var span = el.querySelector('span');
    if (span) return parseNum(span.textContent);
    return 0;
  }

  function findEngagement(article) {
    var likeBtn = article.querySelector('[data-testid="like"], [data-testid="unlike"]');
    if (!likeBtn) likeBtn = article.querySelector('button[aria-label*="Like"]');
    var replyBtn = article.querySelector('[data-testid="reply"]');
    if (!replyBtn) replyBtn = article.querySelector('button[aria-label*="repl"]');
    var repostBtn = article.querySelector('[data-testid="retweet"], [data-testid="unretweet"]');
    if (!repostBtn) repostBtn = article.querySelector('button[aria-label*="Repost"], button[aria-label*="Retweet"]');

    var reactions = getBtnCount(likeBtn);
    var comments = getBtnCount(replyBtn);
    var reposts = getBtnCount(repostBtn);

    return { reactions: reactions, comments: comments, reposts: reposts };
  }

  document.addEventListener('click', function (e) {
    var button = findBookmarkButton(e.target);
    if (!button) return;
    if (!isBookmarkAddAction(button)) return;

    var article = findTweetArticle(button);
    if (!article) return;

    var tweetUrl = findTweetUrl(article);
    if (!tweetUrl) return;

    var imageUrls = findImageUrls(article);
    var tweetVideo = findTweetVideo(article);

    var articleHasVideo = !!article.querySelector('video');
    var tweetId = tweetIdFromUrl(tweetUrl);

    if (articleHasVideo && (!tweetVideo || !tweetVideo.videoUrl)) {
      if (tweetId) {
        awaitTweetVideo(tweetId).then(function (cached) {
          finishBookmark(article, tweetUrl, tweetId, imageUrls, tweetVideo, cached);
        });
        return;
      }
    }
    finishBookmark(article, tweetUrl, tweetId, imageUrls, tweetVideo, null);
  }, true);

  function finishBookmark(article, tweetUrl, tweetId, imageUrls, tweetVideo, cachedVideo) {
    if (cachedVideo && cachedVideo.videoUrl) {
      tweetVideo = {
        videoUrl: cachedVideo.videoUrl,
        posterUrl: (tweetVideo && tweetVideo.posterUrl) || cachedVideo.posterUrl || ''
      };
    }

    if (tweetVideo && !tweetVideo.videoUrl && tweetVideo.posterUrl) {
      imageUrls.unshift(tweetVideo.posterUrl);
    }

    var author = findAuthorInfo(article);
    var avatarUrl = findAvatarUrl(article);
    var caption = findCaption(article);
    var eng = findEngagement(article);

    var createdAt = '';
    var timeEl = article.querySelector('time[datetime]');
    if (timeEl) createdAt = timeEl.getAttribute('datetime') || '';

    if (imageUrls.length === 0 && !(tweetVideo && tweetVideo.videoUrl) && !(caption && caption.trim())) return;

    var payload = {
      type: 'SWIPEAR:DY_BOOKMARK',
      tweetId: tweetId,
      pageUrl: tweetUrl,
      tags: ['x:bookmark'],
      tweetMeta: {
        authorName: author.displayName,
        authorHandle: author.handle,
        authorAvatarUrl: avatarUrl,
        caption: caption,
        imageUrls: imageUrls,
        videoUrl: tweetVideo ? tweetVideo.videoUrl || null : null,
        posterUrl: tweetVideo ? tweetVideo.posterUrl || null : null,
        createdAt: createdAt,
        reactions: eng.reactions,
        comments: eng.comments,
        reposts: eng.reposts
      }
    };

    var threadParts = tweetThreadCache[tweetId];
    if (Array.isArray(threadParts) && threadParts.length > 1) {
      payload.tweetMeta.thread = threadParts;
    }

    var quoted = tweetQuotedCache[tweetId];
    if (quoted) payload.tweetMeta.quoted = quoted;

    if (tweetVideo && tweetVideo.videoUrl) {
      payload.videoUrl = tweetVideo.videoUrl;
      payload.posterUrl = tweetVideo.posterUrl;
    } else if (imageUrls.length > 0) {
      payload.imageUrl = twimgLarge(imageUrls[0]);
    }

    chrome.runtime.sendMessage(payload, function (response) {
      if (!response) return;
      if (response.ok) {
        showToast(response.duplicate ? 'Already in Swipe.ardy' : 'Saved to Swipe.ardy');
        return;
      }
      if (response.offline) return;
      showToast('Save failed: ' + (response.error || 'unknown error'));
    });
  }

})();
