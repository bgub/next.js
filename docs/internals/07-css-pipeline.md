# The CSS Pipeline

How CSS flows from source imports through the build, manifests, server
rendering, and into the browser.

## End-to-end flow

```
Source CSS import          →  Build (webpack/turbopack)
                           →  Manifest (entryCSSFiles)
                           →  Server render (getLayerAssets)
                           ├→ SSR HTML (initial document <link>/<style>)
                           └→ Flight stream (navigation/prefetch CSS elements)
                           →  Browser (applied styles)
```

## 1. Build time: CSS collection

### Webpack path

When `FlightClientEntryPlugin` processes a convention file (layout, page,
template, etc.), `collectComponentInfoFromServerEntryDependency()` walks the
module graph:

```
layout.tsx (server)
├── imports ComponentA (client) → STOP traversal, record as client component
│   └── (ComponentA imports styles-a.css — discovered by client bundle)
├── imports helper.tsx (server) → CONTINUE traversal
│   └── imports shared.css → record as CSS import
└── imports styles.css → record as CSS import
```

Key behavior:

- **CSS modules are collected** whenever `isCSSMod(mod)` returns true
- **Client component boundaries stop traversal** — CSS inside client
  components is collected when the client entry is built, not here
- **Side-effect-free CSS** that's unused (dead code) is excluded using the
  module graph usage check

The result: `{ [conventionFilePath]: [css1.css, css2.css, ...] }`

Then `deduplicateCSSImportsForEntry()` hoists shared CSS to the shallowest
**template or layout** (only `POSSIBLE_SHARED_CONVENTIONS = ['template', 'layout']`
participate — page CSS is not tracked for deduplication). Templates have
higher dedup priority than layouts at the same depth. If both `layout.tsx`
and `page.tsx` import the same CSS file, only the layout keeps it (since
layouts always render when their children render).

The deduplicated CSS imports are injected as client entry imports, becoming
part of each convention file's webpack entry point. The resulting CSS chunks
are recorded in `entryCSSFiles`.

### Turbopack path

Turbopack represents manifest-visible CSS as client references. Server-layer
CSS that needs a client stylesheet chunk is wrapped in a
`CssClientReferenceModule`. Each `ClientReference` (including CSS) has an
optional `server_component` field; for references found under a wrapped server
component, it points to the nearest parent `NextServerComponentModule`.

In the app loader tree, `NextServerComponentModule` wrappers are created at
loader-tree entry points, including convention files (layout, page, template,
etc.). They are not created for every arbitrary server component imported by
those files. So for app UI CSS in today's manifest path, the `server_component`
association is still convention-file-level.

In `app_client_references_chunks.rs`, references with
`server_component: Some(...)` are grouped by that parent server component.
References with `server_component: None` are treated as framework references
and folded into the first layout segment when one exists. When a server
component has a client chunk group, that group is `concatenate`d with the
current parent layout accumulator and recorded in
`layout_segment_client_chunks`; those CSS chunks are then written to
`entry_css_files`.

Only `is_layout` components advance the accumulator. That means a page entry
that has its own client/CSS chunk group includes CSS from the layout chain, but
a page with no client/CSS references does not need to get a separate page-level
CSS entry just to repeat its parents' CSS.

## 2. Manifest: `entryCSSFiles`

Both bundlers produce the same manifest shape. The `entryCSSFiles` keys are
source-file paths without the final extension; this is what
`getLinkAndScriptTags()` looks up after stripping the extension from the loader
tree convention path. Simplified example:

```json
{
  "entryCSSFiles": {
    "/app/dashboard/layout": [
      { "path": "static/css/layout-abc123.css", "inlined": false }
    ],
    "/app/dashboard/page": [
      { "path": "static/css/page-def456.css", "inlined": false }
    ],
    "/app/dashboard/loading": [
      { "path": "static/css/loading-789abc.css", "inlined": false }
    ]
  }
}
```

CSS resources can be:

