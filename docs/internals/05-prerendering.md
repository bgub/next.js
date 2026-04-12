# Prerendering & Static Generation

During `next build`, pages are prerendered to produce static HTML and Flight
data. This document covers the prerendering pipeline and its variants.

## Overview

Prerendering is orchestrated by `prerenderToStream()` in `app-render.tsx`.
It runs the same two-pass rendering pipeline described in
[Server Rendering](./04-server-rendering.md), but with additional machinery
to:

1. Detect whether a page is fully static or requires dynamic data
2. Produce static HTML and/or Flight data that can be served without
   re-rendering
3. Handle PPR (Partial Pre-Rendering) — static shells with dynamic holes
4. Handle Cache Components — multi-phase rendering with cache warming

## The static/dynamic decision

The key question during prerendering: **can this page be fully rendered at
build time, or does it need request-time data?**

A page becomes dynamic when it accesses:

- `cookies()`, `headers()`, `connection()` (request-specific APIs)
- `searchParams` (query string)
- `unstable_noStore()` / `revalidate: 0` (note: `unstable_noStore()` is a
  noop in Cache Components modes — `prerender`, `prerender-client`,
  `prerender-runtime`)
- `dynamic = 'force-dynamic'`

### How dynamic access is detected

Dynamic APIs are intercepted via the **work unit store** — an async-local
context (`work-unit-async-storage.external.ts`) that tracks what kind of
render is in progress. The store's `type` field determines how dynamic
access is handled:

| Store type                | Mode                                   | On dynamic access                                                                    |
| ------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------ |
| `prerender-legacy`        | Static generation (no PPR)             | Throws `DynamicServerError` — bails out entirely                                     |
| `prerender-ppr`           | PPR prerender                          | Calls `postponeWithTracking()` — current Suspense boundary becomes a hole            |
| `prerender`               | Cache Components (server, prospective) | Returns a **hanging promise** — never resolves, lets cache warming continue          |
| `prerender-client`        | Cache Components (client layer)        | Invariant error (should never happen)                                                |
| `prerender-runtime`       | Cache Components (runtime prefetch)    | Defers to runtime stage via `delayUntilRuntimeStage()`                               |
| `request`                 | Normal request-time render             | No-op (dynamic is expected)                                                          |
| `cache` / `private-cache` | Inside `"use cache"`                   | Sets `workStore.invalidDynamicUsageError` (deferred, thrown later during validation) |
| `unstable-cache`          | Inside `unstable_cache()`              | Similar to `cache`                                                                   |
| `generate-static-params`  | Inside `generateStaticParams()`        | N/A                                                                                  |
| `validation-client`       | Instant validation (dev)               | Similar to `prerender-client`                                                        |

For example, when `cookies()` is called during a PPR prerender:

```
cookies()
  → checks workUnitStore.type === 'prerender-ppr'
  → calls postponeWithTracking(route, 'cookies()', dynamicTracking)
    → records the access in dynamicTracking.dynamicAccesses[]
    → calls React.unstable_postpone(reason)
      → React catches this in the nearest Suspense boundary
      → That boundary becomes a "hole" in the static shell
```

### `DynamicTrackingState`

**Defined in**: `packages/next/src/server/app-render/dynamic-rendering.ts`

The `dynamicTracking` object records dynamic access during prerendering:

```typescript
type DynamicTrackingState = {
  readonly isDebugDynamicAccesses: boolean | undefined
  readonly dynamicAccesses: Array<DynamicAccess> // { expression, stack? }
  syncDynamicErrorWithStack: null | Error
}
```

Each `DynamicAccess` records the expression that triggered it (e.g.,
`"cookies()"`, `"headers()"`) and optionally a stack trace for debugging.
After prerendering, `getFirstDynamicReason()` reads the first entry to
report why a page was dynamic.

### `CacheSignal` — tracking cache reads

**Defined in**: `packages/next/src/server/app-render/cache-signal.ts`

With Cache Components, the prospective prerender needs to know when all
`"use cache"` reads have settled so it can stop rendering. `CacheSignal`
is a reference-counting mechanism:

- `beginRead()` — increments when a cache read starts
- `endRead()` — decrements when a cache read finishes
- `cacheReady()` — returns a Promise that resolves when the count reaches
  zero and stays there for at least one event loop tick

The tick delay is critical: when a cache read resolves, React schedules
new rendering work that may trigger more cache reads. `CacheSignal` waits
for the event loop to settle before declaring all reads complete.

The signal is stored on `PrerenderStoreModernCommon.cacheSignal` and
checked by `prerenderToStream()` to know when to abort the prospective
prerender.

## Prerendering without Cache Components

The `prerenderToStream()` function in `app-render.tsx` handles two
non-Cache-Components prerender modes. Both are single-pass.

### Legacy mode (`prerender-legacy`)

Used when PPR is **not** enabled. The prerender bails out entirely if any
dynamic API is called.

