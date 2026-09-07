const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const hooks = {};
const pageUrls = Array.from({ length: 17 }, (_, index) =>
  'https://media.licdn.com/dms/image/v2/D4E22AQCAROUSEL/' + (index + 1) + '/slide.png'
);
const masterUrl = 'https://media.licdn.com/dms/document/pl/v2/master.json?x=1';
const imageManifestUrl = 'https://media.licdn.com/dms/document/pl/v2/images.json?x=1';
const publicPostUrl = 'https://www.linkedin.com/feed/update/urn:li:activity:7477250373196464128/';
const fetchCalls = [];

function response(body) {
  return { ok: true, json: async () => body, text: async () => body };
}

const noopEvent = { addListener() {} };
const sandbox = {
  self: { __SWIPEARDY_TEST_HOOK__: hooks },
  console,
  AbortController,
  setTimeout,
  clearTimeout,
  crypto: { subtle: { digest() { throw new Error('not used in this test'); } } },
  fetch: async (url) => {
    fetchCalls.push(url);
    if (url === masterUrl) return response({ perResolutions: [
      { width: 1280, imageManifestUrl },
      { width: 1545, imageManifestUrl }
    ] });
    if (url === imageManifestUrl) return response({ pages: pageUrls });
    if (url === publicPostUrl) return response('&quot;manifestUrl&quot;:&quot;' + masterUrl.replace(/&/g, '&amp;') + '&quot;');
    throw new Error('Unexpected URL: ' + url);
  },
  chrome: {
    runtime: { onMessage: noopEvent, onInstalled: noopEvent, onStartup: noopEvent },
    action: { onClicked: noopEvent },
    alarms: { onAlarm: noopEvent },
    windows: { onFocusChanged: noopEvent },
    tabs: {},
    scripting: {},
    storage: { local: {} },
    cookies: {}
  }
};

const backgroundPath = path.join(__dirname, '..', 'background.js');
vm.runInNewContext(fs.readFileSync(backgroundPath, 'utf8'), sandbox, { filename: backgroundPath });

(async () => {
  const direct = await hooks.resolveLinkedInCarousel({
    manifestUrls: [masterUrl],
    postUrl: publicPostUrl,
    expectedPages: 17
  });
  assert.equal(direct.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(direct.pages)), pageUrls);
  assert.equal(direct.diagnostic.source, 'native-or-legacy-dom');
  assert.equal(direct.diagnostic.pageCount, 17);

  fetchCalls.length = 0;
  const publicFallback = await hooks.resolveLinkedInCarousel({
    manifestUrls: [],
    postUrl: publicPostUrl,
    expectedPages: 17
  });
  assert.equal(publicFallback.ok, true);
  assert.equal(publicFallback.diagnostic.source, 'public-html');
  assert.deepEqual(fetchCalls, [publicPostUrl, masterUrl, imageManifestUrl]);

  const rejected = await hooks.resolveLinkedInCarousel({
    manifestUrls: [masterUrl],
    postUrl: publicPostUrl,
    expectedPages: 18
  });
  assert.equal(rejected.ok, false, 'a manifest with the wrong number of pages must not be accepted');
  console.log('LinkedIn carousel background tests passed.');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
