# Request Lifecycle

How an HTTP request arrives at the Next.js server and gets routed to the
correct renderer.

## Overview

Every request passes through a layered pipeline:

```
HTTP request
     │
     ▼
┌─────────────────────────┐
│  Router Server          │  router-server.ts
│  (filter headers,       │  Entry point for all requests
│   compression, i18n)    │
└────────┬────────────────┘
         │
         ▼
┌─────────────────────────┐
│  Route Resolution       │  resolve-routes.ts
│  (headers, redirects,   │  Rewrites, middleware, filesystem check
│   middleware, rewrites,  │
│   filesystem matching)  │
└────────┬────────────────┘
         │
         ▼
┌─────────────────────────┐
│  Render Server          │  NextNodeServer / DevServer (base-server.ts)
│  (route matching,       │  Matches to route module, handles caching
│   caching, rendering)   │
└────────┬────────────────┘
         │
         ▼
┌─────────────────────────┐
│  Route Module           │  app-page, app-route, pages, pages-api
│  (actual rendering)     │  Dispatches to renderToHTMLOrFlight / handler
└─────────────────────────┘
```

## The Router Server (`router-server.ts`)

The Router Server is the outermost layer. It receives raw Node.js
`IncomingMessage`/`ServerResponse` objects and orchestrates the entire request
flow.

**Defined in**: `packages/next/src/server/lib/router-server.ts`

### Initialization

`initialize()` sets up:

1. **Config loading** — Reads `next.config.js` via `loadConfig()`
2. **Filesystem checker** — `setupFsCheck()` scans the build output to know
   which routes, static files, and assets exist
3. **Dev bundler** (dev only) — `setupDevBundler()` initializes Turbopack/webpack
   for on-demand compilation and HMR
4. **Render server** — Creates the `NextNodeServer` (or `DevServer`) instance
   that handles actual rendering

### Request handler flow

The `requestHandlerImpl` function processes each request:

```
1. filterInternalHeaders()     Strip internal-only headers from external requests
2. Locale detection/redirect   (if i18n configured)
3. Compression                 (if enabled)
4. handleRequest()             The main dispatch loop
```

#### `handleRequest()` — the dispatch loop

This is the core routing function. It runs sequentially:

```
1. [Dev only] Hot reloader check
   └── hotReloader.run() handles HMR/WebSocket and dev asset requests

2. resolveRoutes()
   └── Runs through headers, redirects, middleware, rewrites, filesystem
   └── Returns: matchedOutput, parsedUrl, statusCode, bodyStream, resHeaders

3. Handle the result:
   ├── Redirect (3xx status) → send redirect response
   ├── Body stream (middleware response) → pipe to client
   ├── Proxy (rewrite to external URL) → proxy the request
   ├── Static file match → serveStatic()
   ├── Route match (appFile/pageFile) → invokeRender()
   └── No match → 404 (app not-found or /404 page)
```

`invokeRender()` forwards the request to the render server by calling
`renderServer.initialize()` then `requestHandler()`. This is where the request
crosses from the routing layer into the rendering layer.

### Internal header filtering

Before any routing logic runs, `filterInternalHeaders()` strips headers that
are only meaningful internally:

```
x-middleware-rewrite        x-middleware-redirect
x-middleware-set-cookie     x-middleware-skip
x-middleware-override-headers   x-middleware-next
x-now-route-matches         x-matched-path
x-next-resume-state-length
```

These headers are set by middleware or the platform adapter during request
processing. If an external client sent them, they could spoof internal routing
decisions. The filter ensures they're removed before the request reaches any
routing or rendering code.

**Bypass**: The filter is skipped when `NEXT_PRIVATE_TEST_HEADERS` is set
(test mode only).

## Route Resolution (`resolve-routes.ts`)

The route resolution layer evaluates the request against a chain of route
rules. This is where rewrites, redirects, middleware, and filesystem matching
happen.

**Defined in**: `packages/next/src/server/lib/router-utils/resolve-routes.ts`

### The route chain

Routes are evaluated in this order:

```
1. _next/data middleware handling     Normalize data request paths for middleware
2. Custom headers                    (from next.config.js headers)
3. Custom redirects                  (from next.config.js redirects)
4. Middleware                        Execute middleware.ts if path matches
5. beforeFiles rewrites              (from next.config.js rewrites.beforeFiles)
6. Filesystem check (check_fs)       Match against known routes and static files
7. afterFiles rewrites               (from next.config.js rewrites.afterFiles)
8. check: true (afterFiles)          Match against filesystem including dynamic routes
9. Fallback rewrites                 (from next.config.js rewrites.fallback)
```

