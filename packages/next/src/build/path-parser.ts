import { normalizePathSep } from '../shared/lib/page-path/normalize-path-sep'
import { normalizeAppPath } from '../shared/lib/router/utils/app-paths'
import { normalizePagePath } from '../shared/lib/page-path/normalize-page-path'
import { ensureLeadingSlash } from '../shared/lib/page-path/ensure-leading-slash'
import {
  getSegmentParam,
  getParamProperties,
} from '../shared/lib/router/utils/get-segment-param'
import {
  isInterceptionRouteAppPath,
  type InterceptionMarker,
} from '../shared/lib/router/utils/interception-routes'
import { isGroupSegment, isParallelRouteSegment } from '../shared/lib/segment'
import {
  getRouteRegex,
  type RouteRegex,
} from '../shared/lib/router/utils/route-regex'
import type { PageExtensions } from './page-extensions-type'

// ============================================================================
// Types
// ============================================================================

/** The type of file/route being represented */
export type PathType =
  | 'app-page' // page.tsx in app directory
  | 'app-route' // route.tsx in app directory (API route handler)
  | 'app-layout' // layout.tsx in app directory
  | 'app-default' // default.tsx in app directory
  | 'app-not-found' // not-found.tsx in app directory
  | 'app-error' // error.tsx in app directory
  | 'app-loading' // loading.tsx in app directory
  | 'app-template' // template.tsx in app directory
  | 'pages-page' // page in pages directory
  | 'pages-api' // API route in pages directory
  | 'root' // middleware, instrumentation, etc.
  | 'unknown'

/** Which directory the path belongs to */
export type PathDirectory = 'app' | 'pages' | 'root' | null

/** Type of a parsed segment */
export type ParsedSegmentType =
  | 'static'
  | 'dynamic'
  | 'catch-all'
  | 'optional-catch-all'
  | 'group'
  | 'parallel'
  | 'interception'

/** A parsed segment from a route path */
export interface ParsedSegment {
  value: string // Raw segment value (e.g., '[id]', '(group)', '@slot')
  type: ParsedSegmentType
  paramName?: string // For dynamic segments, the param name (e.g., 'id' from '[id]')
  interceptionMarker?: InterceptionMarker // For interception segments (e.g., '(.)', '(..)')
}

/** Information about dynamic route parameters */
export interface RouteParams {
  names: string[] // Param names in order
  types: Record<string, 'dynamic' | 'catch-all' | 'optional-catch-all'> // Param name -> type
}

/** Slot information for parallel routes */
export interface SlotInfo {
  name: string // Slot name (without @)
  parent: string // Normalized parent route
}

/** Route information for route manifests */
export interface RouteInfo {
  route: string
  filePath: string
}

/** The result of parsing a path */
export interface ParsedPath {
  raw: string // Original path as provided
  normalized: string // Fully normalized route (groups, parallel routes, leaf segments removed)
  normalizedWithGroups: string // Groups preserved, parallel routes and leaf segments removed
  bundlePath: string // File path portion for bundle naming
  type: PathType // Path type (page, layout, route handler, etc.)
  directory: PathDirectory // Which directory (app, pages, root)
  segments: ParsedSegment[] // Parsed segments
  isDynamic: boolean // Has any dynamic segments
  hasCatchAll: boolean // Has [...param] segment
  hasOptionalCatchAll: boolean // Has [[...param]] segment
  isInterceptionRoute: boolean // Is an interception route
  slot: SlotInfo | null // Parallel route slot info
  params: () => RouteParams // Lazy: dynamic parameter info
  regex: () => RouteRegex // Lazy: route regex for matching
}

export interface ParsePathOptions {
  pageExtensions: PageExtensions // File extensions (e.g., ['tsx', 'ts', 'jsx', 'js'])
  appDir?: string // Absolute path to app directory
  pagesDir?: string // Absolute path to pages directory
  rootDir?: string // Absolute path to root/project directory
  isAbsolutePath?: boolean // If true, input is absolute file system path
}

