import { createRequire } from 'module'
import path from 'path'

import type { CollectionDefinition, ContentEntry, StoreEntry } from './types'

// Use a global symbol so the singleton survives across bundled module instances
const CONTENT_COLLECTIONS_SYMBOL = Symbol.for('next.contentCollections')

interface ContentCollectionsState {
  config: Record<string, CollectionDefinition>
  cache: Map<string, ContentEntry[]>
}

function getState(): ContentCollectionsState | undefined {
  return (globalThis as any)[CONTENT_COLLECTIONS_SYMBOL]
}

function setState(
  config: Record<string, CollectionDefinition>
): ContentCollectionsState {
  const state: ContentCollectionsState = {
    config,
    cache: new Map(),
  }
  ;(globalThis as any)[CONTENT_COLLECTIONS_SYMBOL] = state
  return state
}

/**
 * Initialize content collections with an already-loaded config.
 * Called from NextServer after loadConfig() so the main server process
 * avoids a second require() of next.config.js.
 */
export function _initContentCollections(
  config: Record<string, CollectionDefinition>
): void {
  setState(config)
}

/**
 * Lazily initialize content collections by reading next.config from disk.
 *
 * This fallback is only needed in worker processes (static-paths worker,
 * export worker, etc.) that don't share the main server's globalThis.
 * The main server process is initialized eagerly via _initContentCollections().
 */
async function ensureState(): Promise<ContentCollectionsState> {
  const existing = getState()
  if (existing) return existing

  const dir = process.env.__NEXT_PRIVATE_CONTENT_DIR
  if (!dir) {
    throw new Error(
      'Content collections: __NEXT_PRIVATE_CONTENT_DIR is not set.'
    )
  }

  const configPath = path.join(dir, 'next.config.js')
  const _require = createRequire(configPath)
  const userConfig = _require(configPath)
  // Handle default export (ESM interop)
  const config = userConfig?.default ?? userConfig

  if (!config?.contentCollections) {
    throw new Error(
      'Content collections not configured. Add contentCollections to next.config.'
    )
  }

  return setState(config.contentCollections)
}

export function _invalidateCollection(): void {
  const state = getState()
  if (!state) return
  state.cache.clear()
}

async function loadCollection(
  name: string,
  state: ContentCollectionsState
): Promise<ContentEntry[]> {
  const def = state.config[name]
  if (!def) {
    throw new Error(
      `Content collection "${name}" not found. Available collections: ${Object.keys(state.config).join(', ')}`
    )
  }

  const map = new Map<string, StoreEntry>()

  await def.loader.load({
    store: {
      set: (entry: StoreEntry) => {
        if (map.has(entry.id)) {
          console.warn(
            `Content collection "${name}": duplicate entry ID "${entry.id}" — the earlier entry will be overwritten.`
          )
        }
        map.set(entry.id, entry)
      },
    },
    collection: name,
  })

  const entries: ContentEntry[] = []

  for (const [, storeEntry] of map) {
    let data = storeEntry.data

    if (def.schema) {
      const result = def.schema['~standard'].validate(data)
      if ('issues' in result) {
        const messages = result.issues.map((i) => i.message).join(', ')
        throw new Error(
          `Schema validation failed for entry "${storeEntry.id}" in collection "${name}": ${messages}`
        )
      }
      data = result.value as Record<string, any>
    }

    const computed = def.computed ? def.computed(data) : {}

    entries.push({
      _meta: { id: storeEntry.id, collection: name },
      ...data,
      ...computed,
    })
  }

  return entries
}

export async function getCollection(name: string): Promise<ContentEntry[]> {
  const isDev = !!process.env.__NEXT_DEV_SERVER
  const state = await ensureState()

  // In dev mode, skip caching entirely — the render worker is a separate
  // process so cache invalidation from the router server doesn't reach it.
  // Always re-read from disk to pick up content file changes.
  if (!isDev) {
    const cached = state.cache.get(name)
    if (cached) return cached
  }

  const entries = await loadCollection(name, state)

  if (!isDev) {
    state.cache.set(name, entries)
  }
  return entries
}

export async function getEntry(
  name: string,
  id: string
): Promise<ContentEntry | undefined> {
  const entries = await getCollection(name)
  return entries.find((e) => e._meta.id === id)
}