- **External** (`inlined: false`): Served as separate `.css` files, rendered
  as `<link rel="stylesheet">`
- **Inlined** (`inlined: true`, production only with `experimental.inlineCss`):
  CSS content embedded directly, rendered as `<style>` during non-RSC requests
  and as a `<link>` during RSC requests

## 3. Server render: CSS emission

### `getLayerAssets()` (`get-layer-assets.tsx`)

Called once per segment with `parseLoaderTree().conventionPath`, which can be
the segment's layout, template, or page path. It:

1. Calls `getLinkAndScriptTags(conventionPath, injectedCSS, ...)` to look up
   CSS from the manifest using the convention source path
2. Deduplicates against the `injectedCSS` Set (CSS already emitted by parent
   segments)
3. Calls `renderCssResource()` to convert CSS resources into React elements
4. Collects font preload hints from `NextFontManifest`

### `createComponentStylesAndScripts()` (`create-component-styles-and-scripts.tsx`)

Called for boundary convention files (template, error, loading, not-found,
forbidden, unauthorized), and also used by `getGlobalErrorStyles()` for
`global-error`. Similar to `getLayerAssets()` but does **not** pass
`preloadCallbacks` — so this CSS does not get preload hints. It also calls
`getLinkAndScriptTags()` without `collectNewImports`, so it skips CSS already
in `injectedCSS` but does not add newly discovered CSS to that Set. Returns a
tuple of `[Component, styles, scripts]`.

For segment boundary files, `createComponentTree()` passes the current
segment's `injectedCSS`/`injectedJS` sets. For `global-error`,
`getGlobalErrorStyles()` passes fresh sets.

If `parseLoaderTree().conventionPath` falls back to a `template` because the
segment has no layout/page, that template's CSS can already be emitted through
`layerAssets`; the later `createComponentStylesAndScripts()` call then skips it
because the CSS path is already in `injectedCSS`.

### `renderCssResource()` (`render-css-resource.tsx`)

Converts `CssResource` objects into React elements:

```typescript
// External CSS
createElement('link', {
  rel: 'stylesheet',
  href: fullHref,
  precedence: isDev ? 'next_' + path : 'next', // Unique per-file in dev for HMR
  crossOrigin,
  nonce,
})

// Inlined CSS (non-RSC requests only)
createElement(
  'style',
  {
    precedence: isDev ? 'next_' + path : 'next',
    href: fullHref,
    nonce,
  },
  content
)
```

The `precedence` attribute is a React Float feature that:

- Deduplicates stylesheets by `href` — if the same stylesheet resource is
  rendered multiple times, React only inserts one DOM resource
- Controls insertion order — stylesheets with the same precedence are
  inserted in render order
- In dev, each external CSS file gets a unique precedence (`'next_' + path`) to
  maintain HMR ordering. Inlined CSS uses the same precedence calculation, but
  inlining is disabled in dev.

### Preload hints

When `renderCssResource()` receives a `preloadCallbacks` array (as it does from
`getLayerAssets()`), CSS that goes through the `<link>` path registers a
preload callback. This includes external CSS, plus inlined CSS during RSC
requests:

```typescript
preloadCallbacks.push(() => {
  ctx.componentMod.preloadStyle(href, crossOrigin, nonce)
})
```

These callbacks execute during the `<Preloads />` component render, emitting
`<link rel="preload" as="style">` tags via `ReactDOM.preload()`.

## 4. Where CSS lands in the React tree

`layerAssets` CSS elements are placed in the segment root fragment, adjacent to
the rendered segment component or child subtree, not inside the component:

For **layouts**:

```
Fragment (segment root)
├── <link rel="stylesheet" href="layout.css" />     ← layerAssets
└── <LayoutComponent>                                ← the actual component
    └── {children}
```

For **pages** (note: page element comes first):

```
Fragment (segment root)
├── <PageComponent />                                ← the actual component
├── <link rel="stylesheet" href="page.css" />        ← layerAssets
└── <MetadataOutlet />
```

