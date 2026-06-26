# Swipe.ardy — Architecture Guide for AI Agents

**Disclaimer:** This document describes the codebase as-is. It does not prescribe changes.
Read this first before making any modifications to understand how the pieces connect.

---

## Quick Start (30 seconds)

Vanilla JavaScript single-file app (`index.html`, ~1682 lines) with Supabase backend.
**No framework, no build tools, zero npm dependencies.**

Four content modes share a unified architecture:
`posts` | `creators` | `websites` | `snippets`

All items live in ONE Supabase table (`/swipes`) with a `type` field.
Items are split client-side into 4 parallel arrays on load.

---

## The Mode System — Read This First

Every mode has 4 parallel data stores:

| Mode | Data array | Filter definitions | Filter colors | Active filters |
|---|---|---|---|---|
| `posts` | `swipes[]` | `filters` | `filterColors` | `activeFilters` |
| `creators` | `creators[]` | `creatorFilters` | `creatorFilterColors` | `creatorActiveFilters` |
| `websites` | `websites[]` | `websiteFilters` | `websiteFilterColors` | `websiteActiveFilters` |
| `snippets` | `snippets[]` | `snippetFilters` | `snippetFilterColors` | `snippetActiveFilters` |

**Never access the backing variables directly. Always use the 3 getter functions:**
```js
getF()   → returns filter definitions   (categories + options for checkboxes)
getFC()  → returns filter colors        (hex values per option)
getAF()  → returns active filters       (which ones the user selected)
```

These auto-resolve based on `activeMode` (a string): `'posts'` | `'creators'` | `'websites'` | `'snippets'`.

**Example:** `getF()` returns `filters` when `activeMode='posts'`, `creatorFilters` when `activeMode='creators'`, etc.

---

## Supabase Tables

| Table | Stores | Accessed via |
|---|---|---|
| `swipes` | ALL items (4 modes). Split client-side by `item.type` field | REST GET/POST/PATCH/DELETE + Realtime channel `swipes-rt` |
| `filter_configs` | Filter definitions + colors per mode (`mode`, `filters`, `colors` columns) | REST GET/POST (upsert) + Realtime channel `filter-configs-rt` |
| `views_config` | Saved views array in a single row (`id=1`, `data` column) | REST GET/POST (upsert) + Realtime channel `views-rt` |

**Supabase connection:**
```js
const SB_URL = 'https://dmhiitzunsdqyxopqsby.supabase.co/rest/v1';
const SB_KEY = 'sb_publishable_ia350OuBQjG4Dw5V623eJw_m9Ftgn9F';
const SB_PROJECT = 'https://dmhiitzunsdqyxopqsby.supabase.co';
```

Key is publishable/anon — meant to be public. Without RLS policies, anyone with this key can CRUD everything.

---

## Data Flow: All Operations

### Save (create an item)
```
openAddModal() → user fills form → saveSwipe()
  1. Validate required fields per mode
  2. Build item object with { type: activeMode, id: Date.now(), ... }
  3. unshift into correct array (swipes/creators/websites/snippets)
  4. persist() to localStorage
  5. fetch POST /swipes to Supabase (fire-and-forget, .catch(()=>{}))
  6. closeAddModal() + applyFilters() + syncHash()
```

### Edit (update an item)
```
openEditModal(id) → find item in correct array → populate form → updateSwipe()
  1. Validate required fields per mode
  2. Mutate item properties in-place (no unshift)
  3. persist() + closeEditModal() + applyFilters()
  4. fetch PATCH /swipes?id=eq.{id} to Supabase (fire-and-forget)
```

### Delete
```
deleteSwipe(id)
  1. confirm() dialog
  2. Filter correct array by id (swipes = swipes.filter(...))
  3. persist() + applyFilters()
  4. fetch DELETE /swipes?id=eq.{id} to Supabase (fire-and-forget)
```

---

## Init Sequence (startup)

