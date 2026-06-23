(function () {
  if (window.__SWIPEARDY_INTERCEPTOR__) return;
  window.__SWIPEARDY_INTERCEPTOR__ = true;

  function extractTweetVideos(node, out) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (var i = 0; i < node.length; i++) extractTweetVideos(node[i], out);
      return;
    }
    var legacy = node.legacy;
    if (legacy && legacy.id_str) {
      var media = (legacy.extended_entities && legacy.extended_entities.media)
        || (legacy.entities && legacy.entities.media)
        || null;
      if (Array.isArray(media)) {
        for (var i = 0; i < media.length; i++) {
          var m = media[i];
          var variants = m && m.video_info && m.video_info.variants;
          if (!Array.isArray(variants)) continue;
          var best = null;
          for (var j = 0; j < variants.length; j++) {
            var v = variants[j];
            if (!v || v.content_type !== 'video/mp4' || !v.url) continue;
            var br = typeof v.bitrate === 'number' ? v.bitrate : 0;
            if (!best || br > best.bitrate) best = { url: v.url, bitrate: br };
          }
          if (best) {
            out.set(legacy.id_str, {
              videoUrl: best.url,
              posterUrl: m.media_url_https || ''
            });
          }
        }
      }
    }
    var keys = Object.keys(node);
    for (var k = 0; k < keys.length; k++) {
      if (keys[k] === '__typename') continue;
      extractTweetVideos(node[keys[k]], out);
    }
  }

  function postVideos(map) {
    if (map.size === 0) return;
    var entries = [];
    map.forEach(function (value, key) { entries.push([key, value]); });
    window.postMessage({
      source: 'swipeardy-interceptor',
      type: 'tweet-videos',
      videos: entries
    }, window.location.origin);
  }

  function extractBookmarkEntries(json) {
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
          var parsed = parseTweetForBookmark(wrapped);
          if (parsed) out.push(parsed);
        }
      }
      var keys = Object.keys(node);
      for (var k = 0; k < keys.length; k++) {
        if (keys[k] === '__typename') continue;
        walk(node[keys[k]]);
      }
    }
    walk(json);
    return out;
  }

  function extractTweetCore(result) {
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
      if (m && m.type === 'photo' && m.media_url_https) {
        imageUrls.push(m.media_url_https + '?format=jpg&name=large');
      }
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

  function quotedFromTweet(t) {
    var qr = t && t.quoted_status_result && t.quoted_status_result.result;
    return extractTweetCore(qr);
  }

  function parseTweetForBookmark(result) {
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
      } else if (
        (m.type === 'video' || m.type === 'animated_gif')
        && m.video_info && Array.isArray(m.video_info.variants)
      ) {
        var best = null;
        for (var j = 0; j < m.video_info.variants.length; j++) {
          var v = m.video_info.variants[j];
          if (!v || v.content_type !== 'video/mp4' || !v.url) continue;
          var br = typeof v.bitrate === 'number' ? v.bitrate : 0;
          if (!best || br > best.bitrate) best = { url: v.url, bitrate: br };
        }
        if (best && !videoUrl) {
          videoUrl = best.url;
          posterUrl = m.media_url_https || '';
        }
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
      quoted: quotedFromTweet(t),
      createdAt: legacy.created_at || '',
      reactions: legacy.favorite_count || 0,
      comments: legacy.reply_count || 0,
      reposts: legacy.retweet_count || 0
    };
  }

  function collectThreadTweets(node, acc) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (var i = 0; i < node.length; i++) collectThreadTweets(node[i], acc);
      return;
    }
    var legacy = node.legacy;
    if (legacy && legacy.id_str && legacy.conversation_id_str) {
      var userResult = node.core && node.core.user_results && node.core.user_results.result;
      var authorId = userResult
        && (userResult.rest_id || (userResult.legacy && userResult.legacy.id_str));
      if (authorId) {
        var imgUrls = [];
        var mediaList = (legacy.extended_entities && legacy.extended_entities.media) || [];
        for (var i = 0; i < mediaList.length; i++) {
          var m = mediaList[i];
          if (m && m.type === 'photo' && m.media_url_https) {
            imgUrls.push(m.media_url_https + '?format=jpg&name=large');
          }
        }
        acc.push({
          id: legacy.id_str,
          conversationId: legacy.conversation_id_str,
          authorId: String(authorId),
          text: legacy.full_text || '',
          imageUrls: imgUrls
        });
      }
    }
    var keys = Object.keys(node);
    for (var k = 0; k < keys.length; k++) {
      if (keys[k] === '__typename') continue;
      collectThreadTweets(node[keys[k]], acc);
    }
  }

  function extractThreads(json) {
    var raw = [];
    collectThreadTweets(json, raw);
    var byId = {};
    for (var i = 0; i < raw.length; i++) {
      if (!byId.hasOwnProperty(raw[i].id)) byId[raw[i].id] = raw[i];
    }
    var byConv = {};
    var ids = Object.keys(byId);
    for (var j = 0; j < ids.length; j++) {
      var t = byId[ids[j]];
      if (!byConv.hasOwnProperty(t.conversationId)) byConv[t.conversationId] = [];
      byConv[t.conversationId].push(t);
    }
    var out = [];
    var convIds = Object.keys(byConv);
    for (var c = 0; c < convIds.length; c++) {
      var convId = convIds[c];
      var list = byConv[convId];
      var root = null;
      for (var k = 0; k < list.length; k++) {
        if (list[k].id === convId) { root = list[k]; break; }
      }
      if (!root) continue;
      var parts = [];
      for (var p = 0; p < list.length; p++) {
        if (list[p].authorId === root.authorId) {
          parts.push({ text: list[p].text, imageUrls: list[p].imageUrls });
        }
      }
      parts.sort(function (a, b) { return a.text.length - b.text.length; });
      if (parts.length > 1) out.push([convId, parts]);
    }
    return out;
  }

  function postThreads(entries) {
    if (!entries || entries.length === 0) return;
    window.postMessage({
      source: 'swipeardy-interceptor',
      type: 'thread-cache',
      threads: entries
    }, window.location.origin);
  }

  function extractQuotedMap(json) {
    var out = new Map();
    function walk(node) {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { for (var i = 0; i < node.length; i++) walk(node[i]); return; }
      var legacy = node.legacy;
      if (legacy && legacy.id_str && node.quoted_status_result && node.quoted_status_result.result) {
        var q = quotedFromTweet(node);
        if (q && !out.has(legacy.id_str)) out.set(legacy.id_str, q);
      }
      var keys = Object.keys(node);
      for (var k = 0; k < keys.length; k++) {
        if (keys[k] === '__typename') continue;
        walk(node[keys[k]]);
      }
    }
    walk(json);
    return out;
  }

  function postQuoted(map) {
    if (map.size === 0) return;
    var entries = [];
    map.forEach(function (v, k) { entries.push([k, v]); });
    window.postMessage({
      source: 'swipeardy-interceptor',
      type: 'quoted-cache',
      quoted: entries
    }, window.location.origin);
  }

  function postBookmarks(bookmarks) {
    if (bookmarks.length === 0) return;
    window.postMessage({
      source: 'swipeardy-interceptor',
      type: 'bookmark-batch',
      bookmarks: bookmarks
    }, window.location.origin);
  }

  function isBookmarksEndpoint(url) {
    return typeof url === 'string' && /\/graphql\/[^/]+\/Bookmarks/.test(url);
  }

  function isTopOfBookmarksRequest(url) {
    try {
      var u = new URL(url);
      var vars = u.searchParams.get('variables');
      if (!vars) return true;
      var decoded = JSON.parse(vars);
      return !decoded || !decoded.cursor;
    } catch (e) {
      return false;
    }
  }

  function readAuthorization(init) {
    if (!init || !init.headers) return null;
    var h = init.headers;
    if (h && typeof h.get === 'function') return h.get('authorization') || h.get('Authorization');
    if (Array.isArray(h)) {
      for (var i = 0; i < h.length; i++) {
        var pair = h[i];
        if (pair[0] && pair[0].toLowerCase() === 'authorization') return pair[1];
      }
      return null;
    }
    if (typeof h === 'object') {
      var keys = Object.keys(h);
      for (var j = 0; j < keys.length; j++) {
        if (keys[j].toLowerCase() === 'authorization') return h[keys[j]];
      }
    }
    return null;
  }

  function postRefreshTemplate(url, authorization) {
    window.postMessage({
      source: 'swipeardy-interceptor',
      type: 'bookmark-refresh-template',
      url: url,
      authorization: authorization || null
    }, window.location.origin);
  }

  function shouldIntercept(url) {
    if (typeof url !== 'string') return false;
    return url.indexOf('/graphql/') !== -1 || url.indexOf('/i/api/') !== -1;
  }

  function cacheVideoUrls(entries) {
    if (!entries || !entries.length) return;
    var el = document.getElementById('swipeardy-video-cache');
    if (!el) { el = document.createElement('div'); el.id = 'swipeardy-video-cache'; el.style.display = 'none'; document.body.appendChild(el); }
    var cache = {};
    try { cache = JSON.parse(el.textContent || '{}'); } catch (e) {}
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (e && e.tweetUrl && e.videoUrl) cache[e.tweetUrl] = e.videoUrl;
    }
    el.textContent = JSON.stringify(cache);
  }

  var ORIGINAL_FETCH = window.fetch;
  window.fetch = function () {
    var args = arguments;
    var reqUrl = typeof args[0] === 'string'
      ? args[0]
      : (args[0] && args[0].url) || '';
    var p = ORIGINAL_FETCH.apply(this, args);
    if (!shouldIntercept(reqUrl)) return p;
    p.then(function (res) {
      if (!res || !res.ok) return;
      var clone = res.clone();
      clone.json().then(function (json) {
        var videoMap = new Map();
        extractTweetVideos(json, videoMap);
        postVideos(videoMap);
        postThreads(extractThreads(json));
        postQuoted(extractQuotedMap(json));
        if (isBookmarksEndpoint(reqUrl)) {
          var entries = extractBookmarkEntries(json);
          postBookmarks(entries);
          cacheVideoUrls(entries);
          if (isTopOfBookmarksRequest(reqUrl)) {
            var reqInit = (args[0] && typeof args[0] === 'object' && args[0].headers)
              ? args[0]
              : args[1];
            postRefreshTemplate(reqUrl, readAuthorization(reqInit));
          }
        }
      }).catch(function () { /* non-JSON */ });
    }).catch(function () { /* fetch error */ });
    return p;
  };

  var XHR_OPEN = XMLHttpRequest.prototype.open;
  var XHR_SET_HEADER = XMLHttpRequest.prototype.setRequestHeader;
  var XHR_SEND = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__swipeUrl = url;
    this.__swipeHeaders = {};
    var args = [method, url];
    for (var i = 2; i < arguments.length; i++) args.push(arguments[i]);
    return XHR_OPEN.apply(this, args);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (this.__swipeHeaders && typeof name === 'string') {
      this.__swipeHeaders[name.toLowerCase()] = value;
    }
    return XHR_SET_HEADER.call(this, name, value);
  };
  XMLHttpRequest.prototype.send = function () {
    var self = this;
    var args = arguments;
    this.addEventListener('load', function () {
      if (!shouldIntercept(self.__swipeUrl)) return;
      try {
        var json = JSON.parse(self.responseText);
        var videoMap = new Map();
        extractTweetVideos(json, videoMap);
        postVideos(videoMap);
        postThreads(extractThreads(json));
        postQuoted(extractQuotedMap(json));
        if (isBookmarksEndpoint(self.__swipeUrl)) {
          var entries = extractBookmarkEntries(json);
          postBookmarks(entries);
          cacheVideoUrls(entries);
          if (isTopOfBookmarksRequest(self.__swipeUrl)) {
            var auth = self.__swipeHeaders && self.__swipeHeaders.authorization;
            postRefreshTemplate(self.__swipeUrl, auth || null);
          }
        }
      } catch (e) { /* non-JSON */ }
    });
    return XHR_SEND.apply(this, args);
  };
})();
