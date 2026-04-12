# Streaming Protocol

How the Flight stream and HTML stream are produced, combined, and delivered
to the browser as a single progressive HTTP response.

## Overview

A Next.js App Router response is not a single monolithic HTML document. It's
a **progressive stream** that interleaves two types of content:

1. **HTML chunks** — produced by Fizz (React DOM's streaming renderer) as
   Suspense boundaries resolve
2. **Flight data chunks** — the serialized RSC payload, embedded as
   `<script>` tags so the client can hydrate without a second request

Both streams run concurrently. The HTML stream is the "outer" stream that
the browser parses as it arrives; the Flight data is injected into it
via a transform stream that appends `<script>` tags after each HTML chunk.

```
Pass 1 (RSC)          Pass 2 (SSR)               Transform pipeline
─────────────         ─────────────              ─────────────────────
Flight server    ──►  Flight client  ──►  Fizz   ──►  [buffer]
  │                                        │          [metadata insertion]
  │                                        │          [suffix insertion]
  │   Flight stream (binary)               │          [Flight data injection] ◄── inlinedDataStream
  │                                        │          [move closing tags]
  └────────────────────────────────────────►│          [head insertion]
       (consumed by SSR)                   HTML        │
                                          stream       ▼
                                                   Final response
                                                   (interleaved HTML + <script> tags)
```

## The Flight wire format

### Chunk types

The Flight stream is embedded in the HTML as calls to `self.__next_f.push()`.
Each call passes a **segment** — a small array whose first element is a
type discriminator:

| Type | Name       | Payload           | Description                                     |
| ---- | ---------- | ----------------- | ----------------------------------------------- |
| `0`  | Bootstrap  | (none)            | Initializes the `__next_f` array. Always first. |
| `1`  | Data       | `string`          | A UTF-8 text chunk from the Flight stream.      |
| `2`  | Form state | `any`             | Server Action form state for hydration.         |
| `3`  | Binary     | `string` (base64) | A binary chunk that couldn't be UTF-8 decoded.  |

These constants are defined in
`server/app-render/use-flight-response.tsx` (server side) and the
corresponding TypeScript type on the client:

```typescript
// client/app-index.tsx
type FlightSegment =
  | [isBootStrap: 0]
  | [isNotBootstrap: 1, responsePartial: string]
  | [isFormState: 2, formState: any]
  | [isBinary: 3, responseBase64Partial: string]
```

### What the HTML looks like

A streamed response contains multiple `<script>` tags that arrive
progressively as the document streams:

```html
<!-- Bootstrap (always first) -->
<script>
  ;(self.__next_f = self.__next_f || []).push([0])
</script>

<!-- Optional: form state for Server Actions -->
<script>
  self.__next_f.push([2, { actionResult: '...' }])
</script>

<!-- Flight data chunks (one <script> per chunk from the Flight stream) -->
<script>
  self.__next_f.push([1, '0:"$Sreact.suspense"\n'])
</script>
<script>
  self.__next_f.push([1, '1:["$","div",null,{...}]\n'])
</script>

<!-- Binary chunks (non-UTF-8 data, base64 encoded) -->
<script>
  self.__next_f.push([3, 'SGVsbG8gV29ybGQ='])
</script>
```

All JSON payloads are HTML-escaped via `htmlEscapeJsonString()` to prevent
script injection — characters like `<`, `>`, `&` are escaped to their
Unicode equivalents (`\u003c`, etc.).

### Server-side encoding

`createInlinedDataReadableStream()` in `use-flight-response.tsx` wraps the
raw Flight byte stream into script tags:

1. **`writeInitialInstructions()`** — Emits the bootstrap `[0]` segment and
   optional form state `[2, ...]` segment in a single `<script>` tag.

2. **`writeFlightDataInstruction()`** — Called for each chunk from the Flight
   stream. Attempts UTF-8 decoding first:
   - **Success** → emits a `[1, text]` segment
   - **Failure** (invalid UTF-8) → base64-encodes the bytes and emits a
     `[3, base64]` segment

Each chunk becomes its own `<script>` tag, so the browser can execute it
as soon as it arrives (progressive parsing).

### Client-side consumption

The client in `app-index.tsx` reconstructs a `ReadableStream` from the
inlined script data:

1. **Before hydration starts**, script tags execute and call
   `self.__next_f.push()`. Since the real `push` hasn't been patched yet,
   segments accumulate in `initialServerDataBuffer`.

2. **When React hydration starts**, `nextServerDataRegisterWriter()` is
   called with a `ReadableStreamDefaultController`. It flushes the buffer
   into the controller.

3. **After registration**, `self.__next_f.push` is monkey-patched to route
   new segments directly to the controller (bypassing the array).

4. **On `DOMContentLoaded`**, the stream is closed — all Flight data has
   arrived.

The reconstructed `ReadableStream` is passed to
`createFromReadableStream()` from `react-server-dom-webpack/client`, which
deserializes the Flight protocol back into a React element tree for
hydration.

```
HTML arrives              Client JS loads           React hydration
─────────────            ─────────────────          ─────────────────
<script>[0]</script>  ──►  buffer = []
<script>[1,...]</script>─► buffer.push(data)
<script>[1,...]</script>─► buffer.push(data)
                           │
                           ├─► registerWriter(ctrl)
                           │     flush buffer → ctrl
                           │     patch push → ctrl.enqueue
                           │                                createFromReadableStream(stream)
<script>[1,...]</script>──►──► ctrl.enqueue(data) ────────►   React processes chunks
DOMContentLoaded ─────────►──► ctrl.close() ───────────────►   Stream complete
```

## Fizz HTML streaming

### How Suspense boundaries stream

React's Fizz renderer (`renderToReadableStream` / `renderToPipeableStream`)
handles Suspense during SSR by streaming content progressively:

1. **Shell** — Everything outside Suspense boundaries renders immediately.
   Fizz sends the outer HTML structure, `<head>`, and any content that
   doesn't suspend.

2. **Fallbacks** — For suspended components, Fizz emits the `<Suspense>`
   fallback content as a hidden template with a boundary ID:

   ```html
   <!--$?--><template id="B:0"></template>Loading...<br /><!--/$-->
   ```

3. **Resolved content** — When a suspended component finishes, Fizz sends
   an inline `<script>` tag that contains the resolved HTML and a function
   call to swap it into the DOM:

   ```html
   <div hidden id="S:0"><p>Loaded content!</p></div>
   <script>
     $RC('B:0', 'S:0')
   </script>
   ```

   `$RC` (completeBoundary) is a small runtime function that React injects
   at the start of the stream. It replaces the fallback content with the
   resolved content by moving DOM nodes.

4. **Completed boundaries** arrive in whatever order the data resolves —
   they don't need to follow document order. The browser parses and
   executes each `<script>` as it arrives, so the UI updates
   progressively.

### Shell readiness

Next.js uses Fizz's lifecycle callbacks to coordinate streaming:

- **`onShellReady`** (Node.js `renderToPipeableStream` only) — Fires when
  the synchronous shell is ready. Next.js starts piping to the response at
  this point. See `stream-ops.node.ts`.

- **`allReady`** (Web Streams `renderToReadableStream`) — A promise that
  resolves when all content (including Suspense) has rendered. For static
  generation, Next.js awaits this before consuming the stream
  (`continueFizzStream` checks `isStaticGeneration`). For dynamic
  responses, it does _not_ await — the stream begins flowing after one
  React render task completes.

## Stream combination pipeline

The HTML stream from Fizz and the Flight data stream are combined through a
**transform pipeline** in `continueFizzStream()` (defined in
`stream-utils/node-web-streams-helper.ts`):

```
renderStream (from Fizz)
  │
  ├── createBufferedTransformStream()
  │     Buffer chunks to avoid flushing too frequently
  │
  ├── createHtmlDataDplIdTransformStream()         [if deploymentId]
  │     Insert data-dpl-id attribute on <html> tag
  │
  ├── createMetadataTransformStream()
  │     Insert server-generated metadata into <head>
  │
  ├── createDeferredSuffixStream()                 [if suffix]
  │     Append suffix content (scripts before </body>)
  │
  ├── createFlightDataInjectionTransformStream()   ◄── inlinedDataStream
  │     Merge Flight <script> tags into the HTML stream
  │
  ├── createRootLayoutValidatorStream()            [dev only]
  │     Validate <html> and <body> tags exist
  │
  ├── createMoveSuffixStream()
  │     Move </body></html> to the very end
  │
  └── createHeadInsertionTransformStream()
        Insert server-generated HTML into <head>
```

These transforms are chained via `chainTransformers()`, which pipes the
stream through each `TransformStream` in sequence.

### Flight data injection

`createFlightDataInjectionTransformStream()` is the key transform that
merges Flight data into the HTML. It works as a pull-based interleave:

1. **HTML chunks pass through** — When an HTML chunk arrives from the
   upstream transform, it's enqueued to the output immediately.

2. **Flight chunks are pulled in parallel** — A separate async loop reads
   from the `inlinedDataStream` (the `<script>` tags produced by
   `createInlinedDataReadableStream`). Each Flight chunk is also enqueued
   to the output.

3. **HTML is prioritized** — When a new Flight chunk arrives, the transform
   yields for one microtask (`await atLeastOneTask()`) before enqueuing it.
   This gives the HTML stream a chance to flush first, since the SSR output
   depends on the same RSC data — when a new RSC chunk is produced, it
   typically causes Fizz to produce a corresponding HTML chunk too.

4. **Delayed start** — When `delayDataUntilFirstHtmlChunk` is true (the
   common case for dynamic rendering), Flight data reading doesn't begin
   until the first HTML chunk has passed through. This ensures the shell
   HTML is sent before any `<script>` Flight data.

5. **Flush on HTML end** — When the HTML stream finishes (`flush()`), any
   remaining Flight data is drained. This handles the case where there's
   more Flight data than HTML (e.g., deeply nested server component data
   that resolves after all Suspense boundaries).

### Stream chaining

`chainStreams()` (in `stream-utils/node-web-streams-helper.ts`) concatenates
multiple `ReadableStream`s sequentially — the second starts only after the
first ends. This is used when the HTML is already complete (e.g., PPR
data-only resume) and the Flight data just needs to be appended:

```typescript
// PPR data-only resume: HTML is pre-rendered, just append Flight data
return chainStreams(inlinedDataStream, createDocumentClosingStream())
```

## Putting it all together

### Dynamic request (full streaming)

```
1. RSC pass produces Flight stream
2. SSR pass consumes Flight stream, produces HTML stream via Fizz
3. Both streams enter continueFizzStream():
   a. HTML flows through buffer → metadata → suffix transforms
   b. Flight data is wrapped in <script> tags (createInlinedDataReadableStream)
   c. createFlightDataInjectionTransformStream merges them:
      - First HTML chunk (shell) goes out
      - Flight <script> tags interleave with Suspense resolution <script> tags
      - </body></html> is held until everything is done (createMoveSuffixStream)
4. Browser receives progressive stream:
   - Parses shell HTML → renders initial UI
   - Executes Flight <script> tags → buffers RSC data
   - Executes Suspense resolution <script> tags → swaps in resolved content
   - On DOMContentLoaded → Flight stream closes → hydration completes
```

### Static generation

For static pages (`isStaticGeneration: true`), `continueFizzStream()` awaits
`renderStream.allReady` before consuming the stream. This means all Suspense
boundaries resolve before any HTML is written — the output is a complete
document, not a progressive stream. The Flight data is still embedded as
`<script>` tags for client-side hydration.

### PPR (Partial Pre-Rendering)

PPR splits the response into a **static shell** (pre-rendered at build
time) and **dynamic holes** (filled at request time):

1. At build time, `continueStaticPrerender()` produces the static HTML
   with Suspense fallbacks for dynamic content. The Flight data for the
   static portion is embedded in the HTML.

2. At request time, when the postponed state indicates `DynamicState.DATA`
   (HTML is complete, only RSC data is dynamic), the response is just the
   Flight data stream followed by closing tags:

   ```typescript
   chainStreams(inlinedDataStream, createDocumentClosingStream())
   ```

3. When the postponed state indicates `DynamicState.HTML` (some HTML is
   also dynamic), `continueDynamicHTMLResume()` streams the resumed HTML
   with Flight data injected, similar to a full dynamic request.

## Key source files

| File                                             | Role                                                                                    |
| ------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `server/app-render/use-flight-response.tsx`      | `createInlinedDataReadableStream` — wraps Flight bytes in `<script>` tags               |
| `client/app-index.tsx`                           | Client bootstrap — reconstructs Flight stream from `self.__next_f`                      |
| `server/stream-utils/node-web-streams-helper.ts` | `continueFizzStream`, `chainStreams`, `chainTransformers`, all transform streams        |
| `server/app-render/stream-ops.ts`                | Runtime-conditional re-exports (Node vs Web)                                            |
| `server/app-render/stream-ops.node.ts`           | Node.js stream operations (`renderToPipeableStream`, `createNodeInlinedDataStream`)     |
| `server/app-render/stream-ops.web.ts`            | Web stream operations (`renderToReadableStream`, `createWebInlinedDataStream`)          |
| `server/app-render/app-render.tsx`               | Orchestrator — wires Flight stream + HTML stream into `continueFizzStream`              |
| `server/render-result.ts`                        | `RenderResult` — final response wrapper, uses `chainStreams` for multi-stream responses |