```
1. Create PrerenderStore (type: 'prerender-legacy')
   └── No dynamicTracking — relies on thrown errors to detect dynamic access

2. RSC render (pass 1):
   Run getRSCPayload() + renderToWebFlightStream()
   └── If a dynamic API is called → throws DynamicServerError
       → Caught by prerenderToStream → page marked as dynamic
       → No static output produced

3. SSR render (pass 2):
   Run renderToWebFizzStream() with the <App> component
   └── Consumes the Flight stream, produces HTML

4. Post-processing:
   ├── Collect Flight data for .rsc file
   ├── collectSegmentData() for per-segment prefetch data
   ├── Inline Flight data into HTML stream via createWebInlinedDataStream()
   └── Record revalidate time and tags from the store

5. Write static files (.html, .rsc, .meta, .segment.rsc)
```

### PPR mode (`prerender-ppr`)

Used when PPR is enabled but Cache Components is not. Dynamic APIs
trigger `postponeWithTracking()` instead of throwing, creating holes in
the static shell.

```
1. Create PrerenderStore (type: 'prerender-ppr')
   └── Includes dynamicTracking to record dynamic access

2. RSC render (pass 1):
   Run getRSCPayload() + renderToWebFlightStream()
   └── Dynamic APIs call postponeWithTracking()
       → React catches the postpone at the nearest Suspense boundary
       → Boundary becomes a hole; rendering continues elsewhere

3. SSR prerender (pass 2):
   Run getClientPrerender() (React's prerender API for PPR)
   └── Returns { prelude, postponed }
       prelude  = the static HTML shell
       postponed = React's opaque state for resuming the dynamic holes

4. Determine the outcome (three cases):
   a. Dynamic HTML — dynamic APIs used AND Suspense holes exist:
      → Serialize postponed state as DynamicHTMLPostponedState
      → Static shell served immediately; holes filled at request time

   b. Dynamic Data — dynamic APIs used but NO Suspense holes:
      → Serialize as DynamicDataPostponedState
      → HTML shell is static but Flight data regenerated at request time

   c. Fully Static — no dynamic APIs used:
      → Complete static output with inlined Flight data
      → No postponed state needed

5. Write static files (.html, .rsc, .meta, .segment.rsc)
   └── For dynamic cases: also write postponed state alongside the HTML
```

## Prerendering with Cache Components

With Cache Components enabled, prerendering uses a multi-phase approach
with cache warming, staged dynamic rendering, and per-segment prefetch
responses. See [Cache Components](./05a-cache-components.md) for the full
explanation.

## Postponed state

**Defined in**: `packages/next/src/server/app-render/postponed-state.ts`

When PPR is enabled and a page has dynamic holes, the postponed state is
serialized and stored alongside the static HTML.

### The two postponed types

```typescript
type PostponedState =
  | DynamicDataPostponedState // Dynamic in RSC pass (Flight data)
  | DynamicHTMLPostponedState // Dynamic in SSR pass (HTML shell)
```

**`DynamicDataPostponedState`** (`type: DynamicState.DATA`) — The dynamic
access occurred during the RSC render (pass 1). The entire Flight stream
needs to be regenerated at request time. The only persisted data is the
`renderResumeDataCache` (so `"use cache"` results survive).

**`DynamicHTMLPostponedState`** (`type: DynamicState.HTML`) — The Flight
stream was fully static, but the HTML shell has Suspense holes. Contains:

- `preludeState` — `DynamicHTMLPreludeState.Empty` (everything suspended)
  or `Full` (some content rendered)
- `postponed` — React's opaque postponed data (from `react-dom/static`'s
  `PrerenderResult.postponed`), which React uses to resume rendering
- `renderResumeDataCache` — Cached `"use cache"` results

### Serialization format

The postponed state is serialized as a string:

```
<postponedString.length>:<postponedString><renderResumeDataCache>
```

The `renderResumeDataCache` portion is compressed with zlib and
base64-encoded. For dynamic routes with fallback params, the serialized
state also includes replacement entries so that param placeholders can be
interpolated with actual values at request time.

### Resumption at request time

When a PPR page is requested:

```
1. Server loads the static HTML from cache/disk
2. Sends the HTML prelude immediately (fast TTFB)
3. Parses the postponed state via parsePostponedState()
4. If DynamicState.HTML:
   a. Calls React's resume API with the postponed data
   b. React renders only the dynamic holes (Suspense fallbacks)
   c. Streams the dynamic HTML chunks as they resolve
5. If DynamicState.DATA:
   a. Re-runs the full RSC render (Flight generation)
   b. SSRs the result to HTML
   c. Streams the complete response
```

For `HTML` resumption, the `renderResumeDataCache` is loaded so that
`"use cache"` functions return their cached results without re-execution.
Only the truly dynamic parts (e.g., `cookies()`, `headers()`) are
evaluated fresh.

## `"use cache"` functions

See [Cache Components — `"use cache"`](./05a-cache-components.md#use-cache--the-directive)
for how the directive is compiled and how caching works during prerendering
and at request time.
