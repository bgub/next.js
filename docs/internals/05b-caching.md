# Caching & Revalidation

How Next.js caches rendered pages and fetch responses, and how
revalidation invalidates stale entries.

## Overview

Next.js has two caching layers between rendering and response delivery:

1. **Response Cache** — An in-memory LRU cache of rendered pages (HTML +
   Flight data). Deduplicates concurrent requests for the same page.
2. **Incremental Cache** — A persistent cache backed by the filesystem
   (or a custom `CacheHandler`). Stores rendered pages and fetch responses
   across server restarts.

```
Request arrives
     │
     ▼
ResponseCache (in-memory LRU)
     │
     ├── HIT → serve immediately
     │         (background revalidation if stale)
     │
     └── MISS → check IncrementalCache
                    │
                    ├── HIT → serve, populate ResponseCache
                    │
                    └── MISS → render page
                                │
                                └── store in both caches
```

## Cache entry types

**Defined in**: `packages/next/src/server/response-cache/types.ts`

```typescript
const enum CachedRouteKind {
  APP_PAGE   = 'APP_PAGE'    // App Router pages (HTML + RSC data)
  APP_ROUTE  = 'APP_ROUTE'   // App Router route handlers
  PAGES      = 'PAGES'       // Pages Router pages (HTML + page data)
  FETCH      = 'FETCH'       // Cached fetch() responses
  REDIRECT   = 'REDIRECT'    // Cached redirects
  IMAGE      = 'IMAGE'       // Optimized images
}
```

### `CachedAppPageValue`

The primary cache entry for App Router pages:

```typescript
interface CachedAppPageValue {
  kind: CachedRouteKind.APP_PAGE
  html: RenderResult // Rendered HTML
  rscData: Buffer | undefined // Flight data (RSC payload)
  status: number | undefined
  postponed: string | undefined // PPR postponed state
  headers: OutgoingHttpHeaders | undefined
  segmentData: Map<string, Buffer> | undefined // Per-segment prefetch data
}
```

When PPR is enabled, `postponed` contains the serialized state needed to
resume rendering the dynamic portions at request time.

## Response Cache

**Defined in**: `packages/next/src/server/response-cache/index.ts`

The `ResponseCache` is an in-memory LRU cache that sits in front of the
`IncrementalCache`. It serves two purposes:

1. **Request deduplication** — Uses a `Batcher` to coalesce concurrent
   requests for the same page. If multiple requests arrive for the same
   URL simultaneously, only one render executes.

2. **Fast serving** — Avoids filesystem reads for recently-accessed pages.

Cache keys are compound: `pathname + invocationID` (where `invocationID`
comes from the platform, e.g., a Lambda invocation). This prevents
cross-request cache pollution in serverless environments.

### Stale-while-revalidate

When a cached entry is stale (past its `revalidate` time but before
`expire`):

1. The stale entry is served immediately to the client
2. A background revalidation is triggered via the `revalidateBatcher`
3. The revalidation re-renders the page and updates both caches
4. Subsequent requests get the fresh entry

This is ISR (Incremental Static Regeneration) — pages are regenerated
in the background without blocking the current request.

## Incremental Cache

**Defined in**: `packages/next/src/server/lib/incremental-cache/index.ts`

The `IncrementalCache` is the persistent storage layer. It wraps a
`CacheHandler` (filesystem by default) and adds:

- **Tag-based invalidation** — Tracks which tags are associated with
  each cache entry
- **Revalidation time management** — Checks entry freshness against
  configured `revalidate` times
- **Lock management** — Prevents concurrent writes to the same cache key
- **Cache control tracking** — Maintains `SharedCacheControls` for
  revalidation/expiration times per route

### `CacheHandler` interface

**Default**: `packages/next/src/server/lib/incremental-cache/file-system-cache.ts`

The `CacheHandler` is the storage backend. The default filesystem handler
reads/writes to `.next/cache/`. Custom handlers can be provided via
`next.config.js`:

```typescript
// Legacy CacheHandler (incremental-cache/index.ts)
class CacheHandler {
  get(key, ctx): Promise<CacheHandlerValue | null>
  set(key, data, ctx): Promise<void>
  revalidateTag(tags, durations?): Promise<void>
  resetRequestCache(): void
}
```

There is also a **newer CacheHandler interface**
(`server/lib/cache-handlers/types.ts`) used by Cache Components:

```typescript
// Modern CacheHandler (cache-handlers/types.ts)
interface CacheHandler {
  get(cacheKey, softTags): Promise<CacheEntry | undefined>
  set(cacheKey, pendingEntry: Promise<CacheEntry>): Promise<void>
  refreshTags(): Promise<void>
  getExpiration(tags): Promise<Timestamp>
  updateTags(tags, durations?): Promise<void>
}
```

