# React Glossary

Internal React terminology that appears in the Next.js codebase. These are
not public API names — they're codenames and internal concepts used by the
React team that you'll encounter in comments, variable names, and
architecture discussions.

## Rendering systems

### Fizz

React's **streaming server-side HTML renderer**. The implementation behind
`react-dom/server`'s `renderToReadableStream` (web streams) and
`renderToPipeableStream` (Node streams).

Fizz handles Suspense during SSR: it streams the fallback HTML immediately,
then replaces it with the resolved content when the suspended component
finishes. This replacement happens via inline `<script>` tags that swap DOM
nodes — the browser sees progressive HTML updates without JavaScript
framework code needing to load first.

In Next.js, Fizz runs during **pass 2** (SSR). It takes the React tree
reconstructed from the Flight stream and produces the HTML document.

### Flight

React's **wire format and runtime for Server Components**. Encompasses:

- **Flight Server** (`react-server-dom-webpack/server`): Serializes a React
  tree containing server components, client references, and Suspense
  boundaries into a binary stream.
- **Flight Client** (`react-server-dom-webpack/client`): Deserializes the
  stream back into a React element tree, resolving client references to
  real components.

The Flight stream is a line-based protocol where each line is a JSON-like
chunk identified by an ID. Client references are encoded as module pointers
(module ID + export name + chunks to load).

In Next.js, Flight runs during **pass 1** (RSC rendering) on the server,
and during hydration/navigation on the client.

### Float

React's system for **resource management during streaming SSR**. Float
(Floating instructions for Ahead-of-time Loading and Tags) handles:

- Hoisting `<link>`, `<style>`, and `<script>` tags to the document `<head>`
  even when they're rendered deep in the component tree
- Deduplicating resources by `href` — rendering the same stylesheet twice
  produces only one `<link>` tag
- Ordering resources via the `precedence` attribute
- Emitting `<link rel="preload">` hints ahead of the content that needs them

Float is what makes `ReactDOM.preload()`, `ReactDOM.preloadModule()`,
`ReactDOM.preconnect()`, `ReactDOM.prefetchDNS()`, `ReactDOM.preinit()`,
etc. work during server rendering. These calls are no-ops outside a
render pass. (Next.js also has internal wrappers like `preloadStyle()` in
`rsc/preloads.ts` that call `ReactDOM.preload(href, {as: 'style'})`.)

In Next.js, Float is used via the `preloadCallbacks` pattern — callbacks
are collected during tree construction and executed inside the `<Preloads />`
component so they run during the Fizz render.

### Fiber

React's **reconciliation engine** and internal representation of the
component tree. Each component instance, DOM node, or Suspense boundary
is represented by a Fiber node. The Fiber tree is the mutable work-in-progress
data structure that React uses to compute updates.

You'll see "Fiber" in React DevTools, error stacks, and occasionally in
Next.js code that interacts with React internals.

## Rendering concepts

### Suspense

React's mechanism for **declarative loading states**. A `<Suspense>` boundary
wraps content that might suspend (throw a Promise). While suspended, the
boundary's `fallback` is shown.

In the context of Next.js:

- **During SSR (Fizz)**: Suspended boundaries stream the fallback HTML first,
  then the resolved content
- **During prerendering (PPR)**: Suspended boundaries at dynamic data access
  points become "holes" in the static shell
- **On the client**: Suspended boundaries show the fallback while data loads

### Postpone

A React mechanism (via `React.unstable_postpone()`) for **PPR**. When called
inside a Suspense boundary during prerendering, it tells React that this
part of the tree cannot be rendered at build time and should be deferred to
request time. Unlike a thrown Promise (which might resolve), a postpone is
permanent for this render — the boundary becomes a hole in the static shell.

### Taint

React's mechanism for **preventing sensitive data from crossing the
server-client boundary**. `React.experimental_taintObjectReference()` and
`React.experimental_taintUniqueValue()` mark values that must not appear
in the Flight stream. If tainted data reaches a client component's props,
React throws an error.

These APIs require the experimental React channel
(`__NEXT_EXPERIMENTAL_REACT`). Without it, calling them throws.

### Activity (formerly Offscreen)

React's component for **managing visibility and priority of subtrees**.
Used in Next.js's `LayoutRouter` to handle segment transitions — the
previous route's content can be kept mounted but deactivated while the
new route renders.

When Cache Components is enabled (`process.env.__NEXT_CACHE_COMPONENTS`),
you'll see `<Activity>` in `layout-router.tsx` wrapping each router state's
content. It has a `mode` prop (`"visible"` or `"hidden"`) that controls
whether the subtree is rendered to the DOM. Without Cache Components,
`Activity` is not used.

