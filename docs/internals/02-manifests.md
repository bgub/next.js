# The Manifest System

Manifests are the bridge between build output and runtime rendering. They're
JSON files produced at compile time and consumed at request time to resolve
module references and locate assets.

## `ClientReferenceManifest`

**Defined in**: `packages/next/src/build/webpack/plugins/flight-manifest-plugin.ts`

This is the most important manifest. One is produced per route (stored at
`server/app/<route>/<segment>_client-reference-manifest.js`). Related
segments are merged at **build time** — parent layout manifests are merged
into page manifests by `entryNameToGroupName()` in `flight-manifest-plugin.ts`,
so each route has one combined manifest at runtime.

```typescript
// RSC-layer fields (inherited from ClientReferenceManifestForRsc)
interface ClientReferenceManifestForRsc {
  clientModules: ManifestNode // resource path → { id, name, chunks }
  rscModuleMapping: { [moduleId]: ManifestNode }
  edgeRscModuleMapping: { [moduleId]: ManifestNode }
}

// Full manifest (extends the RSC interface with SSR and asset fields)
interface ClientReferenceManifest extends ClientReferenceManifestForRsc {
  moduleLoading: { prefix: string; crossOrigin?: string }

  // SSR module mappings
  ssrModuleMapping: { [moduleId]: ManifestNode }
  edgeSSRModuleMapping: { [moduleId]: ManifestNode }

  // Per-segment CSS/JS (keyed by convention file path without extension)
  entryCSSFiles: { [entry: string]: CssResource[] }
  entryJSFiles?: { [entry: string]: string[] }
}
```

The split into two interfaces reflects the RSC/SSR layer boundary.
`ClientReferenceManifestForRsc` is used in the RSC (react-server) layer
where only client module resolution and RSC mappings are needed.
The full `ClientReferenceManifest` adds SSR mappings and asset tracking.

### `clientModules`

Maps each client component's resource path to its module metadata:

```typescript
type ManifestNode = {
  [moduleExport: string]: {
    id: ModuleId // Webpack module ID
    name: string // Export name (usually '*')
    chunks: ManifestChunks // In webpack: alternating [chunkId, filename, ...] pairs
    // In Turbopack: plain file paths
    async?: boolean // Whether the module is async
  }
}
```

**Used by**: React's Flight Server during RSC rendering (pass 1). When
the Flight server encounters a client component in the React tree, it
looks up the module in `clientModules` to encode a client reference
(module ID + export name + chunk paths) into the Flight stream. Later,
on the client (or during SSR via `ssrModuleMapping`), these references
are resolved to actual module instances.

Note: In practice, only JS files end up in `chunks` (CSS is tracked
separately in `entryCSSFiles`), though the type comment says "JS and CSS."

### `entryCSSFiles`

Maps each convention file path (without extension) to its CSS resources:

```typescript
entryCSSFiles: {
  '/app/dashboard/layout': [
    { path: 'static/css/dashboard-layout-abc123.css', inlined: false }
  ],
  '/app/dashboard/page': [
    { path: 'static/css/dashboard-page-def456.css', inlined: false }
  ]
}
```

Each `CssResource` is either:

- `{ path, inlined: false }` — External CSS file, rendered as `<link>`
- `{ path, inlined: true, content }` — Inlined CSS, rendered as `<style>`
  (only when `experimentalInlineCss` is enabled in production)

**Used by**: `getLinkAndScriptTags()` at render time, called from
`getLayerAssets()` and `createComponentStylesAndScripts()`.

### `ssrModuleMapping` / `rscModuleMapping`

These serve different layers:

- **`ssrModuleMapping`** — Maps client module IDs to their SSR-layer
  equivalents. Used by the Flight Client during SSR to execute client
  components on the server for HTML generation.
- **`rscModuleMapping`** — Maps client module IDs to their RSC-layer
  (react-server) equivalents. Used by the Flight Server during RSC
  rendering to resolve client references within the React Server
  Components environment.

## Manifest lifecycle

### 1. Build time: Population

**Webpack** (`flight-manifest-plugin.ts`):

```
For each entry point (app/dashboard/page, etc.):
  1. Create a fresh ClientReferenceManifest
  2. entryCSSFiles[path] = entrypoint.getFiles().filter(f => f.endsWith('.css'))
  3. Walk all chunks, record each client module in clientModules
  4. Look up SSR/RSC module IDs from plugin state
  5. Write manifest to disk
```

**Turbopack** (`client_reference_manifest.rs`):

```
For each route entry:
  1. Iterate client_references_ecmascript (individual client components)
     → populate clientModules, ssrModuleMapping, rscModuleMapping
  2. Iterate layout_segment_client_chunks (per server component)
     → populate entryCSSFiles and entryJSFiles from each server component's chunk group
  3. Serialize to JSON
```

### 2. Build time: Grouping and merging

Manifests are grouped by route using `entryNameToGroupName()`. Related
segments (e.g., `app/dashboard/layout` and `app/dashboard/page`) are merged
together so that a single route has one combined manifest.

### 3. Runtime: Loading

When a request arrives, `load-components.ts` loads the manifest for the
matched route. `manifests-singleton.ts` maintains a global singleton that
the rendering code accesses via `getClientReferenceManifest()`. The
singleton uses a `Proxy` that resolves properties based on the current
request's route (via `workAsyncStorage`). In development, it falls back
to searching all loaded route manifests if the current route's manifest
doesn't contain the requested module.

### 4. Runtime: CSS lookup

`getLinkAndScriptTags()` in `get-css-inlined-link-tags.tsx`:

```typescript
function getLinkAndScriptTags(filePath, injectedCSS, injectedScripts) {
  const filePathWithoutExt = filePath.replace(/\.[^.]+$/, '')
  const { entryCSSFiles } = getClientReferenceManifest()
  const cssFiles = entryCSSFiles[filePathWithoutExt]

  for (const css of cssFiles) {
    if (!injectedCSS.has(css.path)) {
      if (collectNewImports) {
        injectedCSS.add(css.path) // Mark as injected (dedup) — only when collectNewImports is set
      }
      cssChunks.add(css) // Include in this segment's output
    }
  }
  return { styles: cssChunks, scripts: jsChunks }
}
```

The `injectedCSS` Set is passed down the tree, preventing the same CSS file
from being emitted in multiple segments.

## Other manifests

### `BuildManifest`

Contains the JS/CSS files needed for each page, plus polyfills and shared
chunks. Used during HTML rendering to inject `<script>` and `<link>` tags
into the document `<head>`.

### `NextFontManifest`

Maps layout/page paths to their font file paths, separated into `pages`
(Pages Router) and `app` (App Router) entries. Also tracks whether any
font uses `sizeAdjust` (via `appUsingSizeAdjust` / `pagesUsingSizeAdjust`
flags). Used by `getPreloadableFonts()` to emit font preload hints.

### `ReactLoadableManifest`

Maps `next/dynamic` component names to their chunk files. Used for
code-splitting with dynamic imports.

### `ServerReferenceManifest`

Maps server function IDs to their module locations. Used to route incoming
server function calls (including server actions) to the correct handler.
See [React Glossary — Server Functions](./00-react-glossary.md#server-functions-and-server-actions).
