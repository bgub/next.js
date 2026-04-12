# Middleware

How `middleware.ts` is compiled, executed, and how its results are processed.

## Overview

Middleware runs **before** route matching and rendering. It intercepts
requests at the routing layer, can rewrite URLs, redirect, set headers,
or return responses directly. Middleware typically runs in the **Edge
Runtime** sandbox, even when the Next.js server is running on Node.js.
However, a Node.js fallback path exists (via `loadNodeMiddleware()`) when
no edge function info is found.

```
HTTP request
     │
     ▼
Router Server (router-server.ts)
     │
     ▼
resolveRoutes() ──── route chain evaluation
     │
     ├── headers, redirects
     │
     ├── ► middleware ◄ ──── runs here in the chain
     │       │
     │       ├── NextResponse.next()     → continue to filesystem check
     │       ├── NextResponse.rewrite()  → change target URL, continue
     │       ├── NextResponse.redirect() → send redirect response
     │       └── new Response()          → return body directly
     │
     ├── beforeFiles rewrites
     ├── filesystem check
     └── afterFiles rewrites, fallback rewrites
```

## Compilation

### Webpack: `MiddlewarePlugin`

**Defined in**: `packages/next/src/build/webpack/plugins/middleware-plugin.ts`

The `MiddlewarePlugin` produces the **middleware manifest**
(`middleware-manifest.json`), which maps middleware paths to their compiled
bundles and matcher configuration:

```typescript
interface MiddlewareManifest {
  version: 3
  sortedMiddleware: string[]          // Ordered middleware paths
  middleware: {                       // Middleware entries
    [page: string]: {
      files: string[]                 // Compiled JS files
      name: string
      page: string
      matchers: MiddlewareMatcher[]   // Route matchers
      wasm?: AssetBinding[]
      assets?: AssetBinding[]
    }
  }
  functions: { ... }                  // Edge functions (route handlers)
}
```

Middleware is compiled as an **edge bundle** — it targets the Edge Runtime
with restricted Node.js API access (no `fs`, `net`, etc.).

### Matcher configuration

The `config.matcher` export in `middleware.ts` is compiled into
`MiddlewareMatcher` objects. These are evaluated by
`getMiddlewareRouteMatcher()` in
`shared/lib/router/utils/middleware-route-matcher.ts`, which returns a
match function used during route resolution.

Matchers support:

- String patterns (`'/dashboard/:path*'`)
- Regular expressions
- `has` / `missing` conditions (headers, cookies, query params)

## Execution

### The Edge Runtime sandbox

**Defined in**: `packages/next/src/server/web/sandbox/`

When middleware matches a request, the render server executes it inside the
Edge Runtime sandbox (`sandbox.ts`). The sandbox:

1. Creates an isolated module context (`context.ts`) with Edge Runtime
   globals (`Request`, `Response`, `fetch`, `crypto`, `TextEncoder`, etc.)
2. Loads the compiled middleware bundle into this context
3. Invokes the middleware's default export with a `NextRequest` object
4. Collects the `NextResponse` (or plain `Response`) result

The sandbox ensures middleware behaves identically whether the server
runs on Node.js or an actual Edge platform.

### Request flow

In `resolve-routes.ts`, when the `'middleware'` route is reached:

```
1. Check middleware matchers against the request pathname
2. Set middlewareInvoke: true on request metadata
3. Forward request to render server
4. Render server calls handleCatchallMiddlewareRequest()
5. handleCatchallMiddlewareRequest() calls runMiddleware()
6. runMiddleware() executes middleware in the Edge sandbox
7. Response is thrown back to resolve-routes.ts as an error
   with { result: { response } }
```

The "throw as error" pattern is used because the middleware response needs
to bubble back to the routing layer — the render server's normal response
pipeline is bypassed.

## `NextResponse` — middleware results

`NextResponse` (`packages/next/src/server/web/spec-extension/response.ts`)
extends the standard `Response` with Next.js-specific methods. Each method
translates to internal headers that the routing layer processes:

| Method                                        | Internal header                     | Effect                            |
| --------------------------------------------- | ----------------------------------- | --------------------------------- |
| `NextResponse.next()`                         | `x-middleware-next: 1`              | Continue to next route in chain   |
| `NextResponse.rewrite(url)`                   | `x-middleware-rewrite: <url>`       | Change the target URL             |
| `NextResponse.redirect(url)`                  | `Location: <url>` (standard header) | Send redirect response            |
| `NextResponse.next({ request: { headers } })` | `x-middleware-override-headers`     | Override incoming request headers |
| `response.cookies.set(...)`                   | `x-middleware-set-cookie`           | Set cookies on response           |

### Response processing in `resolve-routes.ts`

After middleware executes, `resolve-routes.ts` processes the response:

1. **`x-middleware-next`** — Continue routing. Any headers set by
   middleware are merged into the request for downstream handlers.

2. **`x-middleware-rewrite`** — Parse the rewrite URL. If it's an
   external URL, set up proxying. If internal, update `parsedUrl` and
   mark `didRewrite = true` so the filesystem check accepts rewritten
   paths.

3. **Redirect** — If the response has a `Location` header (set by
   `NextResponse.redirect()`), return the redirect status code and
   Location to the client.

4. **Response body** — If middleware returned a `Response` with a body
   (not `next()`, `rewrite()`, or `redirect()`), the body stream is
   piped directly to the client.

### Header and cookie propagation

Middleware can modify **incoming request headers** via
`x-middleware-override-headers`. This is triggered by passing
`request: { headers: newHeaders }` in the `NextResponse.next()` or
`NextResponse.rewrite()` init options. The new header names are listed in
`x-middleware-override-headers`, and their values are stored as
`x-middleware-request-<name>` headers. The routing layer extracts these
and applies them to `req.headers` (the incoming request), not the
outgoing response.

Cookies set via `response.cookies.set()` are propagated through
`x-middleware-set-cookie` and merged with any cookies set by the
rendering layer (via `patchSetHeaderWithCookieSupport()` in
`base-server.ts`).
