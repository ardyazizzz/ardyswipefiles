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
      if (!data || !data.author || (!data.text && !data.image && !data.documentUrl)) return;
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
    var counts = extractLinkedInCounts(card);
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
    var cleaned = String(text).replace(/[\u00a0\u2007\u202f]/g, ' ').trim();
    var m = cleaned.match(/(\d[\d\s.,'’]*)\s*([kKmMbB]?)(?=\s|\b|$)/);
    if (!m) return 0;
    var raw = m[1].replace(/[\s'’]/g, '');
    var suffix = m[2].toLowerCase();

    if (suffix) {
      var lastDot = raw.lastIndexOf('.');
      var lastComma = raw.lastIndexOf(',');
      var separatorIndex = Math.max(lastDot, lastComma);
      if (separatorIndex !== -1) {
        var fractionalDigits = raw.length - separatorIndex - 1;
        if (fractionalDigits > 0 && fractionalDigits <= 2) {
          raw = raw.slice(0, separatorIndex).replace(/[.,]/g, '') + '.' + raw.slice(separatorIndex + 1).replace(/[.,]/g, '');
        } else {
          raw = raw.replace(/[.,]/g, '');
        }
      }
    } else {
      // Engagement counts without a suffix are integers. LinkedIn localizes
      // thousands separators, so both "1,234" and "1.234" mean 1234 here.
      raw = raw.replace(/[.,]/g, '');
    }

    var num = parseFloat(raw);
    if (isNaN(num)) return 0;
    if (suffix === 'k') num *= 1000;
    if (suffix === 'm') num *= 1000000;
    if (suffix === 'b') num *= 1000000000;
    return Math.round(num);
  }

  function parseIntFromAria(el) {
    var label = el.getAttribute('aria-label') || '';
    return parseCompactNumber(label);
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

  var LINKEDIN_POST_ROOT_SELECTOR = 'div.feed-shared-update-v2, div.occludable-update, div[data-urn*="urn:li:activity:"], div[data-id^="urn:li:activity:"]';
  var LINKEDIN_COMMENT_SELECTOR = '.comments-comment-item, .comments-comments-list, .comments-comment-entity, .comments-replies-list, [class*="comments-comment"], [class*="comments-repl"], [data-id*="urn:li:comment"]';
  var LINKEDIN_ENGAGEMENT_SELECTOR = '.social-details-social-counts, .social-details-social-activity, .feed-shared-social-action-bar, .update-components-social-activity, [class*="social-details-social-counts"], [class*="social-details-social-activity"], [class*="social-action-bar"]';
  var LINKEDIN_COUNT_REGION_SELECTOR = '.social-details-social-counts, .feed-shared-social-action-bar, [class*="social-details-social-counts"], [class*="social-action-bar"]';
  var LINKEDIN_CAPTION_SELECTORS = [
    '[data-test-id="main-feed-activity-card__commentary"] .break-words',
    '[data-test-id="main-feed-activity-card__commentary"]',
    '[data-view-name="feed-commentary"] .break-words',
    '[data-view-name="feed-commentary"]',
    '.update-components-text .break-words',
    '.feed-shared-update-v2__description-wrapper .break-words',
    '.update-components-text',
    '.feed-shared-update-v2__description-wrapper',
    '.feed-shared-inline-show-more-text',
    '.feed-shared-text',
    '.update-components-update-v2__commentary'
  ];

  function linkedInNodeText(node) {
    if (!node) return '';
    var label = '';
    try { label = node.getAttribute('aria-label') || ''; } catch (e) {}
    return (label + ' ' + visibleText(node)).replace(/[\u00a0\u2007\u202f]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function linkedInMetricKinds(text) {
    var normalized = String(text || '').replace(/[\u00a0\u2007\u202f]/g, ' ').replace(/\s+/g, ' ').trim();
    var kinds = {};
    if (/\band\s+\d[\d\s.,'’]*(?:[kKmMbB])?\s+(?:others?|lainnya)\b/i.test(normalized) ||
        /\b\d[\d\s.,'’]*(?:[kKmMbB])?\s*(?:reactions?|likes?|reacted)\b/i.test(normalized)) kinds.reactions = true;
    if (/\b\d[\d\s.,'’]*(?:[kKmMbB])?\s*(?:comments?|replies|komentar|komentari|balasan)\b/i.test(normalized)) kinds.comments = true;
    if (/\b\d[\d\s.,'’]*(?:[kKmMbB])?\s*(?:reposts?|shares?|retweets?|dibagikan|posting ulang)\b/i.test(normalized)) kinds.reposts = true;
    return kinds;
  }

  function linkedInMetricKindCount(kinds) {
    return (kinds.reactions ? 1 : 0) + (kinds.comments ? 1 : 0) + (kinds.reposts ? 1 : 0);
  }

  function collectLinkedInMetricNodes(scope) {
    if (!scope || !scope.querySelectorAll) return [];
    var nodes = [];
    if (scope.getAttribute && linkedInMetricKindCount(linkedInMetricKinds(linkedInNodeText(scope)))) nodes.push(scope);
    var candidates = scope.querySelectorAll('span, a, p, button, [role="button"], [aria-label]');
    for (var i = 0; i < candidates.length; i++) {
      var node = candidates[i];
      var text = linkedInNodeText(node);
      if (!text || text.length > 220 || !linkedInMetricKindCount(linkedInMetricKinds(text))) continue;
      // Prefer the small text/label node. Large wrappers can contain a
      // caption sentence that happens to mention "comments".
      if (node.children && node.children.length > 2) continue;
      if (nodes.indexOf(node) === -1) nodes.push(node);
    }
    return nodes;
  }

  function linkedInActionKinds(scope) {
    var kinds = {};
    if (!scope || !scope.querySelectorAll) return kinds;
    var controls = scope.querySelectorAll('button, [role="button"], a');
    for (var i = 0; i < controls.length; i++) {
      var text = linkedInNodeText(controls[i]);
      if (!text || text.length > 100) continue;
      if (/\blike\b|\breaction\b|\bsuka\b/i.test(text)) kinds.like = true;
      if (/\bcomment\b|\bkomentar\b/i.test(text)) kinds.comment = true;
      if (/\brepost\b|\bshare\b|\bretweet\b|\bbagikan\b|\bposting ulang\b/i.test(text)) kinds.repost = true;
      if (/\bsend\b|\bkirim\b/i.test(text)) kinds.send = true;
    }
    return kinds;
  }

  function linkedInHasPostActionRow(scope) {
    var kinds = linkedInActionKinds(scope);
    if (kinds.like && kinds.comment && kinds.repost && kinds.send) return true;
    var text = visibleText(scope).replace(/\s+/g, ' ');
    return /\blike\b.{0,120}\bcomment\b.{0,120}\brepost\b.{0,120}\bsend\b/i.test(text) ||
      /\bsuka\b.{0,120}\bkomentar\b.{0,120}\b(?:posting ulang|bagikan)\b.{0,120}\bkirim\b/i.test(text);
  }

  function linkedInIsTooBroadScope(node) {
    if (!node) return true;
    var tag = String(node.tagName || '').toLowerCase();
    if (tag === 'main' || tag === 'body' || tag === 'html') return true;
    var id = '';
    try { id = node.getAttribute('id') || ''; } catch (e) {}
    return id === 'workspace';
  }

  function findLinkedInStructuralEngagementRoot(scope) {
    if (!scope || !scope.querySelectorAll) return null;
    var metricNodes = collectLinkedInMetricNodes(scope);
    var fallback = null;
    for (var mi = 0; mi < metricNodes.length; mi++) {
      var current = metricNodes[mi].parentElement || metricNodes[mi].parentNode;
      for (var depth = 0; current && depth < 14; depth++) {
        if (linkedInIsTooBroadScope(current)) break;
        var kinds = linkedInMetricKinds(linkedInNodeText(metricNodes[mi]));
        var hasActions = linkedInHasPostActionRow(current);
        var textLength = visibleText(current).length;
        var hasMedia = !!(current.querySelectorAll && current.querySelectorAll('img, video, iframe').length);
        if (hasActions && (textLength >= 120 || hasMedia)) return current;
        if (!fallback && hasActions) fallback = current;
        if (!fallback && linkedInMetricKindCount(kinds) >= 1 && textLength >= 80 && textLength < 2500) fallback = current;
        current = current.parentElement || current.parentNode;
      }
    }
    return fallback;
  }

  function structuralCardScore(card) {
    var textLength = Math.min(visibleText(card).length, 3000);
    var actions = linkedInActionKinds(card);
    var actionCount = (actions.like ? 1 : 0) + (actions.comment ? 1 : 0) + (actions.repost ? 1 : 0) + (actions.send ? 1 : 0);
    var media = card.querySelectorAll ? card.querySelectorAll('img, video, iframe').length : 0;
    var score = actionCount * 100 + Math.min(textLength, 800) / 20 + Math.min(media, 3) * 20;
    try {
      var rect = card.getBoundingClientRect();
      var viewportCenter = (window.innerHeight || 900) / 2;
      score -= Math.min(Math.abs((rect.top + rect.bottom) / 2 - viewportCenter), 1200) / 100;
    } catch (e) {}
    return score;
  }

  function findLinkedInStructuralCard() {
    if (!document || !document.querySelectorAll) return null;
    var metricNodes = collectLinkedInMetricNodes(document);
    var candidates = [];
    for (var i = 0; i < metricNodes.length; i++) {
      var card = findLinkedInStructuralEngagementRoot(metricNodes[i].parentElement || metricNodes[i]);
      if (!card || linkedInIsTooBroadScope(card) || candidates.indexOf(card) !== -1) continue;
      if (!linkedInHasPostActionRow(card)) continue;
      candidates.push(card);
    }
    candidates.sort(function (a, b) { return structuralCardScore(b) - structuralCardScore(a); });
    return candidates[0] || null;
  }

  function removeLinkedInCarouselMetadata(text) {
    var pageMatch = /\bPage\s+\d+\s+of\s+\d+\b/i.exec(text || '');
    if (!pageMatch) return text || '';
    var afterPage = String(text).slice(pageMatch.index);
    var pagesMatch = /\b\d+\s+pages?\b/i.exec(afterPage);
    var metricMatch = /\b\d[\d\s.,'’]*(?:[kKmMbB])?\s+(?:reactions?|comments?|reposts?|shares?)\b/i.exec(afterPage);
    if (pagesMatch && metricMatch) return String(text).slice(0, pageMatch.index).trim();
    return text || '';
  }

  function extractLinkedInStructuralCaption(card) {
    if (!card) return '';
    var fullText = visibleText(card);
    var postText = getPostAreaText(fullText) || fullText;
    if (!postText) return '';
    var candidates = [];
    var timestamp = postText.match(/\d+[hmdw]o?\s*·\s*|\d+\s+(?:seconds?|minutes?|hours?|days?|weeks?|months?|years?)\s*(?:ago)?\s*·\s*/i);
    if (timestamp) candidates.push(postText.slice(timestamp.index + timestamp[0].length).trim());
    candidates.push(postText);
    for (var i = 0; i < candidates.length; i++) {
      var candidate = candidates[i]
        .replace(/^(?:Follow|Connect|Connect with[^\n]*|Visible to anyone[^\n]*|View profile[^\n]*)\s*/i, '')
        .replace(/\bRepost\s+[\s\S]{0,120}?\bto help someone in your network\.?\s*/i, '')
        .trim();
      candidate = removeLinkedInCarouselMetadata(candidate);
      var cleaned = cleanSnippet(candidate);
      if (cleaned) return cleaned;
    }
    return '';
  }

  function getLinkedInPostRoot(node) {
    if (!node || !node.closest) return null;
    return node.closest(LINKEDIN_POST_ROOT_SELECTOR) || node.closest('article');
  }

  function belongsToLinkedInPost(node, card) {
    if (!node || !card) return false;
    var cardRoot = getLinkedInPostRoot(card) || card;
    var nodeRoot = getLinkedInPostRoot(node);
    return !nodeRoot || nodeRoot === cardRoot;
  }

  function isLinkedInCommentNode(node, card) {
    if (!node || !node.closest) return false;
    var commentRoot = node.closest(LINKEDIN_COMMENT_SELECTOR);
    return !!(commentRoot && (!card || !card.contains || card.contains(commentRoot)));
  }

  function isNodeBefore(a, b) {
    if (!a || !b || !a.compareDocumentPosition) return false;
    return !!(a.compareDocumentPosition(b) & 4); // DOCUMENT_POSITION_FOLLOWING
  }

  function getLinkedInContentBoundary(card) {
    if (!card || !card.querySelectorAll) return null;
    var nodes = card.querySelectorAll(LINKEDIN_ENGAGEMENT_SELECTOR + ', ' + LINKEDIN_COMMENT_SELECTOR);
    if (!nodes.length) nodes = collectLinkedInMetricNodes(card);
    var first = null;
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (!belongsToLinkedInPost(node, card)) continue;
      if (!first || isNodeBefore(node, first)) first = node;
    }
    return first;
  }

  function isSafeLinkedInCaptionNode(node, card, boundary) {
    if (!node || !belongsToLinkedInPost(node, card)) return false;
    if (isLinkedInCommentNode(node, card)) return false;
    if (node.closest && node.closest(LINKEDIN_ENGAGEMENT_SELECTOR)) return false;
    if (!boundary) return true;
    if (node === boundary) return false;
    if (node.contains && node.contains(boundary)) return false;
    if (boundary.contains && boundary.contains(node)) return false;
    return isNodeBefore(node, boundary);
  }

  function isSpecificLinkedInCaptionSelector(selector) {
    return selector.indexOf('main-feed-activity-card__commentary') !== -1 ||
      selector.indexOf('feed-commentary') !== -1 ||
      selector.indexOf('description-wrapper') !== -1 ||
      selector.indexOf('feed-shared-inline-show-more-text') !== -1 ||
      selector.indexOf('feed-shared-text') !== -1 ||
      selector.indexOf('update-components-update-v2__commentary') !== -1;
  }

  function findLinkedInEngagementBoundary(text) {
    if (!text) return -1;

    // LinkedIn often serializes the whole footer into one text node. Only
    // treat a complete engagement shape as a caption boundary; words such as
    // "like" or "comment" alone may be legitimate copy.
    var actionMatch = /\bLike\s+Comment\s+Repost\s+Send\b/i.exec(text);
    var actionIndex = actionMatch ? actionMatch.index : -1;
    var reactionIndex = -1;
    var reactionPattern;
    var reactionMatch;

    // Flattened footer form, for example:
    // "Name and N others reacted Name and N others 1,079 comments".
    reactionPattern = /\b((?:[A-Z][A-Za-z'’.-]*(?:[ \t]+[A-Z][A-Za-z'’.-]*){0,8})[ \t]+and[ \t]+\d[\d,.]*[ \t]+others?)[ \t]+reacted[ \t]+\1[ \t]+\d[\d,.]*[ \t]+comments?\b/i;
    reactionMatch = reactionPattern.exec(text);
    if (reactionMatch && (actionIndex === -1 || reactionMatch.index < actionIndex)) {
      reactionIndex = reactionMatch.index;
    }

    // Normal DOM form: keep this fallback line-anchored so ordinary caption
    // sentences are not mistaken for the footer.
    reactionPattern = /\n[ \t]*((?:[A-Z][A-Za-z'’.-]*(?:[ \t]+[A-Z][A-Za-z'’.-]*){0,8})[ \t]+and[ \t]+\d[\d,.]*[ \t]+others?[ \t]+reacted)\b/i;
    reactionMatch = reactionPattern.exec(text);
    if (reactionMatch) {
      var lineReactionIndex = reactionMatch.index + reactionMatch[0].indexOf(reactionMatch[1]);
      if ((actionIndex === -1 || lineReactionIndex < actionIndex) && (reactionIndex === -1 || lineReactionIndex < reactionIndex)) {
        reactionIndex = lineReactionIndex;
      }
    }

    // New LinkedIn layouts may flatten the summary into text such as
    // "958 reactions 385 comments 96 reposts" without a semantic footer
    // class. Treat the first explicit reaction count as a boundary only when
    // another engagement count or the action row follows nearby.
    var explicitReaction = /\b\d[\d\s.,'’]*(?:[kKmMbB])?\s+reactions?\b/i.exec(text);
    if (explicitReaction) {
      var nearbySummary = text.slice(explicitReaction.index, explicitReaction.index + 220);
      if (/\b\d[\d\s.,'’]*(?:[kKmMbB])?\s+(?:comments?|reposts?|shares?)\b/i.test(nearbySummary) || actionIndex !== -1) {
        if (reactionIndex === -1 || explicitReaction.index < reactionIndex) reactionIndex = explicitReaction.index;
      }
    }

    var commentIndex = -1;
    var commentPattern = /\b\d[\d\s.,'’]*(?:[kKmMbB])?\s+comments?\b/gi;
    var commentMatch;
    while ((commentMatch = commentPattern.exec(text))) {
      if (actionIndex === -1 || commentMatch.index < actionIndex) commentIndex = commentMatch.index;
    }

    if (actionIndex !== -1) {
      if (reactionIndex !== -1) return reactionIndex;
      if (commentIndex !== -1) return commentIndex;
      // A bare action row is safe only when it starts its own line.
      var lineAction = /(?:^|\n)[ \t]*Like\s+Comment\s+Repost\s+Send[ \t]*(?:\n|$)/i.exec(text);
      return lineAction ? lineAction.index + (lineAction[0].charAt(0) === '\n' ? 1 : 0) : -1;
    }

    // Without the action row, require a reaction summary followed shortly by
    // a comment count to avoid truncating legitimate caption text.
    if (reactionIndex !== -1 && commentIndex !== -1 && commentIndex - reactionIndex <= 180) return reactionIndex;

    var lineComment = /(?:^|\n)\s*\d[\d,.]*\s+comments?\b/i.exec(text);
    return lineComment ? lineComment.index + (lineComment[0].charAt(0) === '\n' ? 1 : 0) : -1;
  }

  function cleanSnippet(text) {
    if (!text) return '';
    text = String(text).replace(/\u00a0/g, ' ');
    var boundaries = ['Activate to view larger image', 'Add a comment', 'Open Emoji Keyboard', 'Like Reply', 'Like\nReply', 'Load more comments', 'Reaction button', 'Most relevant', 'most relevant', 'About\nAccessibility', 'Help Center', 'LinkedIn Corporation', 'Get the LinkedIn app', 'Privacy & Terms'];
    var boundaryIndex = -1;
    var boundaryLabel = '';
    for (var bi = 0; bi < boundaries.length; bi++) {
      var idx = text.indexOf(boundaries[bi]);
      if (idx !== -1 && (boundaryIndex === -1 || idx < boundaryIndex)) {
        boundaryIndex = idx;
        boundaryLabel = boundaries[bi];
      }
    }
    var engagementIndex = findLinkedInEngagementBoundary(text);
    if (engagementIndex !== -1 && (boundaryIndex === -1 || engagementIndex < boundaryIndex)) {
      boundaryIndex = engagementIndex;
      boundaryLabel = 'engagement footer';
    }
    if (boundaryIndex !== -1) {
      text = text.slice(0, boundaryIndex);
      LOG&&console.log('[Swipe.ardy cs] cleanSnippet: truncated at "' + boundaryLabel + '"');
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

  function extractLinkedInCaptionFromSelectors(card) {
    var boundary = getLinkedInContentBoundary(card);
    for (var i = 0; i < LINKEDIN_CAPTION_SELECTORS.length; i++) {
      var selector = LINKEDIN_CAPTION_SELECTORS[i];
      // Generic update-components-text classes are also used by comments.
      // Without a structural footer/comment boundary they are ambiguous.
      if (!boundary && !isSpecificLinkedInCaptionSelector(selector)) continue;
      var nodes = card.querySelectorAll(selector);
      for (var j = 0; j < nodes.length; j++) {
        var node = nodes[j];
        if (!isSafeLinkedInCaptionNode(node, card, boundary)) continue;
        var txt = visibleText(node);
        if (!txt) continue;
        txt = txt.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').trim();
        var cleaned = cleanSnippet(txt);
        if (!cleaned) continue;
        LOG&&console.log('[Swipe.ardy cs] Caption selector hit:', selector, '->', cleaned.slice(0, 150));
        return cleaned;
      }
    }
    return '';
  }

  function extractLinkedInSnippet(card) {
    // Captions must come from a top-level commentary node before the post's
    // engagement/comments boundary. If LinkedIn changes its DOM, fail closed
    // instead of treating a comment or nested post as the caption.
    var selectorCaption = extractLinkedInCaptionFromSelectors(card);
    if (selectorCaption) return selectorCaption;
    var structuralCaption = extractLinkedInStructuralCaption(card);
    if (structuralCaption) {
      LOG&&console.log('[Swipe.ardy cs] Snippet structural fallback hit:', structuralCaption.slice(0, 150));
      return structuralCaption;
    }
    LOG&&console.log('[Swipe.ardy cs] Snippet: no safe top-level caption matched');
    return '';
  }

  function extractLinkedInMetric(text, terms) {
    if (!text) return 0;
    var escaped = terms.map(function (term) { return term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }).join('|');
    var number = "\\d[\\d\\s.,'’]*(?:[kKmMbB])?";
    var patterns = [
      new RegExp('(' + number + ')\\s*(?:' + escaped + ')\\b', 'i'),
      new RegExp('(?:' + escaped + ')\\s*(' + number + ')', 'i')
    ];
    for (var i = 0; i < patterns.length; i++) {
      var match = String(text).match(patterns[i]);
      if (match) {
        var value = parseCompactNumber(match[1]);
        if (value) return value;
      }
    }
    return 0;
  }

  function getLinkedInEngagementRoots(card) {
    var roots = [];
    var seen = [];
    var nodes = card.querySelectorAll(LINKEDIN_COUNT_REGION_SELECTOR);
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (!belongsToLinkedInPost(node, card) || isLinkedInCommentNode(node, card)) continue;
      if (seen.indexOf(node) !== -1) continue;
      seen.push(node);
      roots.push(node);
    }
    if (!roots.length) {
      var structuralRoot = findLinkedInStructuralEngagementRoot(card);
      if (structuralRoot) roots.push(structuralRoot);
    }
    return roots;
  }

  function extractLinkedInBareReactionCount(root, comments, reposts) {
    if (!root || !root.querySelectorAll) return 0;
    var nodes = root.querySelectorAll('span, a, p, [aria-label]');
    for (var i = 0; i < nodes.length; i++) {
      var text = visibleText(nodes[i]).replace(/[\u00a0\u2007\u202f]/g, ' ').trim();
      if (!/^\d[\d.,'’\s]{0,20}$/.test(text)) continue;
      var value = parseCompactNumber(text);
      if (value && value !== comments && value !== reposts) return value;
    }
    var normalized = visibleText(root).replace(/[\u00a0\u2007\u202f]/g, ' ').replace(/\s+/g, ' ').trim();
    var inlineSummary = normalized.match(/\b(\d[\d.,'’]*)\s+\d[\d.,'’]*\s+comments?\b/i);
    if (inlineSummary) {
      var inlineValue = parseCompactNumber(inlineSummary[1]);
      if (inlineValue && inlineValue !== comments && inlineValue !== reposts) return inlineValue;
    }
    var segments = normalized.split(/[\n\u2022\u00b7|]+/).map(function (segment) { return segment.trim(); });
    for (var si = 0; si < segments.length; si++) {
      if (!/^\d[\d.,'’\s]{0,20}$/.test(segments[si])) continue;
      var segmentValue = parseCompactNumber(segments[si]);
      if (segmentValue && segmentValue !== comments && segmentValue !== reposts) return segmentValue;
    }
    return 0;
  }

  function extractLinkedInCounts(card) {
    var reactions = 0, comments = 0, reposts = 0;
    var commentTerms = ['comment', 'comments', 'reply', 'replies', 'komentar', 'komentari', 'balasan'];
    var repostTerms = ['repost', 'reposts', 'shared', 'share', 'shares', 'retweet', 'retweets', 'bagikan', 'dibagikan', 'posting ulang'];
    var reactionTerms = ['reaction', 'reactions', 'like', 'likes', 'reaksi', 'suka'];
    var roots = getLinkedInEngagementRoots(card);

    // Dedicated reaction count nodes have the highest confidence.
    var reactionNodes = card.querySelectorAll('.social-details-social-counts__reactions-count, [aria-label*="reaction" i], [aria-label*="reaksi" i]');
    for (var rn = 0; rn < reactionNodes.length && !reactions; rn++) {
      var reactionNode = reactionNodes[rn];
      if (!belongsToLinkedInPost(reactionNode, card) || isLinkedInCommentNode(reactionNode, card)) continue;
      if (!roots.some(function (root) { return root === reactionNode || (root.contains && root.contains(reactionNode)); })) continue;
      var reactionText = (reactionNode.getAttribute('aria-label') || '') + ' ' + visibleText(reactionNode);
      reactions = extractLinkedInMetric(reactionText, reactionTerms) || parseCompactNumber(visibleText(reactionNode));
    }

    for (var ri = 0; ri < roots.length; ri++) {
      var root = roots[ri];
      var labelled = root.querySelectorAll('[aria-label]');
      for (var li = 0; li < labelled.length; li++) {
        var label = labelled[li].getAttribute('aria-label') || '';
        if (!comments) comments = extractLinkedInMetric(label, commentTerms);
        if (!reposts) reposts = extractLinkedInMetric(label, repostTerms);
        if (!reactions) reactions = extractLinkedInMetric(label, reactionTerms);
      }

      var segments = visibleText(root).replace(/[\u00a0\u2007\u202f]/g, ' ').split(/[\n\u2022\u00b7|]+/).map(function (segment) { return segment.trim(); }).filter(Boolean);
      for (var si = 0; si < segments.length; si++) {
        if (!comments) comments = extractLinkedInMetric(segments[si], commentTerms);
        if (!reposts) reposts = extractLinkedInMetric(segments[si], repostTerms);
        if (!reactions) reactions = extractLinkedInMetric(segments[si], reactionTerms);
      }

      if (!reactions) {
        var summary = visibleText(root).replace(/[\u00a0\u2007\u202f]/g, ' ');
        var others = summary.match(/(?:and|dan)\s+(\d[\d\s.,'’]*(?:[kKmMbB])?)\s+(?:others?|lainnya)\b/i);
        if (others) {
          var otherCount = parseCompactNumber(others[1]);
          if (otherCount) reactions = otherCount + 1;
        }
      }

      if (!reactions) reactions = extractLinkedInBareReactionCount(root, comments, reposts);
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

  function linkedInDebugDescribeNode(node) {
    if (!node) return null;
    var result = { tag: String(node.tagName || '').toLowerCase() || 'unknown' };
    var cls = '';
    try { cls = node.getAttribute('class') || ''; } catch (e) {}
    if (cls) result.classes = cls.replace(/\s+/g, ' ').trim().slice(0, 300);
    var attrs = ['id', 'role', 'data-view-name', 'data-test-id', 'data-urn', 'data-id'];
    for (var i = 0; i < attrs.length; i++) {
      var value = '';
      try { value = node.getAttribute(attrs[i]) || ''; } catch (e) {}
      if (value) result[attrs[i]] = String(value).slice(0, 240);
    }
    try {
      var rect = node.getBoundingClientRect();
      result.rect = {
        top: Math.round(rect.top),
        left: Math.round(rect.left),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      };
    } catch (e) {}
    return result;
  }

  function linkedInDebugAncestry(node, limit) {
    var result = [];
    var current = node;
    while (current && result.length < limit) {
      result.push(linkedInDebugDescribeNode(current));
      if (current === document.body || current === document.documentElement) break;
      current = current.parentElement;
    }
    return result;
  }

  function linkedInDebugSelectorCounts(root, selectors) {
    var result = [];
    if (!root || !root.querySelectorAll) return result;
    for (var i = 0; i < selectors.length; i++) {
      var count = 0;
      try { count = root.querySelectorAll(selectors[i]).length; } catch (e) {}
      result.push({ selector: selectors[i], count: count });
    }
    return result;
  }

  function linkedInDebugMetricSignals(root, limit) {
    var result = [];
    if (!root || !root.querySelectorAll) return result;
    var nodes = root.querySelectorAll('span, a, button, [aria-label]');
    var maxNodes = Math.min(nodes.length, 1200);
    var metricPattern = /\d[\d\s.,'’]*(?:[kKmMbB])?\s*(?:reactions?|likes?|comments?|replies|reposts?|shares?|reaksi|suka|komentar|balasan|bagikan)|(?:reactions?|likes?|comments?|replies|reposts?|shares?|reaksi|suka|komentar|balasan|bagikan)\s*\d[\d\s.,'’]*(?:[kKmMbB])?/ig;
    var othersPattern = /(?:and|dan)\s+\d[\d\s.,'’]*(?:[kKmMbB])?\s+(?:others?|lainnya)/ig;
    for (var i = 0; i < maxNodes && result.length < limit; i++) {
      var node = nodes[i];
      var label = '';
      try { label = node.getAttribute('aria-label') || ''; } catch (e) {}
      var text = visibleText(node).replace(/\s+/g, ' ').trim();
      if (text.length > 140) text = '';
      var combined = (label + ' ' + text).replace(/\s+/g, ' ').trim();
      var matches = [];
      var match;
      metricPattern.lastIndex = 0;
      while ((match = metricPattern.exec(combined)) && matches.length < 3) matches.push(match[0]);
      othersPattern.lastIndex = 0;
      while ((match = othersPattern.exec(combined)) && matches.length < 3) matches.push(match[0]);

      if (matches.length === 0 && /^\d[\d\s.,'’]*(?:[kKmMbB])?$/.test(text)) {
        var contextClasses = '';
        var context = node;
        for (var ci = 0; ci < 3 && context; ci++) {
          try { contextClasses += ' ' + (context.getAttribute('class') || ''); } catch (e) {}
          context = context.parentElement;
        }
        if (/social|reaction|like|comment|repost|share/i.test(contextClasses)) matches.push(text);
      }
      if (matches.length === 0) continue;

      result.push({
        signal: matches.join(' | ').slice(0, 180),
        node: linkedInDebugDescribeNode(node),
        parent: linkedInDebugDescribeNode(node.parentElement)
      });
    }
    return result;
  }

  function linkedInDebugAttributeInventory(root) {
    var counts = {};
    if (!root || !root.querySelectorAll) return [];
    var nodes = root.querySelectorAll('[data-view-name], [data-test-id]');
    var maxNodes = Math.min(nodes.length, 800);
    for (var i = 0; i < maxNodes; i++) {
      var viewName = nodes[i].getAttribute('data-view-name') || '';
      var testId = nodes[i].getAttribute('data-test-id') || '';
      if (viewName) counts['data-view-name=' + viewName] = (counts['data-view-name=' + viewName] || 0) + 1;
      if (testId) counts['data-test-id=' + testId] = (counts['data-test-id=' + testId] || 0) + 1;
    }
    return Object.keys(counts).slice(0, 80).map(function (key) {
      return { attribute: key.slice(0, 240), count: counts[key] };
    });
  }

  function buildLinkedInDiagnostics(activityId, card, cardSource, caption, counts) {
    var activityNode = null;
    if (activityId) {
      activityNode = document.querySelector('[data-urn*="' + activityId + '"], [data-id*="' + activityId + '"]');
    }
    var boundary = getLinkedInContentBoundary(card);
    var engagementRoots = getLinkedInEngagementRoots(card);
    var parentScope = card;
    for (var i = 0; i < 3 && parentScope && parentScope.parentElement && parentScope.parentElement !== document.body; i++) {
      parentScope = parentScope.parentElement;
    }
    return {
      diagnosticVersion: 1,
      pagePath: location.pathname,
      activityId: activityId || '',
      cardSelection: cardSource || 'unknown',
      activityMatch: linkedInDebugDescribeNode(activityNode),
      activityAncestry: linkedInDebugAncestry(activityNode, 8),
      selectedCard: linkedInDebugDescribeNode(card),
      selectedCardTextLength: visibleText(card).length,
      selectedCardContainsActivityMatch: !!(card && activityNode && card.contains && card.contains(activityNode)),
      postRootMatchesOnPage: document.querySelectorAll(LINKEDIN_POST_ROOT_SELECTOR).length,
      captionLength: (caption || '').length,
      captionSelectorMatches: linkedInDebugSelectorCounts(card, LINKEDIN_CAPTION_SELECTORS),
      contentBoundary: linkedInDebugDescribeNode(boundary),
      engagementRootCount: engagementRoots.length,
      reactionCandidateCount: card.querySelectorAll('.social-details-social-counts__reactions-count, [aria-label*="reaction" i], [aria-label*="reaksi" i]').length,
      extractedCounts: counts,
      metricSignalsInCard: linkedInDebugMetricSignals(card, 12),
      parentScope: linkedInDebugDescribeNode(parentScope),
      metricSignalsInParentScope: linkedInDebugMetricSignals(parentScope, 16),
      structuralAttributesInParentScope: linkedInDebugAttributeInventory(parentScope)
    };
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
    var cardSource = card ? 'activity-id' : '';
    LOG&&console.log('[Swipe.ardy cs] Activity ID match:', card ? 'FOUND' : 'NOT FOUND');

    if (!card && activityId) {
      card = findCardByTimeElement();
      if (card) cardSource = 'time-element';
      LOG&&console.log('[Swipe.ardy cs] Time element match:', card ? 'FOUND' : 'NOT FOUND');
    }

    if (!card && activityId) {
      card = findCardByEngagement();
      if (card) cardSource = 'engagement-region';
      LOG&&console.log('[Swipe.ardy cs] Engagement match:', card ? 'FOUND' : 'NOT FOUND');
    }

    if (!card) {
      card = findLinkedInStructuralCard();
      if (card) cardSource = 'structural-signals';
      LOG&&console.log('[Swipe.ardy cs] Structural signal match:', card ? 'FOUND' : 'NOT FOUND');
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
      var fallbackSource = 'post-selector';
      if (cards.length === 0) {
        cards = Array.from(document.querySelectorAll('main'));
        fallbackSource = 'main';
        if (!cards.length) {
          cards = [document.body];
          fallbackSource = 'body';
        }
      }
      cards = cards.filter(function (c) { return visibleText(c).length >= 40; });
      cards.sort(function (a, b) { return a.getBoundingClientRect().top - b.getBoundingClientRect().top; });
      card = cards[0];
      if (card) cardSource = 'fallback-' + fallbackSource;
      LOG&&console.log('[Swipe.ardy cs] Fallback heuristic: picked card', card.tagName, visibleText(card).slice(0, 60));
    }

    if (!card) throw new Error('No LinkedIn post found on this page');

    var fullText = visibleText(card);
    var postText = getPostAreaText(fullText);
    LOG&&console.log('[Swipe.ardy cs] Card found, first 300 chars:', fullText.slice(0, 300));
    LOG&&console.log('[Swipe.ardy cs] Post area text (first 300):', postText.slice(0, 300));

    var author = extractLinkedInAuthor(card);
    var text = extractLinkedInSnippet(card);
    var counts = extractLinkedInCounts(card);
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

    var diagnostics = null;
    try {
      diagnostics = buildLinkedInDiagnostics(activityId, card, cardSource, text, counts);
    } catch (diagnosticError) {
      diagnostics = { diagnosticVersion: 1, error: diagnosticError.message || String(diagnosticError) };
    }

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
      date: date,
      __debug: diagnostics
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
            var debug = data && data.__debug ? data.__debug : null;
            if (data && data.__debug) delete data.__debug;
            sendResponse({ ok: true, data: data, debug: debug });
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
    return extractLinkedInCaptionFromSelectors(card);
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
        var counts = extractLinkedInCounts(root);
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

  // Exposed only when the regression test harness creates this object before
  // loading the content script. Normal extension pages never define it.
  if (window.__SWIPEARDY_TEST_HOOK__) {
    window.__SWIPEARDY_TEST_HOOK__.parseCompactNumber = parseCompactNumber;
    window.__SWIPEARDY_TEST_HOOK__.cleanSnippet = cleanSnippet;
    window.__SWIPEARDY_TEST_HOOK__.extractLinkedInMetric = extractLinkedInMetric;
    window.__SWIPEARDY_TEST_HOOK__.extractLinkedInCaptionFromSelectors = extractLinkedInCaptionFromSelectors;
    window.__SWIPEARDY_TEST_HOOK__.extractLinkedInCounts = extractLinkedInCounts;
    window.__SWIPEARDY_TEST_HOOK__.findLinkedInEngagementBoundary = findLinkedInEngagementBoundary;
    window.__SWIPEARDY_TEST_HOOK__.extractLinkedInStructuralCaption = extractLinkedInStructuralCaption;
    window.__SWIPEARDY_TEST_HOOK__.findLinkedInStructuralEngagementRoot = findLinkedInStructuralEngagementRoot;
    window.__SWIPEARDY_TEST_HOOK__.linkedInDebugMetricSignals = linkedInDebugMetricSignals;
  }

  setupTwitterScanner();
})();