// ============================================================================
// Internal Helpers
// ============================================================================

const LEAF_SEGMENTS = new Set([
  'page',
  'route',
  'layout',
  'default',
  'not-found',
  'error',
  'loading',
  'template',
])
const INTERCEPTION_MARKERS = ['(..)(..)', '(.)', '(..)', '(...)'] as const

function removeExtension(path: string, extensions: PageExtensions): string {
  return path.replace(new RegExp(`\\.(${extensions.join('|')})$`), '')
}

function getLeafFileName(
  path: string,
  extensions: PageExtensions
): string | null {
  const segments = normalizePathSep(path).split('/')
  const last = segments[segments.length - 1]
  return last ? removeExtension(last, extensions) : null
}

function determinePathType(
  leafName: string | null,
  directory: PathDirectory,
  routePath: string
): PathType {
  if (directory === 'app') {
    const typeMap: Record<string, PathType> = {
      page: 'app-page',
      route: 'app-route',
      layout: 'app-layout',
      default: 'app-default',
      'not-found': 'app-not-found',
      error: 'app-error',
      loading: 'app-loading',
      template: 'app-template',
    }
    return leafName ? (typeMap[leafName] ?? 'unknown') : 'unknown'
  }
  if (directory === 'pages') {
    return routePath.startsWith('/api/') || routePath === '/api'
      ? 'pages-api'
      : 'pages-page'
  }
  return directory === 'root' ? 'root' : 'unknown'
}

function parseSegments(routePath: string): ParsedSegment[] {
  const segments: ParsedSegment[] = []

  for (const part of routePath.split('/').filter(Boolean)) {
    // Check for interception markers first
    const marker = INTERCEPTION_MARKERS.find((m) => part.startsWith(m))
    if (marker) {
      segments.push({
        value: part,
        type: 'interception',
        interceptionMarker: marker,
      })
      continue
    }

    // Parallel route (@slot)
    if (isParallelRouteSegment(part)) {
      segments.push({ value: part, type: 'parallel', paramName: part.slice(1) })
      continue
    }

    // Route group ((group))
    if (isGroupSegment(part)) {
      segments.push({ value: part, type: 'group' })
      continue
    }

    // Dynamic segment ([param], [...param], [[...param]])
    const param = getSegmentParam(part)
    if (param) {
      const { repeat, optional } = getParamProperties(param.paramType)
      const type: ParsedSegmentType =
        repeat && optional
          ? 'optional-catch-all'
          : repeat
            ? 'catch-all'
            : 'dynamic'
      segments.push({ value: part, type, paramName: param.paramName })
      continue
    }

    // Static segment
    segments.push({ value: part, type: 'static' })
  }

  return segments
}

function extractSlot(segments: ParsedSegment[]): SlotInfo | null {
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i]
    if (seg.type === 'parallel' && seg.paramName) {
      const parentPath =
        '/' +
        segments
          .slice(0, i)
          .filter((s) => s.type !== 'group' && s.type !== 'parallel')
          .map((s) => s.value)
          .join('/')
      return { name: seg.paramName, parent: normalizeAppPath(parentPath) }
    }
  }
  return null
}

function normalizeWithGroups(routePath: string): string {
  const result = routePath
    .split('/')
    .filter(Boolean)
    .filter((seg) => !isParallelRouteSegment(seg) && !LEAF_SEGMENTS.has(seg))
  return ensureLeadingSlash(result.join('/'))
}

