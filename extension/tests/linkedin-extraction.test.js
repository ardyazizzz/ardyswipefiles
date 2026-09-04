const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const hooks = {};
const sandbox = {
  window: { __SWIPEARDY_TEST_HOOK__: hooks },
  document: {
    body: {},
    addEventListener() {},
    querySelectorAll() { return []; },
    querySelector() { return null; },
    getElementById() { return null; }
  },
  location: { hostname: 'example.test', pathname: '/', href: 'https://example.test/' },
  chrome: {
    runtime: {
      onMessage: { addListener() {} },
      sendMessage() {}
    }
  },
  console,
  URL,
  Date,
  Map,
  setTimeout,
  clearTimeout
};

const contentPath = path.join(__dirname, '..', 'content.js');
vm.runInNewContext(fs.readFileSync(contentPath, 'utf8'), sandbox, { filename: contentPath });

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

class FakeNode {
  constructor({ kind = 'generic', text = '', order = 0, parent = null, ariaLabel = '' } = {}) {
    this.kind = kind;
    this.tagName = kind === 'post' || kind === 'structural-post' ? 'DIV' : 'SPAN';
    this.innerText = text;
    this.textContent = text;
    this.order = order;
    this.parent = parent;
    this.ariaLabel = ariaLabel;
    this.children = [];
    this.specificCaptionCandidates = [];
    this.genericCaptionCandidates = [];
    this.boundaries = [];
    this.engagementRoots = [];
    this.reactionNodes = [];
    this.labelledNodes = [];
    this.structuralMetricNodes = [];
    this.actionNodes = [];
    this.debugNodes = [];
    this.parentElement = parent;
  }

  getAttribute(name) {
    return name === 'aria-label' ? this.ariaLabel : null;
  }

  closest(selector) {
    let current = this;
    while (current) {
      if (selector.includes('feed-shared-update-v2') && current.kind === 'post') return current;
      if (selector.includes('comments-comment') && current.kind === 'comment') return current;
      if (selector.includes('social-details') && current.kind === 'engagement') return current;
      current = current.parent;
    }
    return null;
  }

  contains(other) {
    let current = other;
    while (current) {
      if (current === this) return true;
      current = current.parent;
    }
    return false;
  }

  compareDocumentPosition(other) {
    if (this.order < other.order) return 4;
    if (this.order > other.order) return 2;
    return 0;
  }

  querySelectorAll(selector) {
    if (selector === 'span, a, button, [aria-label]') return this.debugNodes;
    if (selector === 'span, a, p, button, [role="button"], [aria-label]') return this.structuralMetricNodes;
    if (selector === 'button, [role="button"], a') return this.actionNodes;
    if (selector === '[aria-label]') return this.labelledNodes;
    if (selector.includes('comments-comment') && selector.includes('social-details')) return this.boundaries;
    if (selector.includes('social-details-social-counts__reactions-count')) return this.reactionNodes;
    if (selector.includes('social-details-social-counts') || selector.includes('social-action-bar')) return this.engagementRoots;
    if (selector.includes('update-components-text')) return this.genericCaptionCandidates;
    if (selector.includes('commentary') || selector.includes('description-wrapper') || selector.includes('feed-shared')) return this.specificCaptionCandidates;
    return [];
  }

  querySelector() {
    return null;
  }

  getBoundingClientRect() {
    const top = this.order * 10;
    return { top, bottom: top + 100, left: 0, right: 800, width: 800, height: 100 };
  }
}

function makePostFixture() {
  const post = new FakeNode({ kind: 'post', order: 0 });
  const caption = new FakeNode({ text: 'A short, correct caption.', order: 1, parent: post });
  const footer = new FakeNode({ kind: 'engagement', text: '125 reactions\n12 comments\n3 reposts', order: 2, parent: post });
  const commentRoot = new FakeNode({ kind: 'comment', order: 3, parent: post });
  const comment = new FakeNode({ text: 'This comment must never become the caption.', order: 4, parent: commentRoot });
  const reaction = new FakeNode({ text: '125', order: 2.1, parent: footer, ariaLabel: '125 reactions' });
  const commentCount = new FakeNode({ text: '12', order: 2.2, parent: footer, ariaLabel: '12 comments' });
  const repostCount = new FakeNode({ text: '3', order: 2.3, parent: footer, ariaLabel: '3 reposts' });

  footer.labelledNodes = [reaction, commentCount, repostCount];
  post.specificCaptionCandidates = [caption, comment];
  post.genericCaptionCandidates = [caption, comment];
  post.boundaries = [footer, commentRoot];
  post.engagementRoots = [footer];
  post.reactionNodes = [reaction];
  return { post, caption, footer, commentRoot, comment };
}

