# Next.js Internals

How the Next.js App Router works, end to end. Intended for engineers
onboarding onto the Next.js core team.

## Reading order

| # | Document | What it covers |
|---|----------|----------------|
| 0 | [React Glossary](./00-react-glossary.md) | Internal React terminology: Fizz, Flight, Float, Fiber, Suspense, Postpone, Activity, and more |
| 1 | [Compilation & Bundling](./01-compilation-and-bundling.md) | Webpack / Turbopack entry points, loaders, and how a route becomes a set of chunks |
| 2 | [The Manifest System](./02-manifests.md) | `ClientReferenceManifest` and friends — the data structures that connect build output to runtime |
| 3 | [Request Lifecycle](./03-request-lifecycle.md) | How a request is routed from the network through middleware to the correct renderer |
| 3a | [Middleware](./03a-middleware.md) | How `middleware.ts` is compiled, executed in the Edge sandbox, and how results are processed |
| 4 | [Server Rendering (RSC + SSR)](./04-server-rendering.md) | The two render passes: RSC Flight stream generation, then SSR to HTML |
| 4a | [Metadata](./04a-metadata.md) | How `generateMetadata()` / `generateViewport()` resolve and render into `<head>` |
| 4b | [Streaming Protocol](./04b-streaming-protocol.md) | Flight wire format, Fizz HTML streaming, and the transform pipeline that combines them |
| 5 | [Prerendering & Static Generation](./05-prerendering.md) | `next build` prerendering, PPR, dynamic tracking, postponed state |
| 5a | [Cache Components](./05a-cache-components.md) | `"use cache"`, Resume Data Cache, multi-phase prerendering, staged rendering, Segment Cache |
| 5b | [Caching & Revalidation](./05b-caching.md) | Response cache, incremental cache, `fetch()` patching, ISR, `revalidateTag` / `revalidatePath` |
| 6 | [Client-Side Rendering](./06-client-rendering.md) | Hydration, the App Router, client navigation |

### Cross-cutting references

| # | Document | What it covers |
|---|----------|----------------|
| 7 | [The CSS Pipeline](./07-css-pipeline.md) | How CSS flows from source imports through bundling, manifests, rendering, and into the document |

## Key directories

```
packages/next/src/
├── build/                        # Build tooling (webpack config, plugins, loaders)
│   └── webpack/
│       ├── loaders/              # next-flight-loader, next-flight-css-loader, etc.
│       └── plugins/              # FlightClientEntryPlugin, FlightManifestPlugin
├── server/
│   ├── app-render/               # App Router server rendering (the heart of everything)
│   │   ├── app-render.tsx        # Main render orchestrator (~8400 lines)
│   │   ├── create-component-tree.tsx  # Builds the React element tree from the loader tree
│   │   ├── entry-base.ts         # RSC entry point (re-exports React internals)
│   │   └── collect-segment-data.tsx   # Per-segment prefetch response generation
│   └── lib/
│       ├── router-server.ts      # Router server (request routing)
│       └── router-utils/
│           ├── resolve-routes.ts # Route resolution (middleware, rewrites, fs check)
│           └── filesystem.ts     # Filesystem checker (route/asset lookup tables)
├── client/
│   └── components/
│       ├── app-router.tsx        # Client-side App Router
│       ├── layout-router.tsx     # Per-segment client component
│       └── segment-cache/        # Segment cache for prefetching
├── shared/
│   └── lib/
│       └── app-router-types.ts   # Shared types (FlightData, CacheNodeSeedData, etc.)
└── cli/
    ├── next-dev.ts               # `next dev` entry point
    ├── next-build.ts             # `next build` entry point
    └── next-start.ts             # `next start` entry point

crates/
├── next-api/src/                 # Turbopack integration (module graph, manifests)
└── next-core/src/                # Turbopack Next.js core (app structure, client references)
```

## Terminology

See [React Glossary](./00-react-glossary.md) for React-specific terms
(Flight, Fizz, Float, Fiber, Suspense, Postpone, Activity, etc.).

Key Next.js terms used throughout:

- **Loader tree** — The tree of route segments parsed from the filesystem
  (`layout.tsx`, `page.tsx`, `loading.tsx`, etc.). Built at compile time,
  consumed at render time.
- **Convention file** — A file with a special name recognized by the router:
  `layout`, `page`, `loading`, `error`, `not-found`, `template`, `forbidden`, `unauthorized`.
- **PPR** — Partial Pre-Rendering. Static shell + dynamic holes filled at request time.
- **Cache Components** — `cacheComponents` flag. Enables `"use cache"`, per-segment
  prefetching at runtime, staged rendering, and instant validation.