The modern interface uses `ReadableStream<Uint8Array>` values (supporting
streaming cache population) and separates tag refresh from tag invalidation.

## `fetch()` patching

**Defined in**: `packages/next/src/server/lib/patch-fetch.ts`

Next.js patches `globalThis.fetch` to add caching support. The patched
fetch intercepts every `fetch()` call during rendering and:

1. **Computes a cache key** — Based on URL, method, headers, body
2. **Checks the `next` options**:
   - `next.revalidate` — Time-based revalidation (seconds)
   - `next.tags` — Cache tags for on-demand invalidation
   - `cache: 'no-store'` — Skip caching entirely
   - `cache: 'force-cache'` — Always cache (default for static pages)
3. **Looks up the cache** — Checks `IncrementalCache` for a cached
   `FETCH` entry
4. **On miss** — Executes the real fetch, stores the response in cache
5. **On hit** — Returns the cached response (if not stale)

The cache key includes the request's URL, method, headers, and body
hash. Tags from `next.tags` are associated with the entry for later
invalidation.

### Dynamic interaction

During prerendering, `fetch()` calls without explicit cache options are
treated as cacheable. If `cache: 'no-store'` is used, the fetch is
treated as a dynamic data source — this triggers the same dynamic
detection mechanism described in
[Prerendering — Dynamic tracking](./05-prerendering.md#how-dynamic-access-is-detected).

## Revalidation APIs

**Defined in**: `packages/next/src/server/web/spec-extension/revalidate.ts`

### `revalidateTag(tag, profile)`

Invalidates all cache entries associated with the given tag. The `profile`
parameter controls how quickly the invalidation takes effect:

- A `cacheLife` profile name (e.g., `"max"`) — Uses the profile's
  `expire` time
- `{ expire: seconds }` — Custom expiration time

Internally, `revalidateTag` calls `revalidate()`, which:

1. Looks up the `IncrementalCache` from the work store
2. Adds tags to `store.pendingRevalidatedTags` (a deferred queue — the
   actual `cacheHandler.revalidateTag()` call happens later during
   action response processing, not inline)
3. Sets `pathWasRevalidated` on the work store (so the response includes
   fresh data after the action)

### `updateTag(tag)`

Like `revalidateTag` but with **immediate expiration** and restricted to
Server Actions only. Provides read-your-own-writes semantics — after
calling `updateTag` in a Server Action, the subsequent re-render sees
fresh data.

### `revalidatePath(path, type?)`

Converts the path into an implicit cache tag
(`_N_T_/path/type` format, e.g., `_N_T_/dashboard/layout`) and delegates
to the tag invalidation system. The `type` parameter (`'layout'` or
`'page'`) controls the tag suffix. Special case: the root path `/`
produces both `_N_T_/` and `_N_T_/index`.

### `refresh()`

Server Action-only. Marks `pathWasRevalidated` with a special sentinel
that tells the client router to refresh dynamic data without invalidating
server-side caches.

## How caching connects to rendering

In `base-server.ts`, the `renderToResponseWithComponentsImpl` method
orchestrates the cache lookup and render pipeline:

```
1. Compute ISR cache key from URL
2. Check if route is static (from prerender manifest)
3. Call responseCache.get(key, responseGenerator)
   │
   ├── Cache HIT: return cached HTML + RSC data
   │   └── If stale: trigger background revalidation
   │
   └── Cache MISS: call responseGenerator()
       │
       ├── For APP_PAGE: renderToHTMLOrFlight()
       │   → produces HTML + Flight data
       │
       └── Store result in responseCache + incrementalCache
           with revalidate time and tags
```

The `responseGenerator` callback is the actual render function — it only
executes on cache miss or revalidation. The cache layer ensures that
rendering is the last resort, not the first step.

## Key files

- `packages/next/src/server/response-cache/index.ts` — ResponseCache
  (in-memory LRU with request deduplication)
- `packages/next/src/server/response-cache/types.ts` — Cache entry types
  (`CachedRouteKind`, `CachedAppPageValue`, etc.)
- `packages/next/src/server/lib/incremental-cache/index.ts` —
  IncrementalCache (persistent cache wrapper)
- `packages/next/src/server/lib/incremental-cache/file-system-cache.ts` —
  Default filesystem CacheHandler
- `packages/next/src/server/lib/cache-handlers/types.ts` — Modern
  CacheHandler interface (for Cache Components)
- `packages/next/src/server/lib/patch-fetch.ts` — fetch() patching
- `packages/next/src/server/web/spec-extension/revalidate.ts` —
  `revalidateTag`, `revalidatePath`, `updateTag`, `refresh`
