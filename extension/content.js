(function () {
  if (window.__swipeardyInjected) return;
  window.__swipeardyInjected = true;

  function detectPlatform() {
    var h = location.hostname;
    if (/linkedin\.com/.test(h)) return 'LinkedIn';
    if (/x\.com|twitter\.com/.test(h)) return 'Twitter';
    return null;
  }

  function isPostDetailPage() {
    var p = detectPlatform();
    if (p === 'LinkedIn') {
      return /\/feed\/update\/|activity:/.test(location.pathname) ||
             /\/posts\/[^/]+/.test(location.pathname);
    }
    if (p === 'Twitter') {
      return /\/status\/\d+/.test(location.pathname);
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
        return dedupeName(line);
      }
      console.log('[Swipe.ardy cs] Author from post text: all lines were filtered');
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
        console.log('[Swipe.ardy cs] Author selector hit:', selectors[i], '->', txt);
        return txt;
      }
    }
    console.log('[Swipe.ardy cs] Author: NO selectors matched');
    return '';
  }

  function cleanSnippet(text) {
    if (!text) return '';
    var boundaries = ['Most relevant', 'most relevant', 'Reaction button', 'Like\nReply', 'Add a comment', 'About\nAccessibility', 'Help Center', 'LinkedIn Corporation', 'Get the LinkedIn app', 'Privacy & Terms'];
    for (var bi = 0; bi < boundaries.length; bi++) {
      var idx = text.indexOf(boundaries[bi]);
      if (idx !== -1) {
        text = text.slice(0, idx);
        console.log('[Swipe.ardy cs] cleanSnippet: truncated at "' + boundaries[bi] + '"');
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
      console.log('[Swipe.ardy cs] cleanSnippet: stripped leading CTA');
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
      var tsMatch = postText.match(/\d+[hmdw]\s*[•·]\s*/);
      if (tsMatch) {
        var afterTs = postText.slice(postText.indexOf(tsMatch[0]) + tsMatch[0].length).trim();
        var cleaned = cleanSnippet(afterTs);
        console.log('[Swipe.ardy cs] Snippet from after timestamp ->', cleaned.slice(0, 200));
        if (cleaned.length > 20) return cleaned;
      }

      var lines = postText.split('\n');
      var captionLines = [];
      var pastTimestamp = false;
      for (var li = 0; li < lines.length; li++) {
        var line = lines[li].trim();
        if (!line) continue;
        if (line.indexOf('\u2022') === 0 || line.indexOf('•') === 0) continue;
        if (/^\d+[hmdw]/.test(line)) { pastTimestamp = true; continue; }
        if (!pastTimestamp && line.length <= 60) continue;
        if (pastTimestamp) captionLines.push(line);
      }
      if (captionLines.length > 0) {
        var snippet = captionLines.join(' ').replace(/\s+/g, ' ').trim();
        var cleaned2 = cleanSnippet(snippet);
        console.log('[Swipe.ardy cs] Snippet from lines after timestamp ->', cleaned2.slice(0, 200));
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
        console.log('[Swipe.ardy cs] Snippet selector hit:', selectors[i], '->', txt.slice(0, 150));
        return txt;
      }
    }
    console.log('[Swipe.ardy cs] Snippet: NO selectors matched — tried', selectors);
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

    console.log('[Swipe.ardy cs] Direct count query:', { reactions: reactions, comments: comments, reposts: reposts });

    var searchText = postAreaText || visibleText(card);
    console.log('[Swipe.ardy cs] Count search text FULL:', searchText);

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
    console.log('[Swipe.ardy cs] Bare number sequence found:', bareNumbers);
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
    console.log('[Swipe.ardy cs] Truncated search text (first 200):', skipSearchText.slice(0, 200));

    var commentTerms = ['comment', 'comments', 'komentar', 'komentari'];
    var repostTerms = ['repost', 'reposts', 'shared', 'share', 'shares'];
    var reactionTerms = ['reaction', 'reactions', 'like', 'likes'];
    var allTerms = commentTerms.concat(repostTerms).concat(reactionTerms);

    var normalized = skipSearchText.replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ');
    var segments = normalized.split(/[\n\u2022\u00b7|]+/).map(function (s) { return s.trim(); }).filter(Boolean);

    console.log('[Swipe.ardy cs] Count segments:', segments.slice(0, 30));

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

    console.log('[Swipe.ardy cs] Counts extracted:', { reactions: reactions, comments: comments, reposts: reposts });

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

  function extractLinkedIn() {
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
            console.log('[Swipe.ardy cs] Date fallback from <time datetime>:', dt, '->', date);
          }
        }
      }
    }

    console.log('[Swipe.ardy cs] Activity ID from URL:', activityId, 'Decoded date:', date);

    var sampleEls = document.querySelectorAll('[data-urn*="activity"], [data-id*="urn"], [data-activity-id], [data-activity], article, [class*="feed-shared-update"], [class*="occludable"]');
    console.log('[Swipe.ardy cs] DOM scan — elements found:', sampleEls.length);
    if (sampleEls.length > 0) {
      var first = sampleEls[0];
      console.log('[Swipe.ardy cs] First element tag:', first.tagName, 'class:', first.className, 'data-urn:', first.getAttribute('data-urn'), 'data-id:', first.getAttribute('data-id'), 'data-activity:', first.getAttribute('data-activity'));
    }

    var card = activityId ? findCardByActivityId(activityId) : null;
    console.log('[Swipe.ardy cs] Activity ID match:', card ? 'FOUND' : 'NOT FOUND');

    if (!card && activityId) {
      card = findCardByTimeElement();
      console.log('[Swipe.ardy cs] Time element match:', card ? 'FOUND' : 'NOT FOUND');
    }

    if (!card && activityId) {
      card = findCardByEngagement();
      console.log('[Swipe.ardy cs] Engagement match:', card ? 'FOUND' : 'NOT FOUND');
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
      console.log('[Swipe.ardy cs] Fallback heuristic: picked card', card.tagName, visibleText(card).slice(0, 60));
    }

    if (!card) throw new Error('No LinkedIn post found on this page');

    var fullText = visibleText(card);
    var postText = getPostAreaText(fullText);
    console.log('[Swipe.ardy cs] Card found, first 300 chars:', fullText.slice(0, 300));
    console.log('[Swipe.ardy cs] Post area text (first 300):', postText.slice(0, 300));

    var author = extractLinkedInAuthor(card);
    var text = extractLinkedInSnippet(card);
    var counts = extractLinkedInCounts(card, postText);
    var postUrl = extractLinkedInPostUrl(card);
    var image = extractLinkedInImage(card);

    return {
      author: author,
      text: text,
      reactions: counts.reactions,
      comments: counts.comments,
      reposts: counts.reposts,
      postUrl: postUrl,
      platform: 'LinkedIn',
      image: image,
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
          console.log('[Swipe.ardy cs] Twitter date from <time datetime>:', dt, '->', date);
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
      console.log('[Swipe.ardy cs] Twitter stats from aria-label search:', { reactions: reactions, comments: comments, reposts: reposts });
    }

    var imgEl = article.querySelector('img[src*="media"], [data-testid="tweetPhoto"] img');
    var image = imgEl ? (imgEl.src || '') : '';

    return {
      author: author,
      text: text,
      reactions: reactions,
      comments: comments,
      reposts: reposts,
      postUrl: location.href,
      platform: 'Twitter',
      image: image,
      date: date
    };
  }

  // ─── Message Listener ───

  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (message.type === 'CHECK_PAGE') {
      var platform = detectPlatform();
      var isDetail = isPostDetailPage();
      console.log('[Swipe.ardy cs] CHECK_PAGE ->', { platform: platform, isDetail: isDetail, url: location.href });
      sendResponse({ platform: platform, isDetail: isDetail });
      return;
    }

    if (message.type === 'EXTRACT') {
      var platform = detectPlatform();
      if (!platform) {
        console.log('[Swipe.ardy cs] EXTRACT -> unsupported platform');
        sendResponse({ ok: false, error: 'This page is not LinkedIn or Twitter/X.' });
        return;
      }
      try {
        console.log('[Swipe.ardy cs] EXTRACT -> extracting from', platform);
        var data = platform === 'LinkedIn' ? extractLinkedIn() : extractTwitter();
        console.log('[Swipe.ardy cs] EXTRACT -> result', data);
        sendResponse({ ok: true, data: data });
      } catch (e) {
        console.error('[Swipe.ardy cs] EXTRACT -> error', e.message);
        sendResponse({ ok: false, error: e.message });
      }
      return;
    }
  });
})();
