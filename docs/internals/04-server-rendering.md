# Server Rendering (RSC + SSR)

Every App Router request goes through **two render passes** on the server.
Understanding this two-pass architecture is fundamental to working on Next.js.

## The two passes

```
                    Pass 1: RSC                        Pass 2: SSR
              ┌─────────────────────┐            ┌──────────────────────┐
Source:       │ Server components   │            │ Flight stream from   │
              │ + client references │            │ pass 1               │
              │ + CSS manifests     │            │                      │
              └────────┬────────────┘            └────────┬─────────────┘
                       │                                  │
Renderer:     renderToReadableStream              renderToReadableStream
              (react-server-dom-webpack/server)   (react-dom/server)
                       │                                  │
Output:       Flight stream (binary)              HTML stream
              (serialized React tree)             (renderable document)
              └────────┬────────────┘            └────────┬─────────────┘
                       │                                  │
              Embedded in HTML as                 Sent to browser as
              <script> tags for hydration         the initial document
```

### Pass 1: RSC rendering

**Entry**: `generateDynamicRSCPayload()` in `app-render.tsx`

This pass executes all **server components** and produces a **Flight stream**
— React's wire format for serialized component trees. The Flight stream
contains:

- Rendered output of server components (as serialized JSX)
- **Client references** — pointers to client components (module ID + chunks),
  not their rendered output
- React elements for CSS (`<link>`, `<style>`) and font preloads
- The router state tree (`FlightRouterState`)

The key function is `createComponentTree()` in `create-component-tree.tsx`,
which recursively walks the loader tree and produces `CacheNodeSeedData` for
each segment. See [The CSS Pipeline](./07-css-pipeline.md) for how CSS
assets are collected and emitted during this process.

The RSC payload is assembled into an `InitialRSCPayload` object:

```typescript
{
  b: buildId,                     // Build ID (omitted if sent via header)
  c: initialCanonicalUrlParts,    // string[] — URL parts for the client router
  q: initialRenderedSearch,       // Rendered search/query string
  i: couldBeIntercepted,          // Whether this route could be intercepted
  f: FlightDataPath[],            // The rendered tree
  m: missingSlots,                // Set<string> — parallel route slots without matches
  G: [GlobalError, styles],       // Global error boundary
  S: supportsPerSegmentPrefetch,  // Enables Segment Cache on the client
  h: headVaryParams,              // Vary params for head metadata
  P: <Preloads />,                // CSS/font preload calls (set at runtime, not in TypeScript type)
  // Cache Components-only fields:
  s?: staleTime,                  // AsyncIterable<number> — per-segment stale times
  l?: staticStageByteLength,      // Promise<number> — byte offset where static stage ends
  p?: runtimePrefetchStream,      // ReadableStream — embedded runtime prefetch data
  d?: dynamicStaleTime,           // Per-page BFCache stale time (seconds)
}
```

This object is passed to `renderToReadableStream()` from
`react-server-dom-webpack/server`, which serializes it into the Flight
binary format.

### Pass 2: SSR rendering

**Entry**: The `App` component in `app-render.tsx`

The Flight stream from pass 1 is consumed by React's Flight client
(`createFromReadableStream` / `createFromNodeStream` from
`react-server-dom-webpack/client`), which reconstructs the React element tree.

This reconstructed tree is then rendered to HTML by React DOM's
`renderToReadableStream` (or `renderToPipeableStream` with Node streams).
During this pass:

