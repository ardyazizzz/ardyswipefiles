const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const storage = {
  swipeardyBookmarksSeen: [],
  swipeardyBaselineEstablished: true,
  swipeardyCaptureVersion: 1
};
const alarmEvents = [];
let messageListener = null;
let fetchCalls = 0;

function readStorage(query) {
  const result = {};
  if (Array.isArray(query)) {
    for (const key of query) result[key] = storage[key];
  } else if (typeof query === 'string') {
    result[query] = storage[query];
  } else {
    for (const [key, fallback] of Object.entries(query || {})) {
      result[key] = Object.prototype.hasOwnProperty.call(storage, key) ? storage[key] : fallback;
    }
  }
  return result;
}

const chrome = {
  runtime: {
    onMessage: { addListener(listener) { messageListener = listener; } },
    onInstalled: { addListener() {} },
    onStartup: { addListener() {} }
  },
  storage: {
    local: {
      get(query, callback) { callback(readStorage(query)); },
      set(update, callback) {
        Object.assign(storage, update);
        if (callback) callback();
      }
    }
  },
  alarms: {
    create(name) { alarmEvents.push(['create', name]); },
    clear(name, callback) {
      alarmEvents.push(['clear', name]);
      if (callback) callback(true);
    },
    onAlarm: { addListener() {} }
  },
  action: { onClicked: { addListener() {} } },
  windows: {
    WINDOW_ID_NONE: -1,
    onFocusChanged: { addListener() {} }
  },
  tabs: {
    query(_query, callback) { callback([]); },
    sendMessage() {}
  },
  scripting: { executeScript() { return Promise.resolve(); } },
  cookies: { get(_query, callback) { callback(null); } }
};

const sandbox = {
  chrome,
  console,
  AbortController,
  Date,
  Promise,
  setTimeout,
  clearTimeout,
  fetch() {
    fetchCalls++;
    throw new Error('network should not be reached while bookmark auto-save is paused');
  }
};

const backgroundPath = path.join(__dirname, '..', 'background.js');
vm.runInNewContext(fs.readFileSync(backgroundPath, 'utf8'), sandbox, { filename: backgroundPath });
assert.equal(typeof messageListener, 'function');

function send(message) {
  return new Promise((resolve) => {
    const asyncResponse = messageListener(message, {}, resolve);
    if (asyncResponse !== true) setTimeout(() => resolve(undefined), 0);
  });
}

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

(async function run() {
  const initial = await send({ type: 'SWIPEAR:DY_BOOKMARK_AUTO_GET' });
  assert.deepEqual(plain(initial), { ok: true, enabled: true });

  const initiallyPaused = await send({ type: 'SWIPEAR:DY_BOOKMARK_AUTO_SET', enabled: false });
  assert.deepEqual(plain(initiallyPaused), { ok: true, enabled: false });
  assert.equal(storage.swipeardyBookmarkAutoSaveEnabled, false);

  const pausedSave = await send({
    type: 'SWIPEAR:DY_BOOKMARK',
    tweetId: '1001',
    pageUrl: 'https://x.com/example/status/1001',
    tweetMeta: {}
  });
  assert.deepEqual(plain(pausedSave), { ok: true, paused: true });
  assert.deepEqual(plain(storage.swipeardyBookmarksSeen), ['1001']);
  assert.equal(fetchCalls, 0);

  messageListener({
    type: 'SWIPEAR:DY_BOOKMARK_BATCH',
    bookmarks: [{ tweetId: '1002' }, { tweetId: '1003' }]
  }, {}, function () {});
  await flush();
  await flush();
  assert.deepEqual(plain(storage.swipeardyBookmarksSeen).sort(), ['1001', '1002', '1003']);
  assert.equal(fetchCalls, 0);

  const resumed = await send({ type: 'SWIPEAR:DY_BOOKMARK_AUTO_SET', enabled: true });
  assert.deepEqual(plain(resumed), { ok: true, enabled: true });
  assert.equal(storage.swipeardyBookmarkAutoSaveEnabled, true);
  assert.equal(storage.swipeardyBaselineEstablished, false);
  assert.ok(alarmEvents.some((event) => event[0] === 'create'));
  assert.equal(fetchCalls, 0);

  const paused = await send({ type: 'SWIPEAR:DY_BOOKMARK_AUTO_SET', enabled: false });
  assert.deepEqual(plain(paused), { ok: true, enabled: false });
  assert.equal(storage.swipeardyBookmarkAutoSaveEnabled, false);
  assert.ok(alarmEvents.some((event) => event[0] === 'clear'));
  assert.equal(fetchCalls, 0);

  console.log('X bookmark auto-save toggle tests passed.');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