Boundary convention styles are threaded through a few different paths:

- `templateStyles` and `errorStyles` are passed as props to `LayoutRouter`
- `loadingStyles` are stored in `LoadingModuleData` and propagated through
  `LoadingBoundaryProvider`, then rendered in the Suspense fallback
- `notFound`, `forbidden`, and `unauthorized` styles are embedded into the
  fallback element created by `createBoundaryConventionElement()`
- `global-error` styles are returned from `getGlobalErrorStyles()` and rendered
  next to the global error component

For example:

```
<LayoutRouter
  error={ErrorComponent}
  errorStyles={<link href="error.css" />}
  template={templateNode}
  templateStyles={<link href="template.css" />}
  // ...
/>
```

`LayoutRouter` renders these at specific positions in its boundary hierarchy:

- `templateStyles` → Inside `TemplateContext.Provider`, before the template
- `errorStyles` → Inside `ErrorBoundary`, alongside the error component
- `loadingStyles` → Inside the `Suspense` fallback, alongside the loading
  component

## 5. Flight serialization

CSS React elements serialize into the Flight stream as regular React
elements. They're part of the `rsc` field in `CacheNodeSeedData`:

```typescript
CacheNodeSeedData = [
  node, // Contains CSS elements + component output (labeled 'node' in the type)
  parallelRoutes,
  loading, // Note: this field is deprecated (always null, pending removal)
  isPartial,
  varyParams,
]
```

During client navigation, the Flight response delivers these CSS elements
to the client. React's Float system handles inserting new `<link>` tags
and deduplicating against existing ones.

## 6. Client-side CSS loading

### Initial page load

CSS `<link>` tags, or `<style>` tags when CSS is inlined, are in the HTML
document from SSR. Browsers fetch and apply external stylesheets normally. The
preload hints (from `preloadStyle()`) cause browsers to start fetching
stylesheets before they're encountered in the DOM.

### Client navigation

New CSS arrives as React elements in the Flight response. React inserts
new `<link>` tags via the Float system. The `precedence` attribute ensures
correct ordering.

For RSC requests (`isRSCRequest: true`), inlined CSS is NOT inlined — it
falls through to the `<link>` path instead (in `render-css-resource.tsx`).

### `next/dynamic`

Components loaded with `next/dynamic` have their CSS chunks tracked in
`ReactLoadableManifest`. In the App Router SSR-enabled path (`ssr: true`, the
default), `PreloadChunks` reads that manifest and renders CSS files as
`<link rel="stylesheet" precedence="dynamic">` tags, while JS chunks use
`ReactDOM.preload()`. With `ssr: false`, the component bails out to CSR and
does not render `PreloadChunks` on the server. In the browser, `PreloadChunks`
returns `null` and client-side loading is handled by the bundler/runtime chunk
loader. See `shared/lib/lazy-dynamic/preload-chunks.tsx`.

## Current limitations

### Segment-level granularity

CSS is collected per convention file, not per component. If `layout.tsx`
imports `ComponentA` and `ComponentB` (each with their own CSS), both CSS
files are emitted even if the layout conditionally renders only one:

```typescript
// layout.tsx
import ComponentA from './a'  // has a.css
import ComponentB from './b'  // has b.css

export default function Layout() {
  if (condition) return <ComponentA />
  else return <ComponentB />
}
// Both a.css and b.css are emitted, regardless of which branch executes
```

The build-time manifest has no way to know which branch will execute at
runtime. The CSS decision is made from the **static import graph**, not
from the **render-time component tree**.

### The `next/dynamic` workaround

The main supported way to avoid loading unused component-level CSS today is
`next/dynamic`, which creates a separate async chunk. This moves the CSS to the
dynamic component's chunk-loading path, but it breaks the static import graph
and adds loading latency.

### Deduplication scope

CSS deduplication is scoped to the current render tree via `Set<string>`.
During client navigation, React's Float handles DOM-level dedup, but the
Flight payload may still contain redundant CSS elements for components that
are already styled on the page.