```
1. renderFilterBar()              (sync, empty — no data yet)
2. applyDensity()                 (sync)
3. [loading placeholder shown]   (sync)
4. init() (async IIFE):
   a. await loadSwipes()          → localStorage first, then Supabase GET /swipes
   b. await loadFilterConfigs()   → Supabase GET /filter_configs → merge into local state
   c. await loadViewsConfig()     → Supabase GET /views_config → replace views array
   d. setMode(activeMode, true)   → skipRender=true, no syncHash
   e. persist()                   → write everything to localStorage
   f. renderFilterBar() + applyFilters()  → full render with data
   g. loadFromHash()              → restore state from URL hash (if any)
   h. skipSync = false            → unlock syncHash for user interactions
   i. subscribeRealtime()         → 3 WebSocket channels
```

**Key detail:** `setMode` is called with `skipRender=true` to avoid premature hash writes during boot.
The hash is read by `loadFromHash()` which runs AFTER all data is loaded and rendered.

---

## How Filters Actually Work

```
User clicks "Niche: Business" checkbox
  → toggleFilter('Niche', 'Business')
  → getAF()['Niche'] = ['Business']  (adds to active filters)
  → renderFilterBar() + applyFilters()
  → applyFilters():
     const source = correct mode array (swipes/creators/websites/snippets)
     source.filter(item => {
       1. Search text matches? (in author, text, platform, filters, URL, followers)
       2. For each key in getAF():
          Does item.filters[key] match at least one selected value?
          If item doesn't have that key → item is filtered OUT
       return true if both pass
     })
  → renderCards(filteredData) + syncHash()
```

**Critical insight:** If Creator mode has active filter `{Niche: ['Business']}`:
- A Creator item with `filters: {Niche: 'Business'}` → MATCH → shown
- A Post item with `filters: {Category: 'Hooks'}` → `s.filters['Niche']` is `undefined` → NO MATCH → hidden
- A Creator item with `filters: {Niche: 'Marketing'}` → `['Business']` doesn't include `'Marketing'` → NO MATCH → hidden

This naturally prevents cross-mode filter contamination.

---

## `loadSwipes()` — How One Table Becomes 4 Arrays

```js
async function loadSwipes() {
    // Phase 1: localStorage fallback
    swipes = load(LS_SWIPES, null) || DEFAULT_SWIPES;
    creators = load(LS_CREATORS, null) || DEFAULT_CREATORS;
    websites = load(LS_WEBSITES, null) || DEFAULT_WEBSITES;
    snippets = load(LS_SNIPPETS, null) || DEFAULT_SNIPPETS;

    // Phase 2: Supabase fetch (overrides localStorage)
    const r = await fetch(SB_URL + '/swipes?order=id.desc');
    if (r.ok && r.json().length) {
        swipes = []; creators = []; websites = []; snippets = [];
        data.forEach(item => {
            if (item.type === 'creators') creators.push(item);
            else if (item.type === 'websites') websites.push(item);
            else if (item.type === 'snippets') snippets.push(item);
            else swipes.push(item);  // default bucket — also handles missing type
        });
    }
}
```

Items with no `type` field, `type: null`, `type: 'post'`, or any unrecognized value → `swipes[]`.

---

## URL Hash System

**Writing to URL:** `syncHash()` builds hash from current state. Called after every state change.
```js
syncHash() → builds: #mode=creators&nic=Business&sort=most-followers&q=justin
```

Filter keys are first 3 characters **lowercase**: `Niche` → `nic`, `Category` → `cat`, `Format` → `for`.

**Blocked during init:** `skipSync` starts as `true`. `syncHash()` returns early.
After `loadFromHash()` completes, `skipSync = false`.

**Reading from URL:** `loadFromHash()` parses hash and restores state.
Key matching is **case-insensitive** (`key.toLowerCase()` matched against lowercase filter key prefix).

---

## Card Rendering by Mode

Within `renderCards(data)`, each mode has a distinct card template:

**Posts:** Avatar initials, date, media preview (image/video/youtube), engagement badge.
**Creators:** Avatar image (with initials fallback), platform label, follower count badge.
**Websites:** No avatar, URL shown as domain subtext, external link icon.
**Snippets:** Minimal — title + content only. No image, no avatar, no engagement.

Tag rendering is shared across all 4 modes:
```js
tags.map(([k,v]) => { const c = getFC()[k] && getFC()[k][v]; ... })
```

---

## Saved Views (Presets)

Each view object: `{ name, mode, filters, sort, density, search }`

