/**
 * Core structured logging types for Next.js dev mode
 *
 * This is the canonical event format - all dev logs flow through this schema.
 * No UI decisions, no storage decisions - just structured data.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export type LogSource =
  | 'system' // Next.js internals (compiler, router, etc)
  | 'userland' // User's server-side code (console.log in app)
  | 'browser' // Browser console logs

export type LogScope =
  | 'compiler'
  | 'router'
  | 'request'
  | 'fetch'
  | 'console'
  | 'hmr'
  | string // Allow custom scopes

/**
 * Structured data for specific log types
 * This mirrors the existing StructuredLogData from TUI but lives at the core
 */
export type StructuredData =
  | {
      type: 'request'
      method: string
      url: string
      status: number
      totalTime: number
      requestType?: 'load' | 'nav' | 'action'
      actionId?: string | null
      actionName?: string
      actionFile?: string
      timings?: Array<{ label: string; time: number }>
      fetchMetrics?: Array<{
        method: string
        url: string
        status: number
        totalTime: number
        cacheStatus?: string
        cacheReason?: string
        cacheWarning?: string
      }>
    }
  | {
      type: 'console'
      source: 'browser' | 'server'
      method: string
      message: string
      location?: string
      stack?: string[]
      rawStack?: string
    }
  | {
      type: 'compilation'
      loading: boolean
      trigger?: string
      url?: string
      errors?: string[]
      warnings?: string[]
      totalModulesCount?: number
    }
  | {
      type: 'fetch'
      method: string
      url: string
      status: number
      totalTime: number
      cacheStatus?: string
      cacheReason?: string
      cacheWarning?: string
    }

/**
 * The canonical log event - everything becomes this
 */
export interface LogEvent {
  /** Timestamp in milliseconds */
  ts: number

  /** Session ID to group logs across restarts */
  sessionId: string

  /** Log level */
  level: LogLevel

  /** Where this log came from */
  source: LogSource

  /** Optional scope for filtering (e.g., 'compiler', 'router') */
  scope?: LogScope

  /** Human-readable message (always present as fallback) */
  message: string

  /** Structured data for rich rendering */
  structured?: StructuredData

  /** Optional file location */
  location?: string

  /** Optional stack trace lines */
  stack?: string[]
}

/**
 * Sink interface - anything that wants to consume log events
 */
export interface LogSink {
  /** Name for debugging */
  name: string

  /** Write a log event (async, non-blocking) */
  write(event: LogEvent): void | Promise<void>

  /** Optional: close/cleanup */
  close?(): void | Promise<void>
}

/**
 * Filter function for querying logs
 */
export type LogFilter = (event: LogEvent) => boolean