In **minimal mode** (serverless/edge deployments), custom headers, redirects,
and rewrites are skipped — the platform handles those upstream.

### Filesystem checker (`filesystem.ts`)

`setupFsCheck()` reads the build manifests at startup and builds lookup tables:

- **`appFiles`** — App Router routes from `app-path-routes-manifest.json`
- **`pageFiles`** — Pages Router routes from `pages-manifest.json`
- **Dynamic routes** — Routes with parameters, sorted by specificity
- **Public files** — Files in the `public/` directory
- **Static assets** — Files under `_next/static/`

The `getItem()` method returns an `FsOutput` describing the match type:

```typescript
type FsOutput = {
  type:
    | 'appFile'
    | 'pageFile'
    | 'nextImage'
    | 'publicFolder'
    | 'nextStaticFolder'
    | 'legacyStaticFolder'
    | 'devVirtualFsItem'
  itemPath: string // The matched route/file path
  fsPath?: string // Physical filesystem path (for static files)
  itemsRoot?: string // Root directory for serving static files
  locale?: string // Matched locale (if i18n configured)
}
```

### Middleware execution

When the request pathname matches the middleware matchers (from
`middleware-manifest.json`), the route resolver:

1. Ensures the middleware is compiled (dev only, via `ensureMiddleware()`)
2. Sets `middlewareInvoke: true` on the request metadata
3. Forwards to the render server, which runs the middleware in its sandbox
4. Processes the middleware response:
   - **Rewrite** → Updates `parsedUrl` and continues the route chain
   - **Redirect** → Returns redirect status and headers
   - **Response body** → Returns the body stream directly
   - **Next** (`x-middleware-next: 1`) → Continues to the next route

Middleware typically runs in the Edge Runtime sandbox, even in the Node.js
server. However, when no edge function info is found (e.g., in certain
development configurations), the server falls back to `loadNodeMiddleware()`,
which runs middleware directly in Node.js without the edge sandbox.

## The Render Server

The render server is where route matching meets rendering. It's a class
hierarchy:

```
BaseServer (base-server.ts)
  └── NextNodeServer (next-server.ts)        Production
        └── DevServer (dev/next-dev-server.ts)   Development
```

### `handleRequest()` → `handleRequestImpl()`

When the router server calls `invokeRender()`, it reaches
`BaseServer.handleRequest()`, which:

1. Waits for route matchers to be ready (`this.matchers.waitTillReady()`)
2. Normalizes the URL (slashes, basePath)
3. Sets `x-forwarded-*` headers
4. Checks for RSC request headers
5. Handles `x-matched-path` (minimal mode / platform routing)
6. Checks for middleware invocation
7. Checks for `invokePath` (set by the router server's `invokeRender()`)
   — if present, calls `handleCatchallRenderRequest()` directly
8. Otherwise falls through to `this.run()` → `handleCatchallRenderRequest()`

### `handleCatchallRenderRequest()` — route module dispatch

This is where the request is matched to a specific **route module** and
dispatched for rendering.

```
1. Match the pathname against registered route matchers
   └── this.matchers.match(pathname, options)
       Returns a RouteMatch with the route definition and params

2. Dispatch by match type:
   ├── Edge function page → runEdgeFunction()
   ├── Pages API route    → handleApiRequest() → runApi()
   └── Page/App route     → this.render()
```

### `render()` → `renderToResponse()` → `renderToResponseWithComponents()`

For page routes, the call chain is:

```
render(req, res, pathname, query)
  └── pipe(renderToResponse, { req, res, pathname, query })
        └── renderToResponse(ctx)
              └── renderToResponseImpl(ctx)
                    ├── Find components: this.findPageComponents({ page })
                    │   └── loadComponents() loads the route module + manifests
                    └── renderToResponseWithComponents(ctx, result)
                          └── App Router: module.render() → renderToHTMLOrFlight()
                          └── Pages Router: module.render() → renderToHTML()
```

`findPageComponents()` calls `loadComponents()`, which loads:

- The route module (server bundle for the matched page)
- The `ClientReferenceManifest` (see [Manifests](./02-manifests.md))
- Build manifests, font manifests, etc.

The route module's `render()` method is the entry point to the rendering
pipeline described in [Server Rendering](./04-server-rendering.md).

## Route modules

Route modules are the bridge between the server infrastructure and the actual
rendering code. Each module type has its own dispatch logic:

```
packages/next/src/server/route-modules/
├── app-page/     App Router pages (layout.tsx, page.tsx)
│                 → renderToHTMLOrFlight() in app-render.tsx
├── app-route/    App Router route handlers (route.ts)
│                 → Direct handler execution
├── pages/        Pages Router pages
│                 → renderToHTMLImpl() in render.tsx
└── pages-api/    Pages Router API routes
                  → Direct handler execution
```

### App page module

For App Router pages, `AppPageRouteModule.render()` calls
`renderToHTMLOrFlight()` from `app-render.tsx`, which runs the two-pass
rendering pipeline (RSC → SSR) described in
[Server Rendering](./04-server-rendering.md).

### App route module

**Defined in**: `packages/next/src/server/route-modules/app-route/module.ts`

For App Router route handlers (`route.ts`), `AppRouteRouteModule.handle()`
executes the exported HTTP method handler (`GET`, `POST`, `PUT`, `DELETE`,
`PATCH`, `HEAD`, `OPTIONS`) directly. There's no RSC/SSR pipeline — the
handler receives a `NextRequest` and returns a `Response` object.

The handler runs inside a work store context (like pages), so it has
access to `cookies()`, `headers()`, and the caching system. Key behaviors:

- **Method resolution** — The module looks up the handler by HTTP method
  name from the userland exports. Unimplemented methods return 405.
  `HEAD` falls back to `GET` if not explicitly exported.
- **Static route handlers** — Route handlers can be prerendered at build
  time if they export `dynamic = 'force-static'` or don't use dynamic
  APIs. The cached response is stored as a `CachedRouteValue`
  (`CachedRouteKind.APP_ROUTE`) in the incremental cache.
- **Streaming** — Route handlers can return streaming `Response` objects.
  The body is piped directly to the client.
- **Server actions** — Route handlers can receive server action POST
  requests (detected via `getIsPossibleServerAction(req)`).

## RSC vs. HTML requests

The server distinguishes between HTML requests and RSC (Flight) requests using
the `RSC: 1` header:

|                    | HTML request                            | RSC request                              |
| ------------------ | --------------------------------------- | ---------------------------------------- |
| When               | Initial page load                       | Client-side navigation                   |
| Header             | (none)                                  | `RSC: 1`                                 |
| Server passes      | Pass 1 (RSC) + Pass 2 (SSR)             | Pass 1 (RSC) only                        |
| Response           | HTML document with embedded Flight data | Flight stream                            |
| Additional headers | —                                       | `Next-Router-State-Tree` (current state) |

During RSC requests, `walkTreeWithFlightRouterState()` uses the client's
current router state (sent in the `Next-Router-State-Tree` header) to
determine which segments need re-rendering vs. which can be reused from the
client cache.

### Prefetch requests

Prefetch requests add the `Next-Router-Prefetch` header. With Cache Components
enabled, the `Next-Router-Segment-Prefetch` header requests individual segment
data instead of a full route response. See
[Cache Components — Per-segment prefetching](./05a-cache-components.md#per-segment-prefetching).

## Dev mode differences

In development, several additional layers are active:

### On-demand compilation

The dev bundler compiles routes lazily. When a request arrives for a route
that hasn't been compiled yet, `ensurePage()` triggers compilation before
rendering proceeds. The `hotReloader.run()` call at the top of `handleRequest()`
handles dev asset requests and triggers compilation as needed.

### HMR / WebSocket upgrades

WebSocket upgrade requests for `/_next/hmr` are intercepted by the router
server's `upgradeHandler` and forwarded to `hotReloader.onHMR()`. These
connections deliver file change notifications and module updates to the
browser.

### Cross-site request blocking

`blockCrossSiteDEV()` rejects requests from origins not in the
`allowedDevOrigins` list, preventing cross-site request attacks against
the dev server.

### DevBundlerService

The `DevBundlerService` wraps the dev bundler and provides additional
dev-only functionality:

- ISR status tracking for the static indicator
- Cache status reporting
- Error forwarding to the browser
- React debug channel support

## Request metadata

Throughout the pipeline, metadata is attached to the request object via
`addRequestMeta()` / `getRequestMeta()`. Key metadata fields:

| Field              | Set by           | Used by                                |
| ------------------ | ---------------- | -------------------------------------- |
| `invokePath`       | Router server    | Render server (which route to render)  |
| `invokeOutput`     | Router server    | Render server (which output to use)    |
| `middlewareInvoke` | Route resolver   | Render server (run middleware handler) |
| `isRSCRequest`     | Base server      | Rendering (Flight vs. HTML response)   |
| `isNextDataReq`    | Route resolver   | Rendering (Pages Router data requests) |
| `locale`           | Route resolver   | i18n routing                           |
| `match`            | Catchall handler | Rendering (skip re-matching)           |
| `postponed`        | Base server      | PPR resume rendering                   |
| `clonableBody`     | Route resolver   | Middleware (clone body for re-reads)   |