**`applyView(index)`:**
1. `setMode(v.mode, true)` — switch mode (skipRender to avoid premature hash)
2. Clear active filters for the target mode
3. Restore filters, sort, density, search from the preset
4. `persist(); renderFilterBar(); applyFilters(); syncHash()`

Views are stored in `views[]` array, synced to both localStorage (`swipeardy_views_v1`) and Supabase (`views_config` table, id=1).

---

## Realtime Sync

Three WebSocket channels via Supabase Realtime v2:

| Channel | Table | Handler |
|---|---|---|
| `swipes-rt` | `public.swipes` | `handleRealtimeChange()` |
| `filter-configs-rt` | `public.filter_configs` | `handleFilterConfigChange()` |
| `views-rt` | `public.views_config` | `handleViewsChange()` |

**Debounce:** `_localChange` timestamp prevents echo of local changes (1500ms window).

**`handleRealtimeChange(payload)`:**
1. If local change happened <1.5s ago → skip (prevents echo)
2. Remove item by id from ALL 4 arrays
3. If not a DELETE, insert into correct array by `item.type`
4. `persist()` + `applyFilters()`

---

## Fire-and-Forget Supabase Pattern

All Supabase writes use this pattern:
```js
fetch(SB_URL + '/swipes', {
    method: 'POST', // or PATCH, DELETE
    headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(item)
}).catch(()=>{})
```

**Silent failure.** Errors are swallowed. localStorage is the source of truth.
Supabase is a sync target — if it's unavailable the app continues working offline.

---

## Dark Mode

`toggleDark()` flips `data-theme` attribute on `<html>` between `'light'` and `'dark'`.
`initDark()` IIFE (runs on page load) checks localStorage first, then `prefers-color-scheme` media query as fallback.
Stored in `swipeardy_dark_v1` localStorage key.
CSS uses `[data-theme="dark"]` selector for dark variants of all custom properties.

---

## Filter Management (Settings Modal)

| Function | What it does |
|---|---|
| `addFilterGroup()` | Add new empty filter category (e.g., "Tone", "Length") |
| `deleteFilterGroup(key)` | Delete entire category and all its options |
| `addOption(key)` | Add option to a category with auto-assigned color |
| `removeOption(key, opt)` | Remove option; also cleans up from active filters |
| `renameFilter(oldKey, newKey)` | Rename category. Propagates change to ALL items' `filters[oldKey]` + views + PATCH each affected item to Supabase |
| `renameOption(key, oldOpt, newOpt)` | Rename an option value within a category. Same propagation logic |
| `setOptionColor(key, opt, color)` | Set hex color for a filter option |
| `saveFilterConfig()` | POST current mode's filters+colors to Supabase `filter_configs` |

---

## localStorage Keys

All keys prefixed with `swipeardy_`:

| Category | Keys |
|---|---|
| **Data arrays** | `swipes_v1`, `creators_v1`, `websites_v1`, `snippets_v1` |
| **Filter definitions** | `filters_v2` (posts), `creator_filters_v1`, `website_filters_v1`, `snippet_filters_v1` |
| **Filter colors** | `filter_colors_v1` (posts), `creator_filter_colors_v1`, `website_filter_colors_v1`, `snippet_filter_colors_v1` |
| **Filter state** | `filter_state_v1` (posts), `creator_filter_state_v1`, `website_filter_state_v1`, `snippet_filter_state_v1` |
| **UI state** | `mode_v1`, `grid_density_v1`, `views_v1`, `layout_v1`, `numeric_filters_v1`, `dark_v1` |

`persist()` writes ALL keys at once. Called after every state change.

---

## Chrome Extension

Located in `/extension/`. **Manifest V3.**

Uses the same Supabase `/swipes` table and same item format (with `type` field).
If you change the item schema in index.html, you MUST update the extension too.

**Extension files:**
- `manifest.json` — V3 manifest
- `background.js` — Service worker: message routing, bookmark polling, Supabase saves, dedup checks
- `content.js` — Content script for LinkedIn, Pinterest, X extraction
- `content/panel.js` — Floating panel UI injected by extension icon
- `content/x-bookmark-watcher.js` — X bookmark detection + toasts
- `content/x-graphql-interceptor.js` — X fetch interceptor (runs in MAIN world)

## Extension Message & Save Flow

### Message Types

The panel, content script, and background communicate via `chrome.runtime.sendMessage`:

| Message Type | Handled by | Notes |
|---|---|---|
| `EXTRACT` | Background → forwards to content script | Single-post extraction |
| `SWIPEAR:DY_SCAN_PAGE` | Background → forwards to content script | Page-level scan |
| `SAVE_SWIPE` | Background directly | Saves extracted data to Supabase (no dedup) |
| `SWIPEAR:DY_BOOKMARK` | `handleBookmarkSave` → `trySaveBookmark` | Single bookmark save with dedup |
| `SWIPEAR:DY_BOOKMARK_BATCH` | `handleBookmarkBatch` | Batch bookmark sync |
| `SWIPEAR:DY_BULK_IMPORT` | `handleBulkImport` (dedup per post) | Bulk array save via panel |
| `SWIPEAR:DY_REFRESH_TEMPLATE` | `saveRefreshTemplate` | Stores X API auth for bookmark polling |

### `lastTabId` (Tab Routing)

When the user clicks the extension icon, `chrome.action.onClicked` sets `lastTabId`. `EXTRACT` and `SWIPEAR:DY_SCAN_PAGE` messages are forwarded to that tab's content script via `chrome.tabs.sendMessage`.

Forwarding fallback (`background.js`):
```js
var targetTabId = lastTabId || (sender.tab && sender.tab.id);
```

If the service worker restarts (extension reload), `lastTabId` resets to null. The fallback uses the sender's tab ID instead.

### X Video Pipeline

`x-graphql-interceptor.js` (MAIN world, `document_start`) intercepts `window.fetch` and `XMLHttpRequest`. When responses contain `legacy.extended_entities.media.video_info.variants`, it extracts the highest-bitrate MP4 URL.

Flow:
```
Interceptor → postVideos() → writes swipeardy-video-cache DOM element (tweet ID as key)
            → also posts window.postMessage('tweet-videos')
                  → x-bookmark-watcher.js receives → also writes swipeardy-video-cache

content.js fillVideoUrls() → reads swipeardy-video-cache → replaces blob: URLs with real video.twimg.com URLs
```

`fillVideoUrls()` matches by full tweet URL first, then falls back to tweet ID extracted from `postUrl`. It is called in:
- `scanTwitterFromCache()` — during scan
- `EXTRACT` handler — during single-extract (X platform only)

### Extension Item Schema

`SAVE_SWIPE` constructs items WITHOUT a `type` field:

```js
var item = {
  id: Date.now(),
  author, date, platform, text, image,
  postUrl, reactions, comments, reposts,
  filters: message.data.filters || {}
};
```

In `loadSwipes()`, items without `type` fall into the default `swipes[]` bucket (posts mode). Extensions use `platform` field and `filters.Platform` to distinguish sources rather than `type`.

---

## Danger Zones — Be Careful Here

1. **`syncHash()` call placement.** Do NOT move it to run during init before `loadFromHash`. Always guard with `skipSync`.

2. **Filter key matching in `loadFromHash()`.** Keys must be compared **case-insensitively** (`key.toLowerCase()`). The URL uses first-3-char lowercase keys.

3. **Reassignment vs mutation.** Code does `activeFilters = {}` (reassignment). If you introduce a MODES config object pattern, you MUST use mutate-in-place (delete keys) instead, or `persist()` will read stale backing variables and localStorage will be out of sync.

4. **`_localChange` debounce guard.** Removing or shortening the 1500ms window causes realtime echo loops (user sees their own change applied twice).

5. **`type` field schema.** Extension, Supabase table, and client-side `loadSwipes()` all depend on the `type` field. Changing this field name or breaking the fallback-to-swipes pattern will break everything.

6. **Direct variable access.** Never access `filters`, `filterColors`, `activeFilters` directly. Always use `getF()`, `getFC()`, `getAF()`.

7. **`persist()` swallowing errors.** `persist()` uses `try/catch(e){}` — if localStorage is full or corrupted, errors are silently swallowed. The app continues but state may not save.

8. **Extension `background.js` criticality.** `background.js` runs as a Chrome service worker and handles ALL message routing and Supabase saves. If deleted, the entire extension breaks (no saves, no scan forwarding, no bookmark sync). Before commit `928c94c` it was untracked — a `git reset --hard` would permanently delete it. It is now tracked in git. Always commit it.