function makeStructuralPostFixture() {
  const post = new FakeNode({
    kind: 'structural-post',
    order: 0,
    text: 'Feed post\nCharlie Hills\n2 days · Visible to anyone\nMost people will not read any of this. You did.\nPage 17 of 33 The Complete Guide to Building · 33 pages 958 reactions 958 385 comments 96 reposts'
  });
  const summary = new FakeNode({
    kind: 'engagement',
    order: 3,
    parent: post,
    text: 'and 131 others\n156 comments\n2 reposts\nLike\nComment\nRepost\nSend'
  });
  const reaction = new FakeNode({ text: 'and 131 others', order: 3.1, parent: summary });
  const commentCount = new FakeNode({ text: '156 comments', order: 3.2, parent: summary, ariaLabel: '156 comments' });
  const repostCount = new FakeNode({ text: '2 reposts', order: 3.3, parent: summary, ariaLabel: '2 reposts' });
  const actions = [
    new FakeNode({ text: 'Like', order: 3.4, parent: summary }),
    new FakeNode({ text: 'Comment', order: 3.5, parent: summary }),
    new FakeNode({ text: 'Repost', order: 3.6, parent: summary }),
    new FakeNode({ text: 'Send', order: 3.7, parent: summary })
  ];

  summary.structuralMetricNodes = [reaction, commentCount, repostCount];
  summary.labelledNodes = [reaction, commentCount, repostCount];
  summary.actionNodes = actions;
  post.structuralMetricNodes = [reaction, commentCount, repostCount];
  return { post, summary };
}

assert.equal(hooks.parseCompactNumber('1,234 reactions'), 1234);
assert.equal(hooks.parseCompactNumber('1.234 reactions'), 1234);
assert.equal(hooks.parseCompactNumber('1.2K reactions'), 1200);
assert.equal(hooks.parseCompactNumber('1,2K reactions'), 1200);
assert.equal(hooks.parseCompactNumber('2 M reactions'), 2000000);

{
  const debugRoot = new FakeNode();
  const metric = new FakeNode({ text: '34 comments • 5 reposts', parent: debugRoot });
  const privateComment = new FakeNode({ text: 'Private comment body that must not enter diagnostics.', parent: debugRoot });
  debugRoot.debugNodes = [metric, privateComment];
  const signals = plain(hooks.linkedInDebugMetricSignals(debugRoot, 10));
  assert.equal(signals.length, 1);
  assert.equal(signals[0].signal, '34 comments | 5 reposts');
  assert.equal(JSON.stringify(signals).includes('Private comment body'), false);
}

assert.equal(hooks.extractLinkedInMetric('12 comments', ['comment', 'comments']), 12);
assert.equal(hooks.extractLinkedInMetric('comments 12', ['comment', 'comments']), 12);

assert.equal(
  hooks.cleanSnippet('Caption only\nMost relevant\nComment body\nAdd a comment'),
  'Caption only',
  'cleanSnippet must use the earliest footer boundary in the text'
);

assert.equal(
  hooks.findLinkedInEngagementBoundary('Caption text\n958 reactions 385 comments 96 reposts'),
  'Caption text\n'.length,
  'flattened reaction/comment/repost summary must delimit the caption'
);

{
  const fixture = makePostFixture();
  assert.equal(hooks.extractLinkedInCaptionFromSelectors(fixture.post), 'A short, correct caption.');
  assert.deepEqual(
    plain(hooks.extractLinkedInCounts(fixture.post)),
    { reactions: 125, comments: 12, reposts: 3 }
  );
}

