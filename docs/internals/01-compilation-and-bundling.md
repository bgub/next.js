# Compilation & Bundling

How a Next.js App Router application goes from source files to executable bundles.

## Overview

Next.js uses **webpack**, **Turbopack**, or **Rspack** as its bundler.
Turbopack is the default for both `next dev` and `next build`. Webpack
can be forced with `--webpack`. Rspack is experimental and requires the
`NEXT_RSPACK` environment variable and the `next-rspack` package.

The build produces several distinct bundles:

1. **Server bundles** — Run on the server. Contain server components,
   server functions, route handlers.
2. **Client bundles** — Run in the browser. Contain client components and
   the App Router runtime.
3. **SSR bundles** — Run on the server during the SSR pass. Contain the
   client-side code compiled for server execution (so that client components
   can be server-rendered to HTML).

## Entry points

### Build entry (`packages/next/src/build/index.ts`)

`next build` starts here. It:

1. Collects all routes from the filesystem
2. Constructs the webpack/turbopack configuration
3. Runs the compilation
4. Post-processes the output (manifests, prerendering, etc.)

### Webpack configuration (`packages/next/src/build/webpack-config.ts`)

Creates three webpack compiler instances:

- **`client`** — Targets the browser. Produces the client JS/CSS bundles.
- **`server`** — Targets Node.js. Produces the server bundles that run
  RSC rendering.
- **`edge-server`** — Targets the Edge runtime for routes that opt into it.

## Route discovery and the Loader Tree

The filesystem structure under `app/` is parsed into a **loader tree** — a
recursive data structure where each node represents a route segment and
contains references to its convention files.

```
app/
├── layout.tsx          ← root segment
├── page.tsx
└── dashboard/
    ├── layout.tsx      ← nested segment
    └── page.tsx
```

Becomes (simplified):

```
LoaderTree = [
  segment: '',
  parallelRoutes: {
    children: [
      segment: 'dashboard',
      parallelRoutes: { children: [...] },
      modules: { layout: [...], page: [...] }
    ]
  },
  modules: { layout: [getter, path], page: [...] }
]
```

Each module entry is `[asyncGetter, filePath]`. The getter lazily loads the
module at render time; the file path is used for manifest lookups (including
CSS).

## Key webpack plugins

### `FlightClientEntryPlugin` (`packages/next/src/build/webpack/plugins/flight-client-entry-plugin.ts`)

This plugin is responsible for creating **client entry points** from the
server compilation. For each convention file (layout, page, template, etc.)
in the server entry:

1. **Walks the module graph** from the convention file via
   `collectComponentInfoFromServerEntryDependency()`.
2. **Collects three things:**
   - `clientComponentImports` — Modules marked `"use client"`. Traversal stops
     at these boundaries (their internals are bundled separately).
   - `cssImports` — CSS modules found during the walk (`isCSSMod()`). These
     are associated with the convention file that imports them.
   - `actionImports` — Server function (`"use server"`) references.
3. **Deduplicates CSS** across the segment hierarchy via
   `deduplicateCSSImportsForEntry()`. If a layout and its child page both
   import the same CSS file, only the layout keeps it (since the layout always
   renders when the page renders).
4. **Injects client entries** — Creates a webpack entry point for each
   convention file containing its client component imports and deduplicated
   CSS imports.

### `ClientReferenceManifestPlugin` (`packages/next/src/build/webpack/plugins/flight-manifest-plugin.ts`)

Runs after compilation. For each entry point, it produces a
`ClientReferenceManifest` containing:

- **`clientModules`** — Maps module resource paths to `{ id, name, chunks }`.
  The `chunks` field contains only JS files (CSS is handled separately).
  React's Flight runtime uses this to resolve client component references.
- **`entryCSSFiles`** — Maps each convention file path (without extension) to
  its CSS resources. This is the primary mechanism for associating CSS with
  route segments.
- **`ssrModuleMapping`** / **`edgeSSRModuleMapping`** — Maps client module IDs
  to their SSR-bundle equivalents, so client components can be rendered to
  HTML on the server.
- **`rscModuleMapping`** / **`edgeRscModuleMapping`** — Maps client module
  IDs to their RSC-bundle equivalents (Node.js and Edge, respectively).

See [The Manifest System](./02-manifests.md) for details.

## Key webpack loaders

### `next-flight-loader` (`packages/next/src/build/webpack/loaders/next-flight-loader`)

Transforms `"use client"` modules in the server bundle. Instead of including
the real code, it replaces the module with a **client reference proxy** — an
object that carries the module ID and export names. When React encounters this
during RSC rendering, it serializes the reference into the Flight stream.

### `next-flight-css-loader` (`packages/next/src/build/webpack/loaders/next-flight-css-loader.ts`)

Handles CSS imports in both the **server and client** app-dir bundles. Its
behavior depends on the CSS type and environment:

- **Global CSS in dev**: Strips content, replaces with a checksum +
  `module.hot.accept()` (HMR change detection)
- **CSS Modules in dev**: Keeps original content intact (class name
  mappings are needed), appends `module.exports.__checksum` for HMR
- **Prod**: The original content passes through

The actual CSS is only meaningful in the client bundle; on the server side
it's the _manifest_ that tracks which CSS files belong to which segments.

## Turbopack equivalents

Turbopack implements the same concepts in Rust:

- **Module graph traversal**: `visit_client_reference.rs` walks the module graph,
  discovering `EcmascriptClientReferenceModule` and `CssClientReferenceModule`
  nodes. Each is tagged with its nearest parent `NextServerComponentModule`.
- **Client reference chunks**: `app_client_references_chunks.rs` groups client
  references by their parent server component, then creates chunk groups for
  each. The chunk groups are accumulated — each server component's chunks
  include its own dependencies plus everything from parent layouts.
- **Manifest generation**: `client_reference_manifest.rs` writes the same
  `ClientReferenceManifest` JSON structure that the webpack plugin produces.

The key structural difference: Turbopack's graph traversal is inherently
per-module (each `ClientReference` carries a `server_component` field), while
webpack's `FlightClientEntryPlugin` traverses per-convention-file and produces
a flat CSS list per entry.

## Chunk structure

After compilation, a typical route produces:

```
.next/
├── server/
│   └── app/
│       └── dashboard/
│           ├── page.js                    # Server bundle for this route
│           └── page_client-reference-manifest.js  # Manifest for this route
├── static/
│   ├── chunks/
│   │   ├── app/dashboard/page-[hash].js   # Client JS for this route
│   │   └── [hash].js                      # Shared chunks
│   └── css/
│       ├── app/dashboard/page-[hash].css  # CSS for this route's entry
│       └── [hash].css                     # Shared CSS chunks
```

The manifest connects these pieces: at render time, the server looks up
`entryCSSFiles["app/dashboard/page"]` to find which CSS files to emit as
`<link>` tags.