function detectDirectory(
  path: string,
  isAbsolutePath: boolean,
  appDir?: string,
  pagesDir?: string,
  rootDir?: string
): { directory: PathDirectory; routePath: string } {
  if (isAbsolutePath && (appDir || pagesDir || rootDir)) {
    const dirs = [
      { dir: appDir, type: 'app' as const },
      { dir: pagesDir, type: 'pages' as const },
      { dir: rootDir, type: 'root' as const },
    ]
    for (const { dir, type } of dirs) {
      if (dir) {
        const normalized = normalizePathSep(dir)
        if (path.startsWith(normalized + '/')) {
          return { directory: type, routePath: path.slice(normalized.length) }
        }
      }
    }
  }

  // Infer from path prefix
  if (path.startsWith('/app/') || path === '/app') {
    return { directory: 'app', routePath: path.slice(4) }
  }
  if (path.startsWith('/pages/') || path === '/pages') {
    return { directory: 'pages', routePath: path.slice(6) }
  }
  if (path.startsWith('private-next-app-dir/')) {
    return {
      directory: 'app',
      routePath: '/' + path.slice('private-next-app-dir/'.length),
    }
  }
  if (path.startsWith('private-next-pages/')) {
    return {
      directory: 'pages',
      routePath: '/' + path.slice('private-next-pages/'.length),
    }
  }

  return { directory: null, routePath: path }
}

function computeNormalized(
  directory: PathDirectory,
  pathWithoutExt: string
): string {
  if (directory === 'app') {
    let result = normalizeAppPath(pathWithoutExt)
    // Remove remaining leaf segments that normalizeAppPath doesn't handle
    result = result.replace(
      /\/(layout|default|not-found|error|loading|template)$/,
      ''
    )
    return result || '/'
  }
  if (directory === 'pages') {
    return ensureLeadingSlash(pathWithoutExt.replace(/\/index$/, '') || '/')
  }
  return ensureLeadingSlash(pathWithoutExt)
}

// ============================================================================
// Main API
// ============================================================================

/**
 * Parse a path into a comprehensive ParsedPath object.
 *
 * Unified API for path handling in Next.js:
 * - Path normalization (groups, parallel routes, leaf segments)
 * - Path classification (page, layout, route handler, etc.)
 * - Segment parsing (static, dynamic, catch-all, etc.)
 * - Dynamic parameter extraction
 * - Route regex generation
 *
 * @example
 * const parsed = parsePath('/app/(marketing)/blog/[slug]/page.tsx', {
 *   pageExtensions: ['tsx', 'ts', 'jsx', 'js'],
 * })
 * parsed.normalized // '/blog/[slug]'
 * parsed.type       // 'app-page'
 * parsed.isDynamic  // true
 * parsed.params()   // { names: ['slug'], types: { slug: 'dynamic' } }
 */