{
  const fixture = makeStructuralPostFixture();
  assert.equal(hooks.findLinkedInStructuralEngagementRoot(fixture.post), fixture.summary);
  assert.equal(
    hooks.extractLinkedInStructuralCaption(fixture.post),
    'Most people will not read any of this. You did.',
    'structural fallback must remove carousel metadata and engagement footer'
  );
  assert.deepEqual(
    plain(hooks.extractLinkedInCounts(fixture.post)),
    { reactions: 132, comments: 156, reposts: 2 },
    'structural fallback must count mutual reactions as total reactions'
  );
}

{
  const fixture = makeStructuralPostFixture();
  const bareReaction = new FakeNode({ text: '958', order: 3.1, parent: fixture.summary });
  const commentCount = new FakeNode({ text: '385 comments', order: 3.2, parent: fixture.summary, ariaLabel: '385 comments' });
  const repostCount = new FakeNode({ text: '96 reposts', order: 3.3, parent: fixture.summary, ariaLabel: '96 reposts' });
  fixture.summary.text = '958 385 comments 96 reposts Like Comment Repost Send';
  fixture.summary.innerText = fixture.summary.text;
  fixture.summary.textContent = fixture.summary.text;
  fixture.summary.structuralMetricNodes = [bareReaction, commentCount, repostCount];
  fixture.summary.labelledNodes = [bareReaction, commentCount, repostCount];
  fixture.post.structuralMetricNodes = [bareReaction, commentCount, repostCount];
  assert.deepEqual(
    plain(hooks.extractLinkedInCounts(fixture.post)),
    { reactions: 958, comments: 385, reposts: 96 },
    'structural fallback must preserve a bare reaction count when no mutual is shown'
  );
}

{
  const fixture = makePostFixture();
  fixture.post.specificCaptionCandidates = [fixture.comment];
  fixture.post.genericCaptionCandidates = [fixture.comment];
  assert.equal(
    hooks.extractLinkedInCaptionFromSelectors(fixture.post),
    '',
    'a comment must not be promoted to caption when the caption selector misses'
  );
}

{
  const fixture = makePostFixture();
  const nestedPost = new FakeNode({ kind: 'post', order: 0.5, parent: fixture.post });
  const nestedCaption = new FakeNode({ text: 'Nested repost caption', order: 1, parent: nestedPost });
  fixture.post.specificCaptionCandidates = [nestedCaption];
  fixture.post.genericCaptionCandidates = [nestedCaption];
  assert.equal(
    hooks.extractLinkedInCaptionFromSelectors(fixture.post),
    '',
    'a nested post must not become the outer post caption'
  );
}

{
  const post = new FakeNode({ kind: 'post', text: 'Our caption mentions 999 comments.', order: 0 });
  post.genericCaptionCandidates = [new FakeNode({ text: 'Our caption mentions 999 comments.', order: 1, parent: post })];
  assert.deepEqual(
    plain(hooks.extractLinkedInCounts(post)),
    { reactions: 0, comments: 0, reposts: 0 },
    'caption text must not be interpreted as engagement data'
  );
}

{
  const post = new FakeNode({ kind: 'post', order: 0 });
  post.genericCaptionCandidates = [new FakeNode({ text: 'Ambiguous generic text', order: 1, parent: post })];
  assert.equal(
    hooks.extractLinkedInCaptionFromSelectors(post),
    '',
    'generic text must fail closed when no footer or comment boundary exists'
  );
}

{
  const post = new FakeNode({ kind: 'post', order: 0 });
  post.specificCaptionCandidates = [new FakeNode({ text: 'Hi!', order: 1, parent: post })];
  assert.equal(
    hooks.extractLinkedInCaptionFromSelectors(post),
    'Hi!',
    'a short caption is valid when it comes from a caption-specific container'
  );
}

{
  const post = new FakeNode({ kind: 'post', order: 0 });
  const footer = new FakeNode({ kind: 'engagement', text: 'Alice and 27 others reacted', order: 2, parent: post });
  post.boundaries = [footer];
  post.engagementRoots = [footer];
  assert.deepEqual(plain(hooks.extractLinkedInCounts(post)), { reactions: 28, comments: 0, reposts: 0 });
}

console.log('LinkedIn extraction regression tests passed.');