## Module system concepts

### Client Reference

A serializable pointer to a `"use client"` module. In the Flight stream, a
client reference is encoded as:

```
{ $$typeof: Symbol(react.client.reference), $$id: "module-path#export" }
```

The Flight client resolves this by looking up the module in the
`clientModules` manifest, loading the required JS chunks, and returning
the actual component.

### Server Reference

A serializable pointer to a **server function** — a function marked with
`"use server"`. Encoded in the Flight stream similarly to client references
but in the opposite direction: the server sends a reference, and the client
can call it back.

See [Server Functions and Server Actions](#server-functions-and-server-actions)
below for how these work end to end.

### `"use cache"` directive

The `"use cache"` directive marks a function or component whose return value
can be cached across requests. SWC compiles the annotated function into a
cacheable wrapper that serializes arguments as a cache key and stores the
result in the Resume Data Cache.

During prerendering, `"use cache"` functions execute in phase 1
(prospective prerender) to warm caches, and their cached results are
replayed in phase 2 (final prerender) without re-execution. At request
time, cached results are served from the Resume Data Cache and invalidated
based on `revalidate` times and tags.

See [Cache Components](./05a-cache-components.md) for the full system:
SWC transform, Resume Data Cache, multi-phase prerendering, and staged
rendering.

### Module Map

The mapping provided to the Flight runtime that resolves module IDs to
loadable chunks. In Next.js, `clientModules` is used by the Flight
_Server_ during RSC rendering to encode client references into the
stream, while `ssrModuleMapping` is used by the Flight _Client_ during
SSR to resolve those references to server-side modules for HTML
generation.

## Server functions and server actions

### `"use server"` — the directive

The `"use server"` directive marks functions that are callable from the
client but execute on the server. It can appear:

- At the **top of a file** — all exported functions in that file become
  server functions
- At the **top of an async function body** (inline) — that individual
  function becomes a server function

SWC compiles each server function into a **server reference**: the function
body stays on the server, and the client receives a serializable reference
containing an action ID.

### Server function vs. server action

These terms are often confused:

- **Server function**: Any function marked with `"use server"`. It can be
  called from client code, and the call is sent to the server as an RPC.
  This is the general term.
- **Server action**: A server function that is used to **mutate data** —
  typically bound to a form's `action` prop or called in response to a
  user interaction. After a server action completes, Next.js revalidates
  affected data and re-renders.

All server actions are server functions, but not all server functions are
server actions. A server function used purely to read data (e.g., passed
to `useActionState` for fetching) is a server function, not a server action.

### How the call works

1. **Build time**: SWC assigns each server function a unique **action ID**
   (a hash). The function body goes into the server bundle. The client
   receives a stub that knows the action ID.

2. **Client invocation**: When the client calls the function (or submits a
   form bound to it), the arguments are serialized using React's Flight
   serializer and sent as a POST request to the server.

3. **Server routing**: Next.js receives the request, looks up the action ID
   in the server actions manifest (`ActionManifest`, accessed via
   `getServerActionsManifest()`), loads the corresponding module, and
   calls the function with the deserialized arguments.

4. **Response**: The function's return value is serialized back via Flight.
   For server actions (mutations), the response also includes an updated
   RSC payload so the client can re-render with fresh data.

### In the codebase

- **Action ID generation**: SWC transform in `crates/next-custom-transforms/`
- **Manifest**: `ActionManifest` maps action IDs → module locations
  (`packages/next/src/build/webpack/plugins/flight-client-entry-plugin.ts`
  collects `actionImports`)
- **Server handler**: `packages/next/src/server/app-render/action-handler.ts`
- **Client integration**: React's `useActionState`, `useFormStatus`, and
  `startTransition` work with server references natively

## Streaming concepts

### Prelude

The initial synchronous HTML output from Fizz before any Suspense boundaries
resolve. In PPR, the prelude is the static shell. The `DynamicHTMLPreludeState`
enum tracks whether the prelude is `Empty` (everything suspended) or `Full`
(some content rendered).

### Resumption

The process of **continuing a partially-rendered response** at request time.
When PPR produces a static shell with holes, the server "resumes" rendering
at request time by filling in the dynamic parts. The postponed state from
the prerender tells React where it left off.

### Selective Hydration

React's ability to **prioritize hydrating interactive parts of the page**.
If a user interacts with a not-yet-hydrated Suspense boundary, React
prioritizes hydrating that boundary over others. This is handled internally
by the Fiber reconciler.
