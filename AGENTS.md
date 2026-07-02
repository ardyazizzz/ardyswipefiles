# Swipe.ardy — Architecture Guide for AI Agents

**Disclaimer:** This document describes the codebase as-is. It does not prescribe changes.
Read this first before making any modifications to understand how the pieces connect.

---

## Quick Start (30 seconds)

Vanilla JavaScript single-file app (`index.html`, ~1941 lines) with Supabase backend.
**No framework, no build tools, zero npm dependencies.**

Four content modes share a unified architecture:
`posts` | `creators` | `websites` | `snippets`

All items live in ONE Supabase table (`/swipes`) with a `type` field.
Items are split client-side into 4 parallel arrays on load.

**Auth:** Password Cerdas — hardcoded email + user-typed password via `sbRTC.auth.signInWithPassword()`.
Guests can browse (read-only); authenticated users can add/edit/delete.
RLS policies enforce this at the database level.

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

Key is publishable/anon — meant to be public. RLS policies protect write operations:
`anon` can only SELECT; `authenticated` can INSERT/UPDATE/DELETE.
Reads use `SB_KEY` (anon). Writes use `sbFetchAuth()` which sends the user's `access_token` as the Bearer.

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
  6. closeAddModal() + applyFilters() + showToast()
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
   a. await initAuth()            → check Supabase session, set data-auth attribute on <body>
   b. await loadSwipes()          → localStorage first, then Supabase GET /swipes
   c. await loadFilterConfigs()   → Supabase GET /filter_configs → merge into local state
   d. await loadViewsConfig()     → Supabase GET /views_config → replace views array
   e. setMode(activeMode, true)   → skipRender=true, no syncHash
   f. persist()                   → write everything to localStorage
   g. renderFilterBar() + applyFilters()  → full render with data
   h. loadFromHash()              → restore state from URL hash (if any)
   i. skipSync = false            → unlock syncHash for user interactions
   j. subscribeRealtime()         → 3 WebSocket channels
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

### Numeric Range Filters

Posts mode and Creators mode have numeric range filter inputs rendered in the filter bar (`renderFilterBar()`):
- **Posts:** Engagement (reactions + comments + reposts) Min / Max inputs
- **Creators:** Followers Min / Max inputs

State is stored in `numericFilters` object (`{ engMin, engMax, folMin, folMax }`, localStorage key `swipeardy_numeric_filters_v1`).
Set via `setNumericFilter(key, inputEl)`. Applied inside `applyFilters()` — items outside the min/max range are excluded.
Persisted in the URL hash as `engmin`, `engmax`, `folmin`, `folmax`.

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
syncHash() → builds: #mode=creators&nic=Business&sort=most-followers&folmin=10000&q=justin&density=1
Also writes `engmin`, `engmax` (posts) and `folmin`, `folmax` (creators) when non-default.
Omits `sort` if `currentSort === 'newest'` and `density` if `gridDensity === 0`.
Empties hash entirely if the result is exactly `#mode=posts`.
Uses `history.replaceState` (NOT `pushState`) so the browser Back button is unaffected.
```

Filter keys are first 3 characters **lowercase**: `Niche` → `nic`, `Category` → `cat`, `Format` → `for`.

**Blocked during init:** `skipSync` starts as `true`. `syncHash()` returns early.
After `loadFromHash()` completes, `skipSync = false`.

**Reading from URL:** `loadFromHash()` parses hash and restores state.
Key matching is **case-insensitive** using TWO strategies: the full filter key (lowercased) starts with the hash key, OR the first 3 characters match exactly. So both `niche=Business` and `nic=Business` resolve to the `Niche` category.

---

## Sort System

`applySort(val)` sorts the current mode's source array **in-place** (Array.sort mutation).
`sortSwipes(val)` wraps it: sets `currentSort`, clears `currentViewName`, then `renderFilterBar(); applyFilters(); syncHash()`.

Available sort options per mode (from the `<select class="sort-select">` dropdown):

| Mode | Options |
|---|---|
| **All modes** | `newest` (Newest added) + `oldest` (Oldest added) |
| **Posts** | + `most-engaged`, `least-engaged`, `most-liked`, `least-liked`, `most-commented`, `least-commented`, `most-reposted`, `least-reposted`, `longest` (Longest read), `shortest` (Quickest read), `media-first` (Has media first) |
| **Creators** | + `most-followers`, `least-followers`, `az` (A-Z), `za` (Z-A) |
| **Websites** | + `az`, `za` |
| **Snippets** | + `longest`, `shortest` |

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

### Media Pipeline — getMedia(url, postUrl)

`getMedia()` renders the media preview in posts mode cards, checked in this order:
1. Empty `url` → returns `''` (no media)
2. Comma-separated URLs (multi-image) → split by comma, render `<div class="card-thumbs">` with `<img class="thumb-img">` thumbnails in a horizontal scrollable row. Each thumbnail calls `openImageLightboxMulti(index, urlsStr)` on click.
3. `video.twimg.com` → `<video>` proxied through a Cloudflare Worker (`https://swipe-proxy.ardyazizrw.workers.dev/?url=...`)
4. YouTube (`youtube.com/watch` or `youtu.be`) → `<iframe>` embed
5. Vimeo (`vimeo.com`) → `<iframe>` embed
6. Direct video files (`.mp4`/`.webm`/`.mov`) → `<video muted playsinline controls preload="none" loop>`
7. Fallback → `<img loading="lazy">` with `onclick` lightbox (single-quote escaped), `onerror` hide, and `.card-img` class

