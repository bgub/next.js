# Client-Side Rendering

How the browser hydrates the initial page and handles subsequent navigations.

## Hydration

### Boot sequence

1. **HTML arrives** — The browser receives server-rendered HTML including
   `<script>` tags containing the Flight data (`self.__next_f`).

2. **Bootstrap** — `app-index.tsx` contains the hydration logic (the actual
   entry points are `app-next.ts`, `app-next-dev.ts`, and
   `app-next-turbopack.ts`, which import and call `hydrate()` from
   `app-index.tsx`). It:
   - Calls `createFromReadableStream()` (React Flight client) to decode the
     embedded Flight data into the `InitialRSCPayload`
   - Creates the initial router state from the payload
   - Calls `hydrateRoot()` to attach React to the server-rendered DOM

3. **Reconciliation** — React walks the server-rendered DOM and matches it
   against the component tree reconstructed from the Flight data. Client
   components become interactive; server component output remains as static
   DOM.

### What happens to CSS during hydration

The CSS `<link>` and `<style>` elements from `getLayerAssets()` were rendered
to HTML during SSR (pass 2). They appear in the document before any component
content, so styles are applied before first paint.

React's `precedence` attribute on these elements enables deduplication:
if the same stylesheet URL appears multiple times (e.g., from different
navigation responses), React ensures only one `<link>` tag exists in the
DOM.

## The App Router (`packages/next/src/client/components/app-router.tsx`)

The App Router is the root client component. It manages:

- **Router state** — A tree of `FlightRouterState` nodes representing the
  current route segments
- **Cache nodes** — A parallel tree of `CacheNode` objects holding the
  rendered RSC output for each segment
- **Navigation** — Transitions between routes via `router.push()`,
  `router.replace()`, `<Link>`, etc.
- **Action queue** — Serializes state transitions (navigations, server
  actions, refreshes)

### Router state tree

The router maintains a `FlightRouterState` tree that mirrors the segment
hierarchy:

```typescript
// FlightRouterState
[
  segment,             // The URL segment for this node
  parallelRoutes: {    // Child nodes, keyed by parallel route key
    children: [childSegment, { ... }, ...]
  },
  refreshState?,       // CompressedRefreshState — [url, renderedSearch] for
                       // refreshing non-matching parallel route slots
  refresh?,            // 'refetch' | 'inside-shared-layout' | 'metadata-only' | null
                       // Controls which segments the server re-renders
  prefetchHints?,      // Bitmask encoding route structure metadata (root layout,
                       // loading boundaries, instant configs)
]
```

### Cache node tree

Parallel to the router state, the cache tree stores rendered output:

```typescript
type CacheNode = {
  rsc: React.ReactNode // Rendered RSC output (null = missing, suspend)
  prefetchRsc: React.ReactNode // Static prefetched version (may have dynamic holes)
  prefetchHead: HeadData | null // Prefetched head metadata
  head: HeadData // Head metadata (viewport, etc.)
  slots: Record<string, CacheNode> | null // Child segments by key
  scrollRef: ScrollRef | null // Shared scroll tracking ref for navigation
}
```

During rendering, React chooses between `rsc` and `prefetchRsc` via
`useDeferredValue`. If both are null, `LayoutRouter` suspends and triggers
a lazy fetch.

## Client-side navigation

When the user navigates (via `<Link>`, `router.push()`, back/forward, etc.):

### 1. Router state update

The router reducer computes the new `FlightRouterState` by comparing the
current state with the target URL. It determines:

- Which segments are shared (reusable from cache)
- Which segments need new data (different from current)

### 2. Flight data fetch

For segments that need new data, `fetchServerResponse()` in
`router-reducer/fetch-server-response.ts` makes a request to the server with:

- `RSC: 1` header (tells the server to return Flight data, not HTML)
- `Next-Router-State-Tree` header (the current router state, so the server
  knows which segments to skip)

The server runs pass 1 only (RSC rendering), using
`walkTreeWithFlightRouterState()` to determine the minimal set of segments
to render.

### 3. Flight response processing

The Flight response contains `FlightDataPath` arrays — each one specifies
a path through the tree to a segment that has new data:

```typescript
// FlightDataSegment (the tail of each path)
;[
  segment, // The segment value
  routerState, // New FlightRouterState for this subtree
  seedData, // CacheNodeSeedData | null (null during prefetch)
  head, // HeadData (viewport metadata)
  isHeadPartial, // PPR flag
]

// FlightDataPath = [...FlightSegmentPath[], ...FlightDataSegment]
// The segment path prefix locates where in the tree to apply the patch.
```

