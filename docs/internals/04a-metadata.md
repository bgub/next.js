# Metadata

How `generateMetadata()`, `generateViewport()`, and static metadata exports
resolve through the segment hierarchy and render into the HTML `<head>`.

## Overview

The metadata system resolves metadata and viewport configuration by walking
the loader tree (the same tree used by `createComponentTree`), merging
parent and child metadata at each level. The result is rendered as React
elements (`<title>`, `<meta>`, `<link>`, etc.) that React's Float system
hoists into the document `<head>`.

```
Loader tree
     │
     ▼
resolveMetadata() — walks segments, merges parent → child
     │
     ▼
Metadata / Viewport components — async server components
     │
     ▼
MetadataBoundary / ViewportBoundary — Suspense wrappers
     │
     ▼
React Float — hoists <meta>, <title>, <link> to <head>
```

## Metadata sources

Each segment can export metadata in two forms:

1. **Static exports** — `export const metadata = { title: '...' }` and
   `export const viewport = { ... }`. These are plain objects, resolved
   at build time.

2. **Dynamic functions** — `export async function generateMetadata({ params })`
   and `export async function generateViewport({ params })`. These are
   async functions that can fetch data, resolved at render time.

Metadata and viewport are resolved **separately** — they have distinct
resolution functions, Suspense boundaries, and rendering paths. This split
allows viewport tags (which affect initial page layout) to resolve
independently from metadata tags (which can be deferred).

## Resolution: `resolveMetadata()` and `resolveViewport()`

**Defined in**: `packages/next/src/lib/metadata/resolve-metadata.ts`

These functions walk the loader tree from root to leaf, collecting metadata
exports from each segment's `layout.tsx` and `page.tsx`. At each level:

1. Load the segment's module
2. Read `metadata` (static) or call `generateMetadata()` (dynamic)
3. Merge with the accumulated parent metadata

Merging is **deep** for most fields — child values override parent values,
but some fields (like `openGraph.images`) are replaced entirely rather than
merged.

The internal wrapper functions (`getResolvedMetadata` / `getResolvedViewport`
in `metadata.tsx`) are wrapped with React's `cache()` to ensure they
execute only once per render, even if referenced from multiple components.

## Rendering: `createMetadataComponents()`

**Defined in**: `packages/next/src/lib/metadata/metadata.tsx`

This function creates three components that are rendered at specific
positions in the React tree:

### `Viewport`

Resolves viewport metadata and renders viewport-related tags
(`<meta name="viewport">`, theme color, etc.). Wrapped in a
`ViewportBoundary` (a Suspense boundary with the name
`VIEWPORT_BOUNDARY_NAME`).

### `Metadata`

Resolves page metadata and renders `<title>`, `<meta>`, `<link>`, etc.
Wrapped in a `MetadataBoundary` (a Suspense boundary with the name
`METADATA_BOUNDARY_NAME`).

When `serveStreamingMetadata` is true (for streaming-capable clients),
the `Metadata` component is additionally wrapped in `<Suspense>` inside
a `<div hidden>` — this allows metadata to stream in progressively
without blocking the visible page content.

### `MetadataOutlet`

Renders at the **end** of the page content (after the page component,
before `</body>`). It `await`s both `resolveMetadata()` and
`resolveViewport()`, then renders nothing. Its purpose is to **surface
errors** — if metadata resolution throws, the error propagates through
the `OutletBoundary` and is caught by the nearest error boundary.

This split is deliberate: `Metadata` renders `null` on error (so the
page still renders), while `MetadataOutlet` re-throws the error (so
it's visible to error boundaries).

## Placement in the React tree

Metadata components live in **two separate locations**, not in the same
Fragment:

**1. `initialHead` / `rscHead`** (in `app-render.tsx`): The `Viewport`
and `Metadata` components are rendered as part of the head element in the
`FlightDataPath` tuple — separate from the component tree seed data:

```
initialHead Fragment
├── <NonIndex />                  ← robots noindex (if needed)
├── <ViewportWrapper />           ← viewport tags
└── <MetadataWrapper />           ← metadata tags (may be in hidden div)
```

**2. Page segment Fragment** (in `create-component-tree.tsx`): Only
`MetadataOutlet` appears here, alongside the page component:

```
Fragment (page segment)
├── <PageComponent />             ← the actual page
├── layerAssets (CSS)
└── <MetadataOutlet />            ← error surface for metadata
```

The `Viewport` and `Metadata` components are only created for the **leaf
page segment**, not for every layout. Layouts contribute to metadata
through the resolution chain (parent → child merging), but the actual
rendering happens once at the page level.

## Interaction with staged rendering

When Cache Components is enabled, metadata components respect the staged
rendering system:

```typescript
// In Metadata() and Viewport():
if (!isRuntimePrefetchable) {
  const stagedRendering = getStagedRenderingController(workUnitStore)
  if (stagedRendering) {
    await stagedRendering.waitForStage(RenderStage.Static)
  }
}
```

If the page is not runtime-prefetchable, metadata resolution is deferred
until the `Static` stage — this gives prefetchable segments a head start
in the render pipeline.

## Metadata convention files

Special files like `opengraph-image.tsx`, `icon.tsx`, `twitter-image.tsx`,
and `sitemap.ts` are handled separately from the metadata resolution chain.
These are compiled as **route handlers** (they export `GET` functions that
return image/XML responses) and referenced in the resolved metadata as URLs
pointing to those route handler endpoints.

The metadata resolution system discovers these files via
`isMetadataRouteFile()` and `normalizeMetadataRoute()` in
`packages/next/src/lib/metadata/`.

## Key files

- `packages/next/src/lib/metadata/metadata.tsx` — Component creation
  (`createMetadataComponents`)
- `packages/next/src/lib/metadata/resolve-metadata.ts` — Resolution logic
  (tree walking, merging)
- `packages/next/src/lib/metadata/types/metadata-interface.ts` — Type
  definitions (`ResolvedMetadata`, `ResolvedViewport`)
- `packages/next/src/lib/framework/boundary-components.tsx` — Boundary
  components (`MetadataBoundary`, `ViewportBoundary`, `OutletBoundary`)
- `packages/next/src/lib/framework/boundary-constants.tsx` — Boundary names