The `postUrl` parameter is received by `getMedia()` but currently unused inside the function.

### Image Lightbox

Lightbox overlay (`#imageOverlay`) supports both single and multi-image navigation:
- **Single image:** `openImageLightbox(url)` — sets `_lbImages = [url]`, hides nav
- **Multi-image:** `openImageLightboxMulti(index, urlsStr)` — splits comma-separated URLs, shows prev/next arrows + position counter badge
- **Navigation:** `prevLightboxImage()` / `nextLightboxImage()` — circular wrap-around via `_lbImages[]` array + `_lbIndex`
- **Keyboard:** ArrowLeft → prev, ArrowRight → next, Escape → close
- **CSS:** `.lightbox-nav`, `.lightbox-prev`, `.lightbox-next`, `.lightbox-counter`, `.lightbox-close`

---

### Layout Modes (Posts only)

`layoutMode`: `'grid'` | `'masonry'` (localStorage key `swipeardy_layout_v1`).
A toggle button in the filter bar switches layouts (Posts mode only).

Masonry uses CSS `column-count` set in BOTH `applyDensity()` and `applyFilters()`:
- viewport > 1000px → 4 columns (5 when `gridDensity === 1`)
- viewport > 600px → 3 columns
- else → 2 columns
`grid.style.cssText = ''` restores the default grid layout for non-posts modes.

---

## Saved Views (Presets)

Each view object: `{ name, mode, filters, sort, density, search }`

**`applyView(index)`:**
1. `setMode(v.mode, true)` — switch mode (skipRender to avoid premature hash)
2. Clear active filters for the target mode
3. Restore filters, sort, density, search from the preset
4. `persist(); renderFilterBar(); applyFilters(); syncHash()`

Views are stored in `views[]` array, synced to both localStorage (`swipeardy_views_v1`) and Supabase (`views_config` table, id=1).

### Shareable Links

Each view has a "copy shareable link" button that calls `copyShareLink(index)` → `encodeShareLink(preset)`.
The generated URL contains `mode`, filter keys (3-char), `sort`, `density`, and `q` (search).
`loadFromHash()` restores this state when opened and shows a "Save as view" toast after 400ms.

**`currentViewName`** (default `null`) tracks whether the current filter/sort/search state matches a saved view.
It is set by `applyView()` and `saveCurrentView()`.
It is reset to `null` by ANY change to filters, sort, search, density, or mode.

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

All Supabase **writes** use `sbFetchAuth()` which auto-adds Supabase auth headers:
```js
sbFetchAuth('/swipes', { method: 'POST', body: sbBody }).catch(()=>{});
```

