(function () {
  if (window.__swipeardyInjected) return;
  window.__swipeardyInjected = true;
  var LOG = false;

  // ─── LinkedIn Save button watcher ───
  document.addEventListener('click', function (e) {
    if (location.hostname.indexOf('linkedin.com') === -1) return;
    if (!e.target.closest('[aria-label*="save" i], [data-control-name="save"]')) return;
    var btn = findLinkedInSaveButton(e.target);
    if (!btn) return;
    if (!isLinkedInSaveAddAction(btn)) return;
    var card = findLinkedInPostCard(btn);
    if (!card) return;
    try {
      var data = extractLinkedInFromCard(card);
      if (!data || !data.author) return;
      data.platform = 'LinkedIn';
      data.filters = { Platform: 'LinkedIn' };
      chrome.runtime.sendMessage({ type: 'SAVE_SWIPE', data: data }, function (resp) {
        if (resp && resp.ok) { /* saved silently */ }
      });
    } catch (e) { /* silent */ }
  }, true);

  function findLinkedInSaveButton(target) {
    var el = target;
    while (el && el !== document.body) {
      var label = (el.getAttribute('aria-label') || '').toLowerCase();
      if (label && label.indexOf('save') !== -1 && label.indexOf('unsave') === -1 && label.indexOf('saved') === -1) return el;
      if (el.getAttribute && el.getAttribute('data-control-name') === 'save') return el;
      el = el.parentElement;
    }
    return null;
  }

  function isLinkedInSaveAddAction(button) {
    var label = (button.getAttribute('aria-label') || '').toLowerCase();
    if (label.indexOf('unsave') !== -1) return false;
    if (label.indexOf('saved') !== -1 && label.indexOf('save') === -1) return false;
    return true;
  }

  function findLinkedInPostCard(button) {
    var el = button.parentElement;
    for (var i = 0; i < 20; i++) {
      if (!el || el === document.body) break;
      var classes = (el.className || '').toLowerCase();
      if (classes.indexOf('feed-shared') !== -1 || classes.indexOf('occludable') !== -1) return el;
      if (el.tagName === 'ARTICLE') return el;
      el = el.parentElement;
    }
    return null;
  }

  function extractLinkedInFromCard(card) {
    var author = extractLinkedInAuthor(card);
    var text = extractLinkedInSnippet(card);
    var counts = extractLinkedInCounts(card, '');
    var postUrl = extractLinkedInPostUrl(card);
    var btnCarouselImages = scanLinkedInImage(card);
    LOG&&console.log('[DEBUG carousel btn]', getLinkedInLabel(card), 'found:', btnCarouselImages.length, btnCarouselImages.slice(0,3));
    var image = btnCarouselImages.length > 0 ? btnCarouselImages.join(',') : extractLinkedInImage(card);

    var btnDocContainer = card.querySelector('.feed-shared-document__container, .update-components-document__container, [class*="document"]');
    var btnDocUrl = '';
    if (btnDocContainer) {
      var btnDocLink = btnDocContainer.querySelector('a[href*="sanitized-pdf"], a[href*="document/dms"], a[download]');
      if (btnDocLink) btnDocUrl = btnDocLink.href;
    }
    LOG&&console.log('[DEBUG document btn]', btnDocUrl || 'no PDF URL found');

    var date = '';
    var timeEl = card.querySelector('time[datetime]');
    if (timeEl) {
      var dt = timeEl.getAttribute('datetime');
      if (dt) {
        var d = new Date(dt);
        if (!isNaN(d.getTime())) date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      }
    }
    return {
      author: author,
      text: text,
      reactions: counts.reactions,
      comments: counts.comments,
      reposts: counts.reposts,
      postUrl: postUrl,
      image: image,
      images: btnCarouselImages || [],
      documentUrl: btnDocUrl,
      date: date
    };
  }

  // ─── Pinterest Relay interceptor (captures full pin data during SPA) ───
  var __swipeardyRelayData = null;
  if (location.hostname.indexOf('pinterest.com') !== -1) {
    var __origRelay = window.__PWS_RELAY_REGISTER_COMPLETED_REQUEST__;
    if (typeof __origRelay === 'function') {
      window.__PWS_RELAY_REGISTER_COMPLETED_REQUEST__ = function () {
        try {
          var args = arguments[0];
          if (args && args.data) {
            var keys = Object.keys(args.data);
            for (var ri = 0; ri < keys.length; ri++) {
              var query = args.data[keys[ri]];
              if (query && query.data && query.data.closeupUnifiedDescription) {
                __swipeardyRelayData = query.data;
                break;
              }
            }
          }
        } catch(e) {}
        return __origRelay.apply(this, arguments);
      };
    }
  }

  function detectPlatform() {
    var h = location.hostname;
    if (/linkedin\.com/.test(h)) return 'LinkedIn';
    if (/x\.com|twitter\.com/.test(h)) return 'X';
    if (/pinterest\.com/.test(h)) return 'Pinterest';
    return null;
  }

  function isPostDetailPage() {
    var p = detectPlatform();
    if (p === 'LinkedIn') {
      return /\/feed\/update\/|activity:/.test(location.pathname) ||
             /\/posts\/[^/]+/.test(location.pathname);
    }
    if (p === 'X') {
      return /\/status\/\d+/.test(location.pathname);
    }
    if (p === 'Pinterest') {
      return /\/pin\//.test(location.pathname);
    }
    return false;
  }

  function visibleText(el) {
    if (!el) return '';
    return (el.innerText || el.textContent || '').replace(/\s+\n/g, '\n').trim();
  }

  function parseCompactNumber(text) {
    if (!text) return 0;
    var cleaned = String(text).replace(/\u00a0/g, ' ').trim();
    var m = cleaned.match(/([\d,.]+)\s*([kKmM]?)/);
    if (!m) return 0;
    var num = parseFloat(m[1].replace(/,/g, ''));
    if (isNaN(num)) return 0;
    var suffix = m[2].toLowerCase();
    if (suffix === 'k') num *= 1000;
    if (suffix === 'm') num *= 1000000;
    return Math.round(num);
  }

  function parseIntFromAria(el) {
    var label = el.getAttribute('aria-label') || '';
    var m = label.match(/([\d,.]+)/);
    return m ? parseCompactNumber(m[1]) : 0;
  }

  function extractCountFromButton(el) {
    var count = parseIntFromAria(el);
    if (count) return count;
    var span = el.querySelector('span');
    if (span) {
      var txt = span.textContent.trim();
      return parseCompactNumber(txt);
    }
    return 0;
  }

  function dedupeName(txt) {
    if (!txt) return txt;
    var clean = txt.replace(/\s+/g, ' ').trim();
    var half = Math.floor(clean.length / 2);
    var a = clean.slice(0, half).trim();
    var b = clean.slice(half).trim();
    if (a && a === b) return a;
    var words = clean.split(' ');
    if (words.length % 2 === 0) {
      var mid = words.length / 2;
      var first = words.slice(0, mid).join(' ');
      var second = words.slice(mid).join(' ');
      if (first === second) return first;
    }
    return clean;
  }

  // ─── LinkedIn Extraction ───

  function getPostAreaText(fullText) {
    var markers = ['Feed post', 'feed post', 'Promoted', 'promoted'];
    for (var m = 0; m < markers.length; m++) {
      var idx = fullText.indexOf(markers[m]);
      if (idx !== -1) return fullText.slice(idx + markers[m].length).trim();
    }
    return '';
  }

  function extractLinkedInAuthor(card) {
    var fullText = visibleText(card);
    var postText = getPostAreaText(fullText);

    if (postText) {
      var lines = postText.split('\n');
      for (var li = 0; li < lines.length; li++) {
        var line = lines[li].trim();
        if (!line || line.length > 60) continue;
        if (line.indexOf('\u2022') === 0 || line.indexOf('•') === 0) continue;
        if (/^\d+[hmdw]/.test(line)) continue;
        if (line.toLowerCase().indexOf('view') === 0) continue;
        if (line.toLowerCase().indexOf('reposted') !== -1) continue;
        return dedupeName(line);
      }
      LOG&&console.log('[Swipe.ardy cs] Author from post text: all lines were filtered');
    }

    var selectors = [
      '[data-anonymize="person-name"]',
      '.update-components-actor__title span[dir="ltr"]',
      '.update-components-actor__name span[dir="ltr"]',
      '.feed-shared-actor__name span[dir="ltr"]',
      'span.update-components-actor__name',
      'span.feed-shared-actor__name',
      'a[href*="/in/"]'
    ];
    for (var i = 0; i < selectors.length; i++) {
      var nodes = card.querySelectorAll(selectors[i]);
      for (var j = 0; j < nodes.length; j++) {
        var txt = dedupeName(visibleText(nodes[j]).replace(/\s+/g, ' ').trim());
        if (!txt || txt.toLowerCase() === 'post' || txt.toLowerCase() === 'promoted') continue;
        if (txt.length > 80) continue;
        LOG&&console.log('[Swipe.ardy cs] Author selector hit:', selectors[i], '->', txt);
        return txt;
      }
    }
    LOG&&console.log('[Swipe.ardy cs] Author: NO selectors matched');
    return '';
  }

  function cleanSnippet(text) {
    if (!text) return '';
    var boundaries = ['Activate to view larger image', 'Add a comment', 'Open Emoji Keyboard', 'Like Reply', 'Like\nReply', 'Load more comments', 'Reaction button', 'Most relevant', 'most relevant', 'About\nAccessibility', 'Help Center', 'LinkedIn Corporation', 'Get the LinkedIn app', 'Privacy & Terms'];
    for (var bi = 0; bi < boundaries.length; bi++) {
      var idx = text.indexOf(boundaries[bi]);
      if (idx !== -1) {
        text = text.slice(0, idx);
        LOG&&console.log('[Swipe.ardy cs] cleanSnippet: truncated at "' + boundaries[bi] + '"');
        break;
      }
    }
    var lines = text.split('\n');
    while (lines.length > 0 && /^\d{1,6}$/.test(lines[lines.length - 1].trim())) {
      lines.pop();
    }
    text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();

    lines = text.split('\n');
    var ctaPattern = /^(connect|follow|following|subscribe|message|more|view profile|open profile)$/i;
    var stripped = 0;
    while (lines.length > 0 && ctaPattern.test(lines[0].trim()) && stripped < 2) {
      lines.shift();
      stripped++;
      LOG&&console.log('[Swipe.ardy cs] cleanSnippet: stripped leading CTA');
    }
    text = lines.join('\n').trim();

    var fallback = [
      /^\d{1,6}$/,
      /^\d{1,3}[,.]?\d*[kKmM]?\s*(reactions?|comments?|reposts?|likes?|shares?)/i,
      /^(reactions?|comments?|reposts?|likes?|shares?)\s*\d/i
    ];
    lines = text.split('\n');
    var cleaned = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      var skip = false;
      for (var fi = 0; fi < fallback.length; fi++) {
        if (fallback[fi].test(line)) { skip = true; break; }
      }
      if (!skip) cleaned.push(line);
    }
    return cleaned.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  function extractLinkedInSnippet(card) {
    var fullText = visibleText(card);
    var postText = getPostAreaText(fullText);

    if (postText) {
      var tsMatch = postText.match(/\d+[hmdw]o?\s*·\s*|\d+\s+(?:seconds?|minutes?|hours?|days?|weeks?|months?|years?)\s*(?:ago)?\s*·\s*/i);
      if (tsMatch) {
        var afterTs = postText.slice(postText.indexOf(tsMatch[0]) + tsMatch[0].length).trim();
        // Strip LinkedIn header junk that appears between timestamp and content
        afterTs = afterTs.replace(/^(?:Follow|Connect|Connect with[^\n"]*?|Visible to anyone[^\n]*|View profile[^\n"]*?)\s*/i, '').trim();
        var cleaned = cleanSnippet(afterTs);
        LOG&&console.log('[Swipe.ardy cs] Snippet from after timestamp ->', cleaned.slice(0, 200));
        if (cleaned.length > 20) return cleaned;
      }

      var lines = postText.split('\n');
      var captionLines = [];
      var pastTimestamp = false;
      for (var li = 0; li < lines.length; li++) {
        var line = lines[li].trim();
        if (!line) continue;
        if (line.indexOf('\u2022') === 0 || line.indexOf('•') === 0) continue;
        if (/^\d+[hmdw]o?|\d+\s+(?:seconds?|minutes?|hours?|days?|weeks?|months?|years?)\s*(?:ago)?/i.test(line)) { pastTimestamp = true; continue; }
        if (!pastTimestamp && line.length <= 60) continue;
        if (pastTimestamp) captionLines.push(line);
      }
      if (captionLines.length > 0) {
        var snippet = captionLines.join(' ').replace(/\s+/g, ' ').trim();
        var cleaned2 = cleanSnippet(snippet);
        LOG&&console.log('[Swipe.ardy cs] Snippet from lines after timestamp ->', cleaned2.slice(0, 200));
        if (cleaned2.length > 20) return cleaned2;
      }
    }

    var selectors = [
      '.update-components-text .break-words',
      '.update-components-text',
      '.feed-shared-update-v2__description-wrapper',
      '.feed-shared-inline-show-more-text',
      '.feed-shared-text',
      '.update-components-update-v2__commentary'
    ];
    var blacklist = ['following', 'premium', 'promoted', 'reposted this', 'visit my website', 'subscribe'];
    for (var i = 0; i < selectors.length; i++) {
      var nodes = card.querySelectorAll(selectors[i]);
      for (var j = 0; j < nodes.length; j++) {
        var txt = visibleText(nodes[j]);
        if (!txt || txt.length < 20) continue;
        txt = txt.replace(/\b(Premium|Following|Follow)\b/gi, '').replace(/\s+/g, ' ').trim();
        var lower = txt.toLowerCase();
        if (blacklist.filter(function (w) { return lower.indexOf(w) !== -1; }).length >= 3) continue;
        LOG&&console.log('[Swipe.ardy cs] Snippet selector hit:', selectors[i], '->', txt.slice(0, 150));
        return cleanSnippet(txt);
      }
    }
    LOG&&console.log('[Swipe.ardy cs] Snippet: NO selectors matched — tried', selectors);
    return '';
  }

  function extractLinkedInCounts(card, postAreaText) {
    var reactions = 0, comments = 0, reposts = 0;

    var rNode = card.querySelector('.social-details-social-counts__reactions-count');
    if (rNode) reactions = parseCompactNumber(visibleText(rNode).trim());

    var allCountItems = card.querySelectorAll('[class*="social-details"] span, [class*="social-counts"] span');
    for (var ac = 0; ac < allCountItems.length; ac++) {
      var label = (allCountItems[ac].getAttribute('aria-label') || '').toLowerCase();
      var txt = visibleText(allCountItems[ac]).trim();
      var num = parseCompactNumber(txt);
      if (!num || num < 1) continue;
      if (/^0+$/.test(txt)) continue;
      if (/comment|repl/i.test(label) && !comments) comments = num;
      if (/repost|share|retweet/i.test(label) && !reposts) reposts = num;
      if (/reaction|like/i.test(label) && !reactions) reactions = num;
    }

    LOG&&console.log('[Swipe.ardy cs] Direct count query:', { reactions: reactions, comments: comments, reposts: reposts });

    var searchText = postAreaText || visibleText(card);
    LOG&&console.log('[Swipe.ardy cs] Count search text FULL:', searchText);

    var searchLines = searchText.split('\n');
    var bareNumbers = [];
    for (var bli = 0; bli < searchLines.length; bli++) {
      var bl = searchLines[bli].trim();
      if (/^\d{1,6}$/.test(bl)) {
        bareNumbers.push(parseInt(bl, 10));
      } else {
        if (bareNumbers.length >= 2) break;
        bareNumbers = [];
      }
    }
    LOG&&console.log('[Swipe.ardy cs] Bare number sequence found:', bareNumbers);
    if (bareNumbers.length >= 3) {
      reactions = bareNumbers[0];
      comments = bareNumbers[1];
      reposts = bareNumbers[2];
    } else if (bareNumbers.length === 2) {
      reactions = bareNumbers[0];
      comments = bareNumbers[1];
    }

    var skipSearchText = searchText;
    var mrIdx = skipSearchText.indexOf('Most relevant') !== -1 ? skipSearchText.indexOf('Most relevant') : skipSearchText.indexOf('most relevant');
    if (mrIdx !== -1) skipSearchText = skipSearchText.slice(0, mrIdx);
    LOG&&console.log('[Swipe.ardy cs] Truncated search text (first 200):', skipSearchText.slice(0, 200));

    var commentTerms = ['comment', 'comments', 'komentar', 'komentari'];
    var repostTerms = ['repost', 'reposts', 'shared', 'share', 'shares'];
    var reactionTerms = ['reaction', 'reactions', 'like', 'likes'];
    var allTerms = commentTerms.concat(repostTerms).concat(reactionTerms);

    var normalized = skipSearchText.replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ');
    var segments = normalized.split(/[\n\u2022\u00b7|]+/).map(function (s) { return s.trim(); }).filter(Boolean);

    LOG&&console.log('[Swipe.ardy cs] Count segments:', segments.slice(0, 30));

    function extractByTerms(text, terms) {
      if (!text) return 0;
      var escaped = terms.map(function (t) { return t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }).join('|');
      var patterns = [
        new RegExp('([\\d,.KkMm]+)\\s*(?:' + escaped + ')', 'i'),
        new RegExp('(?:' + escaped + ')\\s*([\\d,.KkMm]+)', 'i')
      ];
      for (var pi = 0; pi < patterns.length; pi++) {
        var match = text.match(patterns[pi]);
        if (match) {
          var n = parseCompactNumber(match[1]);
          if (n) return n;
        }
      }
      return 0;
    }

    function extractFromSegments(terms) {
      for (var si = 0; si < segments.length; si++) {
        var found = extractByTerms(segments[si], terms);
        if (found) return found;
      }
      return 0;
    }

    comments = extractByTerms(normalized, commentTerms) || extractFromSegments(commentTerms) || comments;
    reposts = extractByTerms(normalized, repostTerms) || extractFromSegments(repostTerms) || reposts;
    reactions = extractByTerms(normalized, reactionTerms) || extractFromSegments(reactionTerms) || reactions;

    if (!reactions) {
      var othersPatterns = [
        /(?:and\s+)?([\d,.KkMm]+)\s+others/i,
        /(?:dan\s+)?([\d,.KkMm]+)\s+lainnya/i
      ];
      for (var oi = 0; oi < othersPatterns.length; oi++) {
        var om = normalized.match(othersPatterns[oi]);
        if (om) { reactions = parseCompactNumber(om[1]); if (reactions) break; }
      }
    }

    if (!reactions) {
      var lines = segments.length ? segments : normalized.split('\n');
      for (var li = 0; li < lines.length; li++) {
        var lower = lines[li].toLowerCase();
        if (!allTerms.some(function (t) { return lower.indexOf(t) !== -1; })) continue;
        var nums = (lines[li].match(/([\d,.KkMm]+)/g) || []).map(parseCompactNumber).filter(Boolean);
        if (nums.length >= 1 && nums[0] !== comments && nums[0] !== reposts) {
          reactions = nums[0];
          break;
        }
      }
    }

    var rNode2 = card.querySelector('[aria-label*="reaction"]');
    if (!reactions && rNode2) {
      var label = rNode2.getAttribute('aria-label') || '';
      var am = label.match(/([\d,.]+)/);
      if (am) reactions = parseCompactNumber(am[1]);
    }

    LOG&&console.log('[Swipe.ardy cs] Counts extracted:', { reactions: reactions, comments: comments, reposts: reposts });

    return { reactions: reactions, comments: comments, reposts: reposts };
  }

  function extractLinkedInActivityId(card) {
    var nodes = [card].concat(Array.from(card.querySelectorAll('[data-urn], [data-id], a[href]')));
    for (var i = 0; i < nodes.length; i++) {
      var attrs = [
        nodes[i].getAttribute && nodes[i].getAttribute('data-urn'),
        nodes[i].getAttribute && nodes[i].getAttribute('data-id'),
        nodes[i].getAttribute && nodes[i].getAttribute('href')
      ].filter(Boolean);
      for (var j = 0; j < attrs.length; j++) {
        var m = String(attrs[j]).match(/urn:li:activity:(\d{10,20})/i);
        if (m) return m[1];
      }
    }
    return '';
  }

  function extractLinkedInPostUrl(card) {
    var activityId = extractLinkedInActivityId(card);
    if (activityId) return 'https://www.linkedin.com/feed/update/urn:li:activity:' + activityId + '/';
    var links = card.querySelectorAll('a[href]');
    for (var i = 0; i < links.length; i++) {
      var h = links[i].href;
      if (/\/feed\/update\/|activity:/.test(h)) return h;
    }
    return location.href;
  }

  function extractLinkedInImage(card) {
    var allImgs = card.querySelectorAll('img');
    for (var i = 0; i < allImgs.length; i++) {
      var img = allImgs[i];
      var w = img.naturalWidth || img.width || 0;
      var h = img.naturalHeight || img.height || 0;
      if (w < 100 || h < 100) continue;
      var cls = (img.className || '').toLowerCase();
      if (cls.indexOf('actor') !== -1 || cls.indexOf('avatar') !== -1 || cls.indexOf('ghost') !== -1 || cls.indexOf('presence') !== -1) continue;
      var srcset = img.srcset || '';
      if (srcset) {
        var bestSrc = '', bestW = 0;
        srcset.split(',').forEach(function(c) {
          var p = c.trim().split(' ');
          var w = parseInt(p[p.length - 1].replace('w', ''));
          if (w > bestW) { bestW = w; bestSrc = p[0]; }
        });
        if (bestSrc) return bestSrc;
      }
      var src = img.src || '';
      if (!src || src.indexOf('data:') === 0) continue;
      if (/\/ghost\//i.test(src)) continue;
      if (/profile-displayphoto/i.test(src)) continue;
      if (/profile-framedphoto/i.test(src)) continue;
      if (/profile-displaybackgrou/i.test(src)) continue;
      if (/comment-image/i.test(src)) continue;
      return src;
    }
    return '';
  }

  function findCardByActivityId(activityId) {
    if (!activityId) return null;
    var el = document.querySelector('[data-urn*="' + activityId + '"], [data-id*="' + activityId + '"]');
    if (!el) return null;
    return el.closest('div.feed-shared-update-v2') || el.closest('div.occludable-update') || el;
  }

  function findCardByTimeElement() {
    var timeEl = document.querySelector('time[datetime]');
    if (!timeEl) return null;
    var card = timeEl.closest('div.feed-shared-update-v2') || timeEl.closest('div.occludable-update');
    if (card) return card;
    var parent = timeEl.parentElement;
    for (var i = 0; i < 10; i++) {
      if (!parent) break;
      if (parent.tagName === 'ARTICLE') return parent;
      var classes = (parent.className || '').toLowerCase();
      if (classes.indexOf('feed-shared') !== -1 || classes.indexOf('occludable') !== -1) return parent;
      parent = parent.parentElement;
    }
    return null;
  }

  function findCardByEngagement() {
    var engEl = document.querySelector('.social-details-social-counts, [class*="social-details"]');
    if (!engEl) return null;
    var parent = engEl;
    for (var i = 0; i < 15; i++) {
      if (!parent || !parent.parentElement) break;
      if (parent.tagName === 'ARTICLE') return parent;
      var classes = (parent.className || '').toLowerCase();
      if ((classes.indexOf('feed-shared') !== -1 || classes.indexOf('occludable') !== -1) && visibleText(parent).length > 100) return parent;
      parent = parent.parentElement;
    }
    return null;
  }

  function extractCarouselCoversFromCode() {
    try {
      var codeEls = document.querySelectorAll('code');
      for (var i = 0; i < codeEls.length; i++) {
        var content = codeEls[i].textContent;
        if (!content || content.indexOf('feedshare-document-cover-images') === -1) continue;
        var m2 = content.match(/"imageUrls":\[([^\]]+)\]/);
        if (m2) {
          var urls = m2[1].match(/https:\/\/[^"]+/g);
          if (urls) return urls.map(function(u) { return u.replace(/\\u0026/g, '&'); });
        }
      }
    } catch(e) {}
    return [];
  }

  async function extractCarouselImages() {
    try {
      var codeEls = document.querySelectorAll('code');
      console.log('[carousel] code elements:', codeEls.length);
      for (var i = 0; i < codeEls.length; i++) {
        var content = codeEls[i].textContent;
        if (!content || content.indexOf('feedshare-document-master-manifest') === -1) continue;
        console.log('[carousel] found manifest in code element', i);
        // Extract manifestUrl from LinkedIn's Relay/GraphQL JSON
        var m = content.match(/"manifestUrl":"(https:\/\/media\.licdn\.com[^"]+)"/);
        if (!m) { console.log('[carousel] regex failed to extract manifestUrl'); continue; }
        var manifestUrl = m[1].replace(/\\u0026/g, '&');
        console.log('[carousel] manifestUrl found');
        // Fetch master manifest
        var resp = await fetch(manifestUrl);
        if (!resp.ok) { console.log('[carousel] manifest fetch failed:', resp.status); return extractCarouselCoversFromCode(); }
        var manifest = await resp.json();
        if (!manifest.perResolutions || manifest.perResolutions.length === 0) { console.log('[carousel] no resolutions'); return extractCarouselCoversFromCode(); }
        // Pick best resolution
        var res = manifest.perResolutions.find(function(r) { return r.width === 1280; })
               || manifest.perResolutions.sort(function(a,b) { return b.width - a.width; })[0];
        if (!res || !res.imageManifestUrl) { console.log('[carousel] no suitable resolution'); return extractCarouselCoversFromCode(); }
        // Fetch image manifest
        var imgResp = await fetch(res.imageManifestUrl);
        if (!imgResp.ok) { console.log('[carousel] image manifest fetch failed:', imgResp.status); return extractCarouselCoversFromCode(); }
        var imgData = await imgResp.json();
        if (!imgData.pages || imgData.pages.length === 0) { console.log('[carousel] no pages in manifest'); return extractCarouselCoversFromCode(); }
        console.log('[carousel] success:', imgData.pages.length, 'pages');
        return imgData.pages;
      }
      console.log('[carousel] no manifest in any code element');
      return extractCarouselCoversFromCode();
    } catch(e) { console.warn('[carousel] extract error:', e); return extractCarouselCoversFromCode(); }
  }

  async function extractLinkedIn() {
    var activityId = '';
    var am = location.pathname.match(/activity:(\d+)/) || location.pathname.match(/-(\d{10,20})-/) || location.pathname.match(/share:(\d+)/);
    if (am) activityId = am[1];

    var date = '';
    if (activityId) {
      var clean = activityId.replace(/[^\d]/g, '');
      if (clean) {
        try {
          var binStr = BigInt(clean).toString(2);
          if (binStr.length >= 41) {
            var tsBits = binStr.slice(0, 41);
            var ms = parseInt(tsBits, 2);
            if (Number.isFinite(ms) && ms > 0) {
              var d = new Date(ms);
              date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
            }
          }
        } catch (e) {
          date = '';
        }
      }
    }

    if (!date) {
      var timeEl = document.querySelector('time[datetime]');
      if (timeEl) {
        var dt = timeEl.getAttribute('datetime');
        if (dt) {
          var d = new Date(dt);
          if (!isNaN(d.getTime())) {
            date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
            LOG&&console.log('[Swipe.ardy cs] Date fallback from <time datetime>:', dt, '->', date);
          }
        }
      }
    }

    LOG&&console.log('[Swipe.ardy cs] Activity ID from URL:', activityId, 'Decoded date:', date);

    var sampleEls = document.querySelectorAll('[data-urn*="activity"], [data-id*="urn"], [data-activity-id], [data-activity], article, [class*="feed-shared-update"], [class*="occludable"]');
    LOG&&console.log('[Swipe.ardy cs] DOM scan — elements found:', sampleEls.length);
    if (sampleEls.length > 0) {
      var first = sampleEls[0];
      LOG&&console.log('[Swipe.ardy cs] First element tag:', first.tagName, 'class:', first.className, 'data-urn:', first.getAttribute('data-urn'), 'data-id:', first.getAttribute('data-id'), 'data-activity:', first.getAttribute('data-activity'));
    }

    var card = activityId ? findCardByActivityId(activityId) : null;
    LOG&&console.log('[Swipe.ardy cs] Activity ID match:', card ? 'FOUND' : 'NOT FOUND');

    if (!card && activityId) {
      card = findCardByTimeElement();
      LOG&&console.log('[Swipe.ardy cs] Time element match:', card ? 'FOUND' : 'NOT FOUND');
    }

    if (!card && activityId) {
      card = findCardByEngagement();
      LOG&&console.log('[Swipe.ardy cs] Engagement match:', card ? 'FOUND' : 'NOT FOUND');
    }

    if (!card) {
      var postSelectors = [
        'div.feed-shared-update-v2',
        'div.occludable-update',
        'div[data-urn*="activity"]',
        'div[data-id^="urn:li:activity"]'
      ];
      var cards = [];
      for (var i = 0; i < postSelectors.length; i++) {
        var els = document.querySelectorAll(postSelectors[i]);
        for (var j = 0; j < els.length; j++) {
          var root = els[j].closest('div.feed-shared-update-v2') || els[j].closest('div.occludable-update') || els[j];
          if (cards.indexOf(root) === -1) cards.push(root);
        }
      }
      if (cards.length === 0) {
        cards = Array.from(document.querySelectorAll('main'));
        if (!cards.length) cards = [document.body];
      }
      cards = cards.filter(function (c) { return visibleText(c).length >= 40; });
      cards.sort(function (a, b) { return a.getBoundingClientRect().top - b.getBoundingClientRect().top; });
      card = cards[0];
      LOG&&console.log('[Swipe.ardy cs] Fallback heuristic: picked card', card.tagName, visibleText(card).slice(0, 60));
    }

    if (!card) throw new Error('No LinkedIn post found on this page');

    var fullText = visibleText(card);
    var postText = getPostAreaText(fullText);
    LOG&&console.log('[Swipe.ardy cs] Card found, first 300 chars:', fullText.slice(0, 300));
    LOG&&console.log('[Swipe.ardy cs] Post area text (first 300):', postText.slice(0, 300));

    var author = extractLinkedInAuthor(card);
    var text = extractLinkedInSnippet(card);
    var counts = extractLinkedInCounts(card, postText);
    var postUrl = extractLinkedInPostUrl(card);
    // Try LinkedIn carousel FIRST — searches <code> JSON (global, not tied to card)
    var carouselImages = await extractCarouselImages();
    console.log('[extract] carousel from code:', carouselImages.length);
    if (carouselImages.length === 0) {
      // Not a carousel (or no <code> JSON) — scan for regular images
      carouselImages = scanLinkedInImage(card);
      console.log('[extract] scanLinkedInImage:', carouselImages.length);
      if (carouselImages.length === 0) {
        var pageDoc = document.querySelector('.feed-shared-document__container, .update-components-document__container');
        if (pageDoc) { carouselImages = scanLinkedInImage(pageDoc); }
        console.log('[extract] pageDoc scan:', carouselImages.length);
      }
    }
    LOG&&console.log('[DEBUG carousel single]', getLinkedInLabel(card), 'found:', carouselImages.length, carouselImages.slice(0,3));
    var image = carouselImages.length > 0 ? carouselImages.join(',') : extractLinkedInImage(card);

    var sDocContainer = card.querySelector('.feed-shared-document__container, .update-components-document__container, [class*="document"]')
                     || document.querySelector('.feed-shared-document__container, .update-components-document__container');
    var sDocUrl = '';
    if (sDocContainer) {
      var sDocLink = sDocContainer.querySelector('a[href*="sanitized-pdf"], a[href*="document/dms"], a[download]');
      if (sDocLink) sDocUrl = sDocLink.href;
    }
    LOG&&console.log('[DEBUG document single]', sDocUrl || 'no PDF URL found');

    return {
      author: author,
      text: text,
      reactions: counts.reactions,
      comments: counts.comments,
      reposts: counts.reposts,
      postUrl: postUrl,
      platform: 'LinkedIn',
      image: image,
      images: carouselImages || [],
      documentUrl: sDocUrl,
      date: date
    };
  }

  // ─── Twitter/X Extraction ───

  function extractTwitter() {
    var tm = location.pathname.match(/\/status\/(\d+)/);
    var tweetId = tm ? tm[1] : '';

    var article = null;
    if (tweetId) {
      article = document.querySelector('article[data-tweet-id="' + tweetId + '"]');
      if (!article) {
        var links = document.querySelectorAll('a[href*="/status/' + tweetId + '"]');
        for (var li = 0; li < links.length; li++) {
          var a = links[li].closest('article');
          if (a) { article = a; break; }
        }
      }
      if (!article) {
        var timeEl = document.querySelector('time[datetime]');
        if (timeEl) article = timeEl.closest('article');
      }
    }
    if (!article) article = document.querySelector('article[data-testid="tweet"]');
    if (!article) article = document.querySelector('article');
    if (!article) throw new Error('No tweet found on this page');

    var author = '';
    var authorEl = article.querySelector('[data-testid="User-Name"]');
    if (authorEl) {
      var handleMatch = visibleText(authorEl).match(/@(\w+)/);
      if (handleMatch) author = handleMatch[1];
    }
    if (!author) {
      var pathParts = location.pathname.split('/');
      if (pathParts.length > 1 && pathParts[1] && pathParts[1] !== 'i') {
        author = pathParts[1];
      }
    }

    var textEl = article.querySelector('[data-testid="tweetText"]');
    var text = textEl ? visibleText(textEl) : '';

    var date = '';
    var timeElDate = article.querySelector('time[datetime]');
    if (timeElDate) {
      var dt = timeElDate.getAttribute('datetime');
      if (dt) {
        var d = new Date(dt);
        if (!isNaN(d.getTime())) {
          date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
          LOG&&console.log('[Swipe.ardy cs] Twitter date from <time datetime>:', dt, '->', date);
        }
      }
    }

    var reactions = 0, comments = 0, reposts = 0;

    var likeBtn = article.querySelector('[data-testid="like"], [data-testid="unlike"]');
    if (!likeBtn) likeBtn = article.querySelector('button[aria-label*="Like"]');
    if (likeBtn) reactions = extractCountFromButton(likeBtn);

    var replyBtn = article.querySelector('[data-testid="reply"]');
    if (!replyBtn) replyBtn = article.querySelector('button[aria-label*="repl"]');
    if (replyBtn) comments = extractCountFromButton(replyBtn);

    var retweetBtn = article.querySelector('[data-testid="retweet"], [data-testid="unretweet"]');
    if (!retweetBtn) retweetBtn = article.querySelector('button[aria-label*="Repost"], button[aria-label*="Retweet"]');
    if (retweetBtn) reposts = extractCountFromButton(retweetBtn);

    if (!reposts || !reactions || !comments) {
      var statLinks = article.querySelectorAll('a[aria-label], button[aria-label], [role="link"][aria-label]');
      for (var si = 0; si < statLinks.length; si++) {
        var label = (statLinks[si].getAttribute('aria-label') || '').toLowerCase();
        var num = extractCountFromButton(statLinks[si]);
        if (!num) continue;
        if (!reposts && /repost|retweet/i.test(label)) { reposts = num; }
        if (!reactions && /\blike\b/i.test(label)) { reactions = num; }
        if (!comments && /\brepl/i.test(label)) { comments = num; }
      }
      LOG&&console.log('[Swipe.ardy cs] Twitter stats from aria-label search:', { reactions: reactions, comments: comments, reposts: reposts });
    }

    var imgEls = article.querySelectorAll('img[src*="media"], img[src*="video_thumb"], [data-testid="tweetPhoto"] img');
    var twImgs = [];
    for (var ti = 0; ti < imgEls.length; ti++) { var s = imgEls[ti].src; if (s && s.indexOf('blob:') !== 0 && twImgs.indexOf(s) === -1) twImgs.push(s); }
    var image = twImgs.length > 0 ? twImgs.join(',') : '';

    return {
      author: author,
      text: text,
      reactions: reactions,
      comments: comments,
      reposts: reposts,
      postUrl: location.href,
      platform: 'X',
      image: image,
      date: date
    };
  }

  // ─── Pinterest Extraction ───

  function getPinterestImage() {
    var allImgs = document.querySelectorAll('img[src*="pinimg.com"]');
    var best = '';
    var bestArea = 0;
    for (var i = 0; i < allImgs.length; i++) {
      var img = allImgs[i];
      var src = img.src || '';
      var cls = (img.className || '').toLowerCase();
      if (!src || src.indexOf('data:') === 0) continue;
      if (cls.indexOf('avatar') !== -1 || cls.indexOf('profile') !== -1 || cls.indexOf('ghost') !== -1) continue;
      if (/\/75x75_RS\//.test(src) || /\/30x30\//.test(src) || /\/50x50\//.test(src)) continue;
      var w = img.naturalWidth || img.width || 0;
      var h = img.naturalHeight || img.height || 0;
      if (w < 100 || h < 100) continue;
      var area = w * h;
      if (area > bestArea) { bestArea = area; best = src; }
    }
    if (best) {
      return best.replace(/\/\d+x\d+([_a-zA-Z]*)\//, '/originals/');
    }
    return '';
  }

  function extractPinterest() {
    var author = '';
    var pinTitle = document.title || '';
    var pinDesc = '';
    var image = getPinterestImage();
    var reactions = 0;
    var date = '';

    // ─── Relay data (SPA-updated, has both title + description) ───
    if (__swipeardyRelayData) {
      var rd = __swipeardyRelayData;
      if (!author && rd.closeupAttribution && rd.closeupAttribution.fullName) author = rd.closeupAttribution.fullName;
      else if (!author && rd.pinner && rd.pinner.fullName) author = rd.pinner.fullName;
      if (!pinDesc && rd.closeupUnifiedDescription) pinDesc = rd.closeupUnifiedDescription;
      else if (!pinDesc && rd.description) pinDesc = rd.description;
      if (!image && rd.images && rd.images.orig && rd.images.orig.url) image = rd.images.orig.url;
      if (!date && rd.createdAt) {
        var dr = new Date(rd.createdAt);
        if (!isNaN(dr.getTime())) date = dr.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      }
      if (!reactions && rd.repinCount) reactions = rd.repinCount;
    }

    // ─── DOM structured-description (React-updated) ───
    if (!pinDesc) {
      var descEl = document.querySelector('[data-test-id="structured-description"] span');
      if (descEl) pinDesc = visibleText(descEl);
    }

    // ─── Leaf-snippet (fresh page only) ───
    if (!pinDesc || !author || !date) {
      var leafEl = document.querySelector('[data-test-id="leaf-snippet"]');
      if (leafEl) {
        try {
          var ld = JSON.parse(leafEl.textContent);
          if (ld) {
            if (!author && ld.author && ld.author.name) author = ld.author.name;
            if (!pinDesc && ld.articleBody) pinDesc = ld.articleBody;
            if (!date && ld.datePublished) {
              var d1 = new Date(ld.datePublished);
              if (!isNaN(d1.getTime())) date = d1.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
            }
            if (!reactions && ld.interactionStatistic && ld.interactionStatistic.length) {
              ld.interactionStatistic.forEach(function (s) {
                if (s.interactionType && s.interactionType.indexOf('Like') !== -1)
                  reactions = s.userInteractionCount || 0;
              });
            }
          }
        } catch(e) {}
      }
    }

    // ─── Redux state (fresh page, last resort) ───
    if (!pinDesc || !author || !date) {
      var propsEl = document.getElementById('__PWS_INITIAL_PROPS__') || document.getElementById('__PWS_DATA__');
      if (propsEl) {
        try {
          var json = JSON.parse(propsEl.textContent);
          var pins = (json.initialReduxState && json.initialReduxState.pins) || (json.props && json.props.initialReduxState && json.props.initialReduxState.pins);
          if (pins) {
            var pinKeys = Object.keys(pins);
            for (var pi = 0; pi < pinKeys.length; pi++) {
              var pin = pins[pinKeys[pi]];
              if (!pin.images) continue;
              if (!image && pin.images.orig && pin.images.orig.url) image = pin.images.orig.url;
              if (!pinDesc && pin.closeupUnifiedDescription) pinDesc = pin.closeupUnifiedDescription;
              else if (!pinDesc && pin.description) pinDesc = pin.description;
              if (!author && pin.closeupAttribution && pin.closeupAttribution.fullName) author = pin.closeupAttribution.fullName;
              else if (!author && pin.pinner && pin.pinner.fullName) author = pin.pinner.fullName;
              if (!date && pin.createdAt) {
                var d3 = new Date(pin.createdAt);
                if (!isNaN(d3.getTime())) date = d3.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
              }
              if (!reactions && pin.repinCount) reactions = pin.repinCount;
              if (image && pinDesc && author && date) break;
            }
          }
        } catch(e) {}
      }
    }

    // ─── DOM fill-ins ───
    if (!author) {
      var authorEl = document.querySelector('[data-test-id="creator-profile-name"] div');
      if (authorEl) author = visibleText(authorEl);
    }
    if (!image) {
      var imageEl = document.querySelector('meta[property="og:image"]');
      if (imageEl) image = imageEl.getAttribute('content');
    }
    if (!reactions) {
      var repinsEl = document.querySelector('meta[name="pinterestapp:repins"]');
      if (repinsEl) reactions = parseInt(repinsEl.getAttribute('content')) || 0;
    }

    // ─── Combine title + description ───
    var text = '';
    pinTitle = (pinTitle || '').trim();
    pinDesc = (pinDesc || '').trim();
    // Remove duplicate: if description already starts with title, don't repeat it
    if (pinTitle && pinDesc && pinDesc.indexOf(pinTitle) === 0) {
      text = pinDesc;
    } else if (pinTitle && pinDesc) {
      text = pinTitle + '\n\n' + pinDesc;
    } else {
      text = pinTitle || pinDesc || '';
    }

    LOG&&console.log('[Swipe.ardy cs] Pinterest final:', { author: author, text: (text||'').slice(0, 100), image: image.slice(0, 100), reactions: reactions, date: date });

    return {
      author: author,
      text: text,
      reactions: reactions || 0,
      comments: 0,
      reposts: 0,
      postUrl: location.href,
      platform: 'Pinterest',
      image: image,
      date: date
    };
  }

  // ─── Message Listener ───

  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (message.type === 'CHECK_PAGE') {
      var platform = detectPlatform();
      var isDetail = isPostDetailPage();
      LOG&&console.log('[Swipe.ardy cs] CHECK_PAGE ->', { platform: platform, isDetail: isDetail, url: location.href });
      sendResponse({ platform: platform, isDetail: isDetail });
      return;
    }

    if (message.type === 'EXTRACT') {
      var platform = detectPlatform();
      if (!platform) {
        LOG&&console.log('[Swipe.ardy cs] EXTRACT -> unsupported platform');
        sendResponse({ ok: false, error: 'This page is not LinkedIn, Twitter/X, or Pinterest.' });
        return;
      }
      try {
        LOG&&console.log('[Swipe.ardy cs] EXTRACT -> extracting from', platform);
        if (platform === 'LinkedIn') {
          extractLinkedIn().then(function(data) {
            LOG&&console.log('[Swipe.ardy cs] EXTRACT -> LinkedIn result', data);
            sendResponse({ ok: true, data: data });
          }).catch(function(e) {
            console.error('[Swipe.ardy cs] EXTRACT -> LinkedIn error', e.message);
            sendResponse({ ok: false, error: e.message });
          });
          return true;
        }
        var data = platform === 'Pinterest' ? extractPinterest() : extractTwitter();
        if (platform === 'X') fillVideoUrls([data]);
        LOG&&console.log('[Swipe.ardy cs] EXTRACT -> result', data);
        sendResponse({ ok: true, data: data });
      } catch (e) {
        console.error('[Swipe.ardy cs] EXTRACT -> error', e.message);
        sendResponse({ ok: false, error: e.message });
      }
      return;
    }

    if (message.type === 'SWIPEAR:DY_SCAN_PAGE') {
      var platform = detectPlatform();
      if (!platform) {
        sendResponse({ ok: false, error: 'Unsupported page' });
        return;
      }
      try {
        if (platform === 'X') { scanTwitterFromCache(sendResponse); return; }
        var posts = [];
        if (platform === 'LinkedIn') { posts = scanLinkedInPage(); }
        else if (platform === 'Pinterest') { posts = scanPinterestPage(); }
        sendResponse({ ok: true, posts: posts, count: posts.length });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
      return;
    }
  });

  function decodeLinkedInActivityTimestamp(idStr) {
    try {
      if (!idStr) return null;
      var clean = String(idStr).replace(/[^\d]/g, '');
      if (!clean) return null;
      var n = BigInt(clean);
      var bin = n.toString(2);
      if (bin.length < 41) return null;
      var tsBits = bin.slice(0, 41);
      var ms = parseInt(tsBits, 2);
      if (!Number.isFinite(ms) || ms <= 0) return null;
      var d = new Date(ms);
      if (Number.isNaN(d.getTime())) return null;
      return d;
    } catch (e) { return null; }
  }

  function buildLinkedInPostUrl(activityId) {
    try {
      if (!activityId) return '';
      var clean = String(activityId).replace(/[^\d]/g, '');
      if (!clean) return '';
      return 'https://www.linkedin.com/feed/update/urn:li:activity:' + clean + '/';
    } catch (e) { return ''; }
  }

  function scanLinkedInAuthor(card) {
    var selectors = [
      '[data-anonymize="person-name"]',
      '.update-components-actor__title span[dir="ltr"]',
      '.update-components-actor__name span[dir="ltr"]',
      '.feed-shared-actor__name span[dir="ltr"]',
      '.feed-shared-actor__title span[dir="ltr"]',
      'span.update-components-actor__name',
      'span.feed-shared-actor__name',
      'a[href*="/in/"]'
    ];
    for (var s = 0; s < selectors.length; s++) {
      var nodes = card.querySelectorAll(selectors[s]);
      for (var i = 0; i < nodes.length; i++) {
        var el = nodes[i];
        var txt = dedupeName(visibleText(el).replace(/\s+/g, ' ').trim());
        if (!txt) continue;
        var lower = txt.toLowerCase();
        if (lower === 'post' || lower === 'promoted') continue;
        if (txt.length > 80) continue;
        return txt;
      }
    }
    return 'Unknown Author';
  }

  function scanLinkedInSnippet(card) {
    var selectors = [
      '.update-components-text .break-words',
      '.update-components-text',
      '.feed-shared-update-v2__description-wrapper',
      '.feed-shared-inline-show-more-text',
      '.feed-shared-text',
      '.update-components-update-v2__commentary'
    ];
    var blacklist = ['following', 'premium', 'promoted', 'reposted this', 'visit my website', 'follow', 'message', 'subscribe'];
    for (var s = 0; s < selectors.length; s++) {
      var nodes = card.querySelectorAll(selectors[s]);
      for (var i = 0; i < nodes.length; i++) {
        var el = nodes[i];
        var txt = visibleText(el);
        if (!txt || txt.length < 20) continue;
        txt = txt.replace(/\b(Premium|Following|Follow)\b/gi, '').replace(/\s+/g, ' ').trim();
        var lower = txt.toLowerCase();
        var polluted = true;
        var hitCount = 0;
        for (var b = 0; b < blacklist.length; b++) {
          if (lower.indexOf(blacklist[b]) !== -1) hitCount++;
        }
        polluted = hitCount >= 3;
        if (polluted) continue;
        return txt;
      }
    }
    return '';
  }

  function scanLinkedInTime(card) {
    var result = { display: '' };
    var timeEl = card.querySelector('time');
    if (timeEl) {
      var dt = timeEl.getAttribute('datetime') || '';
      if (dt) {
        var date = new Date(dt);
        if (!Number.isNaN(date.getTime())) {
          result.display = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
          return result;
        }
      }
      var visible = visibleText(timeEl).trim();
      if (visible) { result.display = visible; return result; }
    }
    var activityId = extractLinkedInActivityId(card);
    if (activityId) {
      var decoded = decodeLinkedInActivityTimestamp(activityId);
      if (decoded) {
        result.display = decoded.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        return result;
      }
    }
    var relativeSelectors = [
      '.feed-shared-actor__sub-description',
      '.update-components-actor__sub-description',
      '.feed-shared-actor__meta',
      '.update-components-actor__meta'
    ];
    var relativeRe = /\b\d+\s*(?:s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|wk|wks|week|weeks|mo|mos|month|months|y|yr|yrs|year|years)\b(?:\s*ago)?/i;
    for (var sr = 0; sr < relativeSelectors.length; sr++) {
      var relNodes = card.querySelectorAll(relativeSelectors[sr]);
      for (var ri = 0; ri < relNodes.length; ri++) {
        var raw = visibleText(relNodes[ri]) || '';
        if (!raw) continue;
        var clean = raw.replace(/\s+/g, ' ').replace(/[\u2022\u00b7|]/g, ' ').trim();
        var match = clean.match(relativeRe);
        if (match) { result.display = match[0].trim(); return result; }
      }
    }
    return result;
  }

  function scanLinkedInImage(card) {
    var results = [];
    var seen = {};
    var selectors = [
      'img.update-components-image__image',
      'img.ivm-view-attr__img--centered',
      'img.feed-shared-image__image',
      'img[data-delayed-url]',
      '.update-components-image img',
      '.feed-shared-image img',
      '.feed-shared-carousel img'
    ];
    for (var s = 0; s < selectors.length; s++) {
      var nodes = card.querySelectorAll(selectors[s]);
      for (var i = 0; i < nodes.length; i++) {
        var img = nodes[i];
        var w = img.naturalWidth || img.width || 0;
        var h = img.naturalHeight || img.height || 0;
        if (w < 100 || h < 100) continue;
        var cls = (img.className || '').toLowerCase();
        var src = img.src || img.getAttribute('data-delayed-url') || '';
        if (!src || src.indexOf('data:') === 0) continue;
        if (cls.indexOf('actor') !== -1 || cls.indexOf('avatar') !== -1 || cls.indexOf('ghost') !== -1 || cls.indexOf('presence') !== -1) continue;
        if (/\/ghost\//i.test(src) || /profile-displayphoto/i.test(src) || /profile-framedphoto/i.test(src) || /comment-image/i.test(src)) continue;
        if (seen.hasOwnProperty(src)) continue;
        seen[src] = true;
        results.push(src);
      }
    }
    return results;
  }

  function getLinkedInLabel(card) {
    if (card.querySelector('.feed-shared-carousel__container, .update-components-carousel__container, [class*="carousel"]'))
      return 'Carousel';
    if (card.querySelector('.update-components-linkedin-video, video, .vjs-tech, [data-vjs-player], .media-player__player'))
      return 'Video';
    if (card.querySelector('.feed-shared-poll, .feed-shared-poll__container, [aria-label*="poll" i], [aria-label*="vote" i]'))
      return 'Poll';
    if (card.querySelector('.feed-shared-document__container, .update-components-document__container, [class*="document"]'))
      return 'Document';
    var imgs = scanLinkedInImage(card);
    if (imgs.length > 1) return 'Multiple images';
    if (imgs.length === 1) return 'Single image';
    return 'Text only';
  }

  function scanLinkedInPage() {
    var posts = [];
    var selectors = [
      'div.feed-shared-update-v2',
      'div.occludable-update',
      'div[data-urn*="activity"]',
      'div[data-id^="urn:li:activity"]'
    ];
    var seenKeys = {};

    for (var s = 0; s < selectors.length; s++) {
      var els = document.querySelectorAll(selectors[s]);
      for (var i = 0; i < els.length; i++) {
        var root = els[i].closest('div.feed-shared-update-v2') || els[i].closest('div.occludable-update') || els[i];
        if (!root || typeof root !== 'object') continue;
        var text = visibleText(root);
        if (!text || text.length < 40) continue;
        if (text.toLowerCase().indexOf('reposted this') !== -1) continue;

        var snippet = scanLinkedInSnippet(root);
        var activityId = extractLinkedInActivityId(root);
        var postUrl = buildLinkedInPostUrl(activityId) || extractLinkedInPostUrl(root);
        var dedupKey = (postUrl || '') + '::' + (snippet || '').slice(0, 120);
        if (seenKeys.hasOwnProperty(dedupKey)) continue;
        seenKeys[dedupKey] = true;

        var author = scanLinkedInAuthor(root);
        var counts = extractLinkedInCounts(root, '');
        var images = scanLinkedInImage(root);
        var image = images.length > 0 ? images.join(',') : extractLinkedInImage(root);

        var docContainer = root.querySelector('.feed-shared-document__container, .update-components-document__container, [class*="document"]');
        var documentUrl = '';
        if (docContainer) {
          var docLink = docContainer.querySelector('a[href*="sanitized-pdf"], a[href*="document/dms"], a[download]');
          if (docLink) documentUrl = docLink.href;
        }
        var timeInfo = scanLinkedInTime(root);
        var date = timeInfo.display || '';

        if (!snippet && images.length === 0) continue;

        var label = getLinkedInLabel(root);

        posts.push({
          author: author,
          date: date,
          platform: 'LinkedIn',
          text: snippet,
          image: image,
          images: images.length > 0 ? images : (image ? [image] : []),
          documentUrl: documentUrl,
          postUrl: postUrl,
          reactions: counts.reactions,
          comments: counts.comments,
          reposts: counts.reposts,
          filters: { Platform: 'LinkedIn', Category: label }
        });
      }
    }
    return posts;
  }

  function scanTwitterPage() {
    var posts = [];
    var articles = document.querySelectorAll('article[data-testid="tweet"]');
    for (var i = 0; i < articles.length; i++) {
      var article = articles[i];
      var author = '';
      var authorEl = article.querySelector('[data-testid="User-Name"]');
      if (authorEl) {
        var lines = authorEl.innerText.split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
        for (var li = 0; li < lines.length; li++) {
          if (lines[li].charAt(0) === '@') { author = lines[li].replace('@', ''); break; }
        }
        if (!author) author = lines[0] || '';
      }

      var textEl = article.querySelector('[data-testid="tweetText"]');
      var text = textEl ? visibleText(textEl) : '';

      var date = '';
      var timeEl = article.querySelector('time[datetime]');
      if (timeEl) {
        var dt = timeEl.getAttribute('datetime');
        if (dt) {
          var d = new Date(dt);
          if (!isNaN(d.getTime())) date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        }
      }

      var reactions = 0, comments = 0, reposts = 0;
      var likeBtn = article.querySelector('[data-testid="like"], [data-testid="unlike"]');
      if (!likeBtn) likeBtn = article.querySelector('button[aria-label*="Like"]');
      if (likeBtn) reactions = extractCountFromButton(likeBtn);
      var replyBtn = article.querySelector('[data-testid="reply"]');
      if (!replyBtn) replyBtn = article.querySelector('button[aria-label*="repl"]');
      if (replyBtn) comments = extractCountFromButton(replyBtn);
      var retweetBtn = article.querySelector('[data-testid="retweet"], [data-testid="unretweet"]');
      if (!retweetBtn) retweetBtn = article.querySelector('button[aria-label*="Repost"], button[aria-label*="Retweet"]');
      if (retweetBtn) reposts = extractCountFromButton(retweetBtn);

      var imgEls = article.querySelectorAll('img[src*="media"], img[src*="video_thumb"], [data-testid="tweetPhoto"] img');
      var twImgs = [];
      for (var ti = 0; ti < imgEls.length; ti++) { var s = imgEls[ti].src; if (s && s.indexOf('blob:') !== 0 && twImgs.indexOf(s) === -1) twImgs.push(s); }
      var image = twImgs.length > 0 ? twImgs.join(',') : '';
      var vid = article.querySelector('video'); if (vid) { var vsrc = vid.getAttribute('src'); if (!vsrc) { var ss = vid.querySelectorAll('source'); for (var si = 0; si < ss.length; si++) { if (ss[si].getAttribute('type') === 'video/mp4') { vsrc = ss[si].getAttribute('src'); break; } } } if (vsrc) image = vsrc; }

      var postUrl = '';
      var links = article.querySelectorAll('a[href*="/status/"]');
      for (var li2 = 0; li2 < links.length; li2++) {
        var href = links[li2].getAttribute('href') || '';
        var m = href.match(/^(\/[^/]+\/status\/\d+)(?:[/?#]|$)/);
        if (m) { postUrl = new URL(m[1], 'https://x.com').href; break; }
      }

      posts.push({
        author: author,
        date: date,
        platform: 'X',
        text: text,
        image: image,
        postUrl: postUrl || location.href,
        reactions: reactions,
        comments: comments,
        reposts: reposts,
        filters: { Platform: 'X', Source: 'x:bookmark' }
      });
    }
    return posts;
  }

  var twitterScannedCache = {};
  var twitterScannedCount = 0;
  var MAX_CACHE = 200;
  function _capObj(obj) {
    var keys = Object.keys(obj);
    if (keys.length <= MAX_CACHE) return;
    var toDel = keys.length - MAX_CACHE;
    for (var i = 0; i < toDel; i++) { delete obj[keys[i]]; }
  }

  function cacheTweetArticle(article) {
    var authorEl = article.querySelector('[data-testid="User-Name"]');
    var author = '';
    if (authorEl) {
      var lines = authorEl.innerText.split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
      for (var li = 0; li < lines.length; li++) {
        if (lines[li].charAt(0) === '@') { author = lines[li].replace('@', ''); break; }
      }
      if (!author) author = lines[0] || '';
    }
    var textEl = article.querySelector('[data-testid="tweetText"]');
    var text = textEl ? visibleText(textEl) : '';
    var date = '';
    var timeEl = article.querySelector('time[datetime]');
    if (timeEl) {
      var dt = timeEl.getAttribute('datetime');
      if (dt) { var d = new Date(dt); if (!isNaN(d.getTime())) date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); }
    }
    var reactions = 0, comments = 0, reposts = 0;
    var likeBtn = article.querySelector('[data-testid="like"], [data-testid="unlike"]');
    if (!likeBtn) likeBtn = article.querySelector('button[aria-label*="Like"]');
    if (likeBtn) reactions = extractCountFromButton(likeBtn);
    var replyBtn = article.querySelector('[data-testid="reply"]');
    if (!replyBtn) replyBtn = article.querySelector('button[aria-label*="repl"]');
    if (replyBtn) comments = extractCountFromButton(replyBtn);
    var retweetBtn = article.querySelector('[data-testid="retweet"], [data-testid="unretweet"]');
    if (!retweetBtn) retweetBtn = article.querySelector('button[aria-label*="Repost"], button[aria-label*="Retweet"]');
    if (retweetBtn) reposts = extractCountFromButton(retweetBtn);
    var imgEls = article.querySelectorAll('img[src*="media"], img[src*="video_thumb"], [data-testid="tweetPhoto"] img');
    var twImgs = [];
    for (var ti = 0; ti < imgEls.length; ti++) { var s = imgEls[ti].src; if (s && s.indexOf('blob:') !== 0 && twImgs.indexOf(s) === -1) twImgs.push(s); }
    var image = twImgs.length > 0 ? twImgs.join(',') : '';
    var vid = article.querySelector('video'); if (vid) { var vsrc = vid.getAttribute('src'); if (!vsrc) { var ss = vid.querySelectorAll('source'); for (var si = 0; si < ss.length; si++) { if (ss[si].getAttribute('type') === 'video/mp4') { vsrc = ss[si].getAttribute('src'); break; } } } if (vsrc) image = vsrc; }
    var postUrl = '';
    var links = article.querySelectorAll('a[href*="/status/"]');
    for (var li2 = 0; li2 < links.length; li2++) {
      var href = links[li2].getAttribute('href') || '';
      var m = href.match(/^(\/[^/]+\/status\/\d+)(?:[/?#]|$)/);
      if (m) { postUrl = new URL(m[1], 'https://x.com').href; break; }
    }
    if (!postUrl) return; if (twitterScannedCache.hasOwnProperty(postUrl) && twitterScannedCache[postUrl].image) return;
    twitterScannedCache[postUrl] = {
      author: author,
      date: date,
      platform: 'X',
      text: text,
      image: image,
      postUrl: postUrl,
      reactions: reactions,
      comments: comments,
      reposts: reposts,
      filters: { Platform: 'X', Source: 'x:bookmark' }
    };
    _capObj(twitterScannedCache);
    twitterScannedCount++;
  }

  function setupTwitterScanner() {
    if (location.hostname !== 'x.com' && location.hostname !== 'twitter.com') return;
    if (!document.body) { setTimeout(setupTwitterScanner, 200); return; }
    var _debounceTimer = null;
    var _pending = [];
    function _flushPending() {
      if (_pending.length === 0) return;
      for (var pi = 0; pi < _pending.length; pi++) { cacheTweetArticle(_pending[pi]); }
      _pending = [];
    }
    var obs = new MutationObserver(function (mutations) {
      for (var m = 0; m < mutations.length; m++) {
        var added = mutations[m].addedNodes;
        for (var i = 0; i < added.length; i++) {
          var node = added[i];
          if (node.nodeType !== 1) continue;
          if (node.tagName === 'ARTICLE' && node.getAttribute('data-testid') === 'tweet') { _pending.push(node); continue; }
          var articles = node.querySelectorAll ? node.querySelectorAll('article[data-testid="tweet"]') : [];
          for (var j = 0; j < articles.length; j++) { _pending.push(articles[j]); }
        }
      }
      if (_debounceTimer) clearTimeout(_debounceTimer);
      _debounceTimer = setTimeout(_flushPending, 200);
    });
    obs.observe(document.body, { childList: true, subtree: true });
    var existing = document.querySelectorAll('article[data-testid="tweet"]');
    for (var k = 0; k < existing.length; k++) { cacheTweetArticle(existing[k]); }
  }

  function scanTwitterFromCache(sendResponse) {
    if (twitterScannedCount > 0) {
      var visible = document.querySelectorAll('article[data-testid="tweet"]');
      for (var c = 0; c < visible.length; c++) { cacheTweetArticle(visible[c]); }
      var posts = [];
      var keys = Object.keys(twitterScannedCache);
      for (var i = 0; i < keys.length; i++) { posts.push(twitterScannedCache[keys[i]]); }
      fillVideoUrls(posts);
      sendResponse({ ok: true, posts: posts, count: posts.length });
    } else {
      var domPosts = scanTwitterPage();
      fillVideoUrls(domPosts);
      sendResponse({ ok: true, posts: domPosts, count: domPosts.length });
    }
  }

  function fillVideoUrls(posts) {
    var el = document.getElementById('swipeardy-video-cache');
    if (!el) return;
    try {
      var vcache = JSON.parse(el.textContent || '{}');
      for (var i = 0; i < posts.length; i++) {
        var tweetId = (posts[i].postUrl || '').match(/\/status\/(\d+)/) || [];
        tweetId = tweetId[1] || '';
        if ((!posts[i].image || /^blob:/i.test(posts[i].image)) && (vcache[posts[i].postUrl] || (tweetId && vcache[tweetId]))) {
          posts[i].image = vcache[posts[i].postUrl] || vcache[tweetId];
        }
      }
    } catch (e) {}
  }

  function scanPinterestPage() {
    var posts = [];
    var allImgs = document.querySelectorAll('img[src*="pinimg.com"]');
    var seen = {};
    for (var i = 0; i < allImgs.length; i++) {
      var img = allImgs[i];
      var src = img.src || '';
      if (!src || src.indexOf('data:') === 0) continue;
      var cls = (img.className || '').toLowerCase();
      if (cls.indexOf('avatar') !== -1 || cls.indexOf('profile') !== -1) continue;
      if (/\/75x75/.test(src) || /\/30x30/.test(src)) continue;
      var w = img.naturalWidth || img.width || 0;
      var h = img.naturalHeight || img.height || 0;
      if (w < 200 || h < 200) continue;
      var best = src.replace(/\/\d+x\d+([_a-zA-Z]*)\//, '/originals/');
      if (seen.hasOwnProperty(best)) continue;
      seen[best] = true;

      posts.push({
        author: '',
        date: '',
        platform: 'Pinterest',
        text: '',
        image: best,
        postUrl: location.href,
        reactions: 0,
        comments: 0,
        reposts: 0,
        filters: { Platform: 'Pinterest' }
      });
    }
    return posts;
  }

  setupTwitterScanner();
})();