- Server component output is already resolved (it's just JSX in the stream)
- **Client components are executed** — their SSR bundles are loaded via the
  `ssrModuleMapping` in the manifest, and they render to HTML
- CSS `<link>` and `<style>` elements (from `getLayerAssets()`) render into
  the HTML document

The SSR output includes the HTML document plus the Flight stream embedded as
`<script>` tags for hydration:

```html
<script>
  self.__next_f.push([1, '...flight data...'])
</script>
```

## `createComponentTree` — Building the React element tree

This is the core function of pass 1. It lives in `create-component-tree.tsx`
and recursively processes the loader tree.

### Per-segment processing

For each segment in the loader tree:

```
1. Parse the segment (layout, page, template, error, loading, etc.)

2. Collect CSS assets
   ├── getLayerAssets() → CSS for the layout/page convention file
   ├── createComponentStylesAndScripts() → CSS for template
   ├── createComponentStylesAndScripts() → CSS for error
   ├── createComponentStylesAndScripts() → CSS for loading
   ├── createComponentStylesAndScripts() → CSS for not-found
   └── ... (forbidden, unauthorized)

3. Resolve the layout/page module

4. Recurse into parallel routes
   └── For each parallel route key:
       └── createComponentTreeInternal(childSegment)

5. Assemble the React element tree:
   For layouts:
     Fragment
     ├── layerAssets (CSS <link>/<style> tags)
     └── layoutElement (the actual component with {children})

   For pages:
     Fragment
     ├── pageElement (the actual component)
     ├── layerAssets (CSS <link>/<style> tags)
     └── MetadataOutlet
```

### CSS deduplication with Sets

CSS deduplication is managed through `Set<string>` objects passed down
the tree:

```typescript
// Each segment gets a COPY of the parent's Sets
const injectedCSSWithCurrentLayout = new Set(injectedCSS)

// getLayerAssets() adds to this copy
getLayerAssets({ injectedCSS: injectedCSSWithCurrentLayout, ... })

// Child segments receive the updated copy
createComponentTreeInternal({
  injectedCSS: injectedCSSWithCurrentLayout,
  ...
})
```

The copy ensures that sibling parallel routes don't interfere with each
other's CSS deduplication, while child segments see everything their parents
have already injected.

### Client vs. server components

The tree builder handles both:

- **Server components**: Passed to `createElement()` like any React
  component. The Flight renderer executes them during pass 1 and
  serializes their output as JSX in the Flight stream.
- **Client components**: Wrapped in `ClientPageRoot` or `ClientSegmentRoot`.
  These wrappers are themselves `"use client"` components, so they become
  client references in the Flight stream. The actual client component is
  a prop of the wrapper.

When `cacheComponents` is enabled, client component wrappers receive
`serverProvidedParams: null` — params are resolved on the client side instead,
enabling the server output to be cached independently of param values. See
[Cache Components](./05a-cache-components.md) for how this fits into the
broader caching system.

## The RSC payload in the HTML document

The Flight stream is embedded in the HTML document as `<script>` tags via
`createInlinedDataReadableStream()` in `use-flight-response.tsx`:

```javascript
// Bootstrap
self.__next_f = self.__next_f || []
self.__next_f.push([0]) // Bootstrap marker

// Data chunks (as the Flight stream produces them)
self.__next_f.push([1, 'serialized flight data...'])
self.__next_f.push([1, 'more data...'])

// Binary chunks (base64 encoded)
self.__next_f.push([3, 'base64data...'])
```

During hydration, the client reads these chunks to reconstruct the React tree
and reconcile it with the server-rendered HTML. For the full details of chunk
types, the stream combination pipeline, and how Fizz progressively streams
Suspense boundaries, see [Streaming Protocol](./04b-streaming-protocol.md).

## Preload hints

CSS and font preloads are injected during pass 1 via React's Float APIs:

```typescript
// In renderCssResource() (called from getLayerAssets()):
preloadCallbacks.push(() => {
  ctx.componentMod.preloadStyle(href, crossOrigin, nonce)
})

// In the Preloads component (rendered as part of the RSC payload):
function Preloads({ preloadCallbacks }) {
  preloadCallbacks.forEach((fn) => fn())
  return null
}
```

These `preloadStyle` / `preloadFont` calls are wrappers around
`ReactDOM.preload()`. When called during rendering, React emits the
corresponding `<link rel="preload">` tags in the HTML output. They must be
called during a render pass to take effect — that's why they're wrapped in
a component rather than called imperatively.

Note: `preloadCallbacks` are only passed by `getLayerAssets()` (for
layout/page CSS). `createComponentStylesAndScripts()` (for template,
error, loading, etc.) does **not** pass `preloadCallbacks`, so convention
file CSS does not get preload hints.

## Navigation (Flight responses)

On client-side navigation, only pass 1 runs. The server generates a Flight
stream (no HTML) and sends it directly to the client. The client's Flight
runtime processes the stream, resolves client references, loads new chunks,
and React reconciles the new tree with the existing DOM.

The navigation Flight response uses `walkTreeWithFlightRouterState()` to
determine which segments need re-rendering vs. which can be reused from the
client cache. Even segments that aren't re-rendered have their CSS tracked
(via `getLinkAndScriptTags()`) to maintain consistent deduplication state.