export function parsePath(
  inputPath: string,
  options: ParsePathOptions
): ParsedPath {
  const {
    pageExtensions,
    appDir,
    pagesDir,
    rootDir,
    isAbsolutePath = false,
  } = options
  const path = normalizePathSep(inputPath)

  const { directory, routePath: rawRoutePath } = detectDirectory(
    path,
    isAbsolutePath,
    appDir,
    pagesDir,
    rootDir
  )
  const routePath = ensureLeadingSlash(rawRoutePath)
  const pathWithoutExt = removeExtension(routePath, pageExtensions)

  const leafName = getLeafFileName(routePath, pageExtensions)
  const pathType = determinePathType(leafName, directory, pathWithoutExt)
  const segments = parseSegments(pathWithoutExt)

  const normalized = computeNormalized(directory, pathWithoutExt)
  const normalizedWithGroups = normalizeWithGroups(pathWithoutExt)
  const bundlePath =
    directory === 'pages' ? normalizePagePath(normalized) : normalized

  const dynamicSegments = segments.filter(
    (s) =>
      s.type === 'dynamic' ||
      s.type === 'catch-all' ||
      s.type === 'optional-catch-all'
  )

  // Lazy caches
  let cachedParams: RouteParams | null = null
  let cachedRegex: RouteRegex | null = null

  return {
    raw: inputPath,
    normalized,
    normalizedWithGroups,
    bundlePath,
    type: pathType,
    directory,
    segments,
    isDynamic: dynamicSegments.length > 0,
    hasCatchAll: segments.some((s) => s.type === 'catch-all'),
    hasOptionalCatchAll: segments.some((s) => s.type === 'optional-catch-all'),
    isInterceptionRoute: isInterceptionRouteAppPath(pathWithoutExt),
    slot: extractSlot(segments),
    params: () => {
      if (!cachedParams) {
        const names: string[] = []
        const types: Record<
          string,
          'dynamic' | 'catch-all' | 'optional-catch-all'
        > = {}
        for (const seg of dynamicSegments) {
          if (seg.paramName) {
            names.push(seg.paramName)
            types[seg.paramName] = seg.type as
              | 'dynamic'
              | 'catch-all'
              | 'optional-catch-all'
          }
        }
        cachedParams = { names, types }
      }
      return cachedParams
    },
    regex: () => {
      if (!cachedRegex) cachedRegex = getRouteRegex(normalized)
      return cachedRegex
    },
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

/** Check if a parsed path is a routable page (page.tsx or route.tsx) */
export function isRoutablePath(parsed: ParsedPath): boolean {
  return ['app-page', 'app-route', 'pages-page', 'pages-api'].includes(
    parsed.type
  )
}

/** Check if a parsed path is in the app directory */
export function isAppPath(parsed: ParsedPath): boolean {
  return parsed.directory === 'app'
}

/** Check if a parsed path is in the pages directory */
export function isPagesPath(parsed: ParsedPath): boolean {
  return parsed.directory === 'pages'
}

/** Check if a parsed path is an API route */
export function isApiRoute(parsed: ParsedPath): boolean {
  return parsed.type === 'app-route' || parsed.type === 'pages-api'
}

/** Check if a parsed path is a layout */
export function isLayout(parsed: ParsedPath): boolean {
  return parsed.type === 'app-layout'
}

/** Check if the path should be ignored (contains /_) */
export function isIgnoredPath(parsed: ParsedPath): boolean {
  return parsed.raw.includes('/_') || parsed.normalized.includes('/_')
}

/** Get all dynamic param names from a parsed path */
export function getParamNames(parsed: ParsedPath): string[] {
  return parsed.params().names
}

/** Create a ParsedPath from a pre-normalized route */
export function parseRoute(
  route: string,
  _directory: PathDirectory,
  pageExtensions: PageExtensions
): ParsedPath {
  return parsePath(route, { pageExtensions, isAbsolutePath: false })
}

// ============================================================================
// Slot Collection Utilities
// ============================================================================

// Default extensions for cases where we only need basic parsing
const DEFAULT_EXTENSIONS: PageExtensions = ['tsx', 'ts', 'jsx', 'js']

/**
 * Add a slot to the slots array if it doesn't already exist.
 * Returns true if a new slot was added.
 */
export function addSlotIfNew(
  slots: SlotInfo[],
  pagePath: string,
  pageExtensions: PageExtensions = DEFAULT_EXTENSIONS
): boolean {
  const parsed = parsePath(pagePath, { pageExtensions })
  const slot = parsed.slot
  if (!slot) return false
  if (slots.some((s) => s.name === slot.name && s.parent === slot.parent)) {
    return false
  }
  slots.push(slot)
  return true
}

/**
 * Extract slots from a route mapping object.
 */
export function extractSlotsFromRoutes(
  routes: { [page: string]: string },
  skipRoutes?: Set<string>,
  pageExtensions: PageExtensions = DEFAULT_EXTENSIONS
): SlotInfo[] {
  const slots: SlotInfo[] = []
  for (const route of Object.keys(routes)) {
    if (skipRoutes?.has(route)) continue
    addSlotIfNew(slots, route, pageExtensions)
  }
  return slots
}

/**
 * Combine and deduplicate slot arrays.
 */
export function combineSlots(...slotArrays: SlotInfo[][]): SlotInfo[] {
  const slotSet = new Set<string>()
  const result: SlotInfo[] = []
  for (const slots of slotArrays) {
    for (const slot of slots) {
      const key = `${slot.name}:${slot.parent}`
      if (!slotSet.has(key)) {
        slotSet.add(key)
        result.push(slot)
      }
    }
  }
  return result
}