`sbFetchAuth()` uses the cached `_authToken` (user's `access_token` from Supabase Auth session)
as the Bearer token instead of the anon `SB_KEY`. If no session (guest), it falls back to `SB_KEY`
— but RLS will reject the write at the database level.

**Silent failure.** Errors are swallowed (`.catch(()=>{})`). localStorage is the source of truth.
Supabase is a sync target — if it's unavailable the app continues working offline.

There is also a legacy convenience wrapper `sbFetch(path, opts)` that auto-adds anon Supabase headers
(using `SB_KEY` as Bearer). It is no longer used for writes — all writes now go through `sbFetchAuth()`.
`sbFetch` is no longer called anywhere in `index.html` (reads use raw `fetch` directly with the anon key).

Both `saveFilterConfig()` and `saveViewsConfig()` POST with the header
`Prefer: resolution=merge-duplicates`, which tells Supabase to **upsert** (insert or update)
rather than error on duplicate key conflicts.

---

## Dark Mode

`toggleDark()` flips `data-theme` attribute on `<html>` between `'light'` and `'dark'`.
`initDark()` IIFE (runs on page load) checks localStorage first, then `prefers-color-scheme` media query as fallback.
Stored in `swipeardy_dark_v1` localStorage key.
CSS uses `[data-theme="dark"]` selector for dark variants of all custom properties.

---

## Auth System (Password Cerdas)

Single-user auth via Supabase Auth. The email is hardcoded in the source; only the password is typed by the user.

### How It Works

```
initAuth() → sbRTC.auth.getSession()
  ├─ Session found → data-auth="user" on <body>, _authToken cached
  └─ No session → data-auth="guest" on <body> (read-only mode)

Guest clicks "Sign in" → showAuthOverlay() → types password
  → sbRTC.auth.signInWithPassword({ email: AUTH_EMAIL, password })
  → on success → updateAuthState(session) → data-auth="user", overlay hidden
  → on failure → error message shown, user retries
```

### Key Variables

| Variable | Purpose |
|---|---|
| `AUTH_EMAIL` | Hardcoded email (const, line ~554). User must create this account in Supabase dashboard. |
| `currentUser` | Set to `session.user` when logged in, `null` when guest. Checked by guards. |
| `_authToken` | Cached `session.access_token`. Used by `sbFetchAuth()` as Bearer token. |

### `sbFetchAuth(path, opts)` vs `sbFetch(path, opts)`

| | `sbFetch` | `sbFetchAuth` |
|---|---|---|
| Bearer token | `SB_KEY` (anon) | `_authToken` (user session) or `SB_KEY` fallback |
| Used for | Reads (GET /swipes, /filter_configs, /views_config) | Writes (POST/PATCH/DELETE) |
| RLS result | SELECT allowed for anon | INSERT/UPDATE/DELETE allowed for authenticated |

### Guest Mode (Read-Only)

When `data-auth="guest"` on `<body>`, CSS hides:
- `#addBtn` (Add swipe button)
- `#manageFiltersBtn` (Manage filters button)
- `#logoutBtn` (Sign out button)
- `.card-btn` (Delete buttons on cards)
- `.card-edit-hint` (Click to edit hints)

JS guards also check `currentUser` in `openAddModal()`, `openEditModal()`, `deleteSwipe()` —
if null, they call `showAuthOverlay()` or return early.

### Session Persistence

Supabase Auth sessions are stored in localStorage by the Supabase JS client.
Once logged in, the session persists across page reloads (no need to login every time).
The `onAuthStateChange` listener handles session restoration and token refresh automatically.

### RLS Policies (must be enabled in Supabase dashboard)

```sql
-- Enable RLS on all 3 tables
ALTER TABLE swipes ENABLE ROW LEVEL SECURITY;
ALTER TABLE filter_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE views_config ENABLE ROW LEVEL SECURITY;

-- Public read + insert (anon can SELECT and INSERT)
-- INSERT is allowed so the Chrome extension can still save new items
CREATE POLICY "public_read" ON swipes FOR SELECT TO anon USING (true);
CREATE POLICY "public_insert" ON swipes FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "public_read" ON filter_configs FOR SELECT TO anon USING (true);
CREATE POLICY "public_read" ON views_config FOR SELECT TO anon USING (true);

-- Authenticated full access (using TO authenticated, NOT auth.role())
CREATE POLICY "auth_select" ON swipes FOR SELECT TO authenticated USING (true);
CREATE POLICY "auth_insert" ON swipes FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "auth_update" ON swipes FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_delete" ON swipes FOR DELETE TO authenticated USING (true);
CREATE POLICY "auth_all" ON filter_configs FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_all" ON views_config FOR ALL TO authenticated USING (true) WITH CHECK (true);
```

### Extension Impact

The Chrome extension saves to `/swipes` using the anon `SB_KEY` without authentication.
The RLS policy above allows anon INSERT, so the extension can still save new items.
But anon cannot UPDATE or DELETE — those operations require the authenticated user session.
This is a deliberate tradeoff: extension stays working, but data cannot be modified or deleted by anonymous users.

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

## LinkedIn Extraction Flow

### Extraction Order (in `extractLinkedIn()`)

```
1. extractCarouselImages()     ← FIRST: searches <code> JSON for carousel manifest
2. scanLinkedInImage(card)     ← FALLBACK: scans <img> tags with specific selectors
3. scanLinkedInImage(pageDoc)  ← FALLBACK: scans document container
4. extractLinkedInImage(card)  ← LAST RESORT: broad img search with URL filters
```

Carousel detection runs FIRST so it takes priority over regular image scanning. For non-carousel posts, `extractCarouselImages()` returns empty in ~1ms (no manifest in JSON).

### Carousel Detection — `<code>` JSON Approach

**Critical:** For logged-in users, LinkedIn does NOT use `data-native-document-config` iframe attributes (the Hermes workflow document was tested on non-logged-in pages). Instead, carousel data is stored in `<code>` elements as Relay/GraphQL JSON.

```
<code> element → JSON → "manifestUrl" → fetch manifest → perResolutions → imageManifestUrl → pages[]
```

- `extractCarouselImages()` — searches `<code>` elements for `feedshare-document-master-manifest`, extracts `manifestUrl` via regex, fetches manifest → image manifest → returns all slide URLs
- `extractCarouselCoversFromCode()` — fallback: extracts cover image URLs from the same JSON (3 images, 480px)
- `host_permissions` includes `https://media.licdn.com/*` for manifest fetches

### Image URL Pattern Filters

Both `scanLinkedInImage()` and `extractLinkedInImage()` filter out unwanted images by URL pattern:

| URL pattern | Filtered by | What it blocks |
|---|---|---|
| `profile-displayphoto` | Both | LinkedIn profile photos |
| `profile-framedphoto` | Both | LinkedIn framed profile photos (100x100) |
| `profile-displaybackgrou` | `extractLinkedInImage` only | LinkedIn profile backgrounds |
| `comment-image` | Both | LinkedIn comment attachments |
| `/ghost/` | Both | LinkedIn ghost placeholders |

### `cleanSnippet()` Boundary Ordering

`cleanSnippet()` truncates extracted text at the first boundary string found. **Boundary order matters** — boundaries are checked in array order, not text position order. Boundaries that appear EARLIER in the extracted text must be FIRST in the array:

```
['Activate to view larger image', 'Add a comment', 'Open Emoji Keyboard', 
 'Like Reply', 'Like\nReply', 'Load more comments', 'Reaction button',
 'Most relevant', 'most relevant', ...]
```

If `Most relevant` were first, it would match LATE in the text (after comment section), keeping unwanted UI chrome. Putting `Activate to view larger image` and `Add a comment` first ensures truncation happens right after the post content.

### Timestamp Detection

`extractLinkedInSnippet()` finds the post timestamp to separate header from content. The regex handles both formats:
- `5mo •` (abbreviated)
- `5 months ago •` (full text)

After the timestamp, LinkedIn header junk (`Follow`, `Connect`, `Visible to anyone...`) is stripped before returning the caption.

---

## Known Scale Limits & Tech Debt (Watchlist)

These are NOT bugs today; they are ceilings that bite as the dataset grows.

| Limit | Where | Typical threshold | Notes |
|---|---|---|---|
| **Supabase row cap** | `loadSwipes()` fetches `/swipes` with no pagination | default 1,000 rows | "Max rows" raised to 10,000 via dashboard. Still no code pagination — if the number of cards exceeds the Max-rows setting, older cards silently do not load. Code pagination will be needed around ~8,000+. |
| **localStorage size** | `persist()` serializes the entire dataset (~1.2 KB/card) | browser ~5 MB (~4,000 cards) | `QuotaExceededError` is swallowed silently per-key by individual try/catch blocks. The app continues but localStorage cache becomes stale. Data remains safe in Supabase. Fix later: store only UI prefs in localStorage, or move bulk data to IndexedDB. |
| **Render-all** | `renderCards()` builds ALL filtered cards into one innerHTML string | noticeable lag at thousands | Images use `loading="lazy"`. No pagination or virtual scrolling. |
| **XSS risk** | card content (`s.text`, `s.author`, filter values) inserted via innerHTML without escaping | extension scrapes untrusted web content | Add HTML-escaping before insertion for any data that sourced from untrusted input (e.g., X/Twitter scrape). |
| **RLS** | Supabase anon key (`SB_KEY`) is public in the source | — | RLS policies now enabled: anon can only SELECT and INSERT; authenticated can full CRUD. Extension still works (INSERT relies on anon policy). |

### Fragile selector coupling (handle with care)

- `setMode()` selects the active tab by its inline `onclick` attribute string:
  ```js
  .mode-segment[onclick="setMode('${mode}')"]
  ```
  Renaming `setMode` or changing the attribute format breaks this silently.

- `saveSwipe()` / `updateSwipe()` read form filter checkboxes via:
  ```js
  input[type=checkbox][value][onchange*="${key}"]
  ```
  The `[onchange*=...]` substring match against the `onchange` attribute is fragile — special characters in a filter key can break the CSS selector.

---

## Danger Zones — Be Careful Here

1. **`syncHash()` call placement.** Do NOT move it to run during init before `loadFromHash`. Always guard with `skipSync`.

2. **Filter key matching in `loadFromHash()`.** Keys must be compared **case-insensitively** (`key.toLowerCase()`). The URL uses first-3-char lowercase keys.

3. **Reassignment vs mutation.** Code does `activeFilters = {}` (reassignment). If you introduce a MODES config object pattern, you MUST use mutate-in-place (delete keys) instead, or `persist()` will read stale backing variables and localStorage will be out of sync.

4. **`_localChange` debounce guard.** Removing or shortening the 1500ms window causes realtime echo loops (user sees their own change applied twice).

5. **`type` field schema.** Extension, Supabase table, and client-side `loadSwipes()` all depend on the `type` field. Changing this field name or breaking the fallback-to-swipes pattern will break everything.

6. **Direct variable access.** Never access `filters`, `filterColors`, `activeFilters` directly. Always use `getF()`, `getFC()`, `getAF()`.

7. **`persist()` swallowing errors.** `persist()` uses `try/catch(e){}` — if localStorage is full or corrupted, errors are silently swallowed. The app continues but state may not save.

8. **`AUTH_EMAIL` must match Supabase dashboard.** The hardcoded email in `AUTH_EMAIL` must exactly match the user created in the Supabase Auth dashboard. If you change it in code without updating the dashboard, login will always fail.

9. **`sbFetchAuth` token caching.** `_authToken` is cached at login time and refreshed by `onAuthStateChange`. If you bypass `updateAuthState()` and set `_authToken` manually, token refresh may break silently.

10. **Extension `background.js` criticality.** `background.js` runs as a Chrome service worker and handles ALL message routing and Supabase saves. If deleted, the entire extension breaks (no saves, no scan forwarding, no bookmark sync). Before commit `928c94c` it was untracked — a `git reset --hard` would permanently delete it. It is now tracked in git. Always commit it.