The router reducer applies these patches to the cache tree, creating new
`CacheNode` entries for changed segments while preserving unchanged ones.

### 4. React reconciliation

React re-renders the component tree. `LayoutRouter` components at each
segment boundary check whether their segment has new data in the cache and
render accordingly.

## `LayoutRouter` (`packages/next/src/client/components/layout-router.tsx`)

This is the per-segment client component that the server emits for each
parallel route slot. It's responsible for:

1. **Segment resolution** — Finding the correct child cache node based on
   the current URL segment
2. **Boundary rendering** — Wrapping content in error, loading, and
   not-found boundaries
3. **Template rendering** — Providing template context for the segment
4. **Style and script injection** — Rendering `templateStyles`/`templateScripts`,
   `errorStyles`/`errorScripts`, and `loadingStyles`/`loadingScripts` at the
   correct positions

The structure for each segment:

```
<Activity>?          ← Only with Cache Components (preserves state during transitions)
  <TemplateContext.Provider>
    {templateStyles}
    {templateScripts}
    {template}
      <ScrollAndMaybeFocusHandler>
        <ErrorBoundary errorComponent={error} errorStyles={errorStyles} errorScripts={errorScripts}>
          <LoadingBoundary loading={parentLoadingData}>
            <HTTPAccessFallbackBoundary notFound={...} forbidden={...} unauthorized={...}>
              <RedirectBoundary>
                <InnerLayoutRouter />    ← Recurses to child segments
              </RedirectBoundary>
            </HTTPAccessFallbackBoundary>
          </LoadingBoundary>
        </ErrorBoundary>
      </ScrollAndMaybeFocusHandler>
  </TemplateContext.Provider>
</Activity>?
```

The `<Activity>` wrapper is only present when `cacheComponents` is enabled.
Without it, the `<TemplateContext.Provider>` is the outermost element.

## Server actions on the client

When a server action is called from the client (via form submission or
direct invocation), the App Router processes it through the **action
queue**.

### Action queue

**Defined in**: `packages/next/src/client/components/app-router-instance.ts`

The `AppRouterActionQueue` serializes state transitions — navigations,
server actions, and refreshes cannot run concurrently. Each action is
enqueued as an `ActionQueueNode`:

```typescript
type ActionQueueNode = {
  payload: ReducerActions // The action to dispatch
  next: ActionQueueNode | null // Linked list pointer
  resolve: (value: ReducerState) => void
  reject: (err: Error) => void
  discarded?: boolean
}
```

When an `ACTION_SERVER_ACTION` is dispatched:

1. The action is added to the queue's linked list
2. If no action is currently running, it executes immediately
3. The client sends a POST request to the server with the serialized
   arguments (via React's Flight serializer)
4. The server executes the action and returns a Flight response containing
   both the return value and a **fresh RSC payload** for the affected route
5. The router reducer applies the fresh payload to the cache tree,
   updating any segments that changed due to the mutation
6. `runRemainingActions()` processes the next queued action

### Re-rendering after mutations

Server action responses include updated Flight data so the client
re-renders with fresh content. If the action called `revalidateTag()`,
`revalidatePath()`, or `redirect()` on the server, the response includes
the corresponding state changes. The `pathWasRevalidated` field on the
work store (typed as `ActionRevalidationKind` — a union type `0 | 1 | 2`: `0` = none,
`1` = revalidate static+dynamic, `2` = revalidate dynamic only) signals
whether and how the client should discard cached data.

The `refresh()` API (server-side) sets a special sentinel that tells
the client router to refresh dynamic data without invalidating
server-side caches — useful for read-your-own-writes after a mutation.

## Prefetching

### Without Cache Components (legacy)

Prefetching uses the traditional router cache. When `<Link>` is visible,
a Flight response is fetched with the `Next-Router-Prefetch` header. The
response includes data up to the first `loading.tsx` boundary (unless PPR
is enabled, in which case the full static shell is prefetched). Prefetch
priority is managed via the `PrefetchPriority` enum (`Default`, `Intent`,
`Background`).

### With Cache Components

With Cache Components enabled, the client uses the **Segment Cache** for
per-segment prefetching and navigation. See
[Cache Components — Segment Cache](./05a-cache-components.md#segment-cache-client)
for the full architecture.
