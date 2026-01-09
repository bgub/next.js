/**
 * Central logging stream for Next.js dev mode
 *
 * Architecture:
 * 1. All logs flow through emit()
 * 2. Stored in bounded ring buffer (fast, predictable memory)
 * 3. Fanned out to registered sinks (TUI, file, SQLite, etc)
 *
 * This is the single source of truth for structured dev logs.
 */

import { RingBuffer } from './ring-buffer'
import type {
  LogEvent,
  LogSink,
  LogFilter,
  LogLevel,
  LogSource,
  StructuredData,
} from './types'

export class LogStream {
  private buffer: RingBuffer<LogEvent>
  private sinks: Map<string, LogSink> = new Map()
  private sessionId: string

  constructor(capacity: number = 1000) {
    this.buffer = new RingBuffer<LogEvent>(capacity)
    this.sessionId = this.generateSessionId()
  }

  /**
   * Emit a log event - the main API
   */
  emit(
    level: LogLevel,
    message: string,
    options?: {
      source?: LogSource
      scope?: string
      structured?: StructuredData
      location?: string
      stack?: string[]
    }
  ): void {
    const event: LogEvent = {
      ts: Date.now(),
      sessionId: this.sessionId,
      level,
      message,
      source: options?.source || 'system',
      scope: options?.scope,
      structured: options?.structured,
      location: options?.location,
      stack: options?.stack,
    }

    // Store in ring buffer
    this.buffer.push(event)

    // Fan out to sinks (async, don't block)
    for (const sink of this.sinks.values()) {
      try {
        const result = sink.write(event)
        // Don't await - sinks must not block emission
        if (result instanceof Promise) {
          result.catch((err) => {
            console.error(`[LogStream] Sink "${sink.name}" error:`, err)
          })
        }
      } catch (err) {
        console.error(`[LogStream] Sink "${sink.name}" threw:`, err)
      }
    }
  }

  /**
   * Convenience methods for common log levels
   */
  debug(message: string, options?: Parameters<LogStream['emit']>[2]): void {
    this.emit('debug', message, options)
  }

  info(message: string, options?: Parameters<LogStream['emit']>[2]): void {
    this.emit('info', message, options)
  }

  warn(message: string, options?: Parameters<LogStream['emit']>[2]): void {
    this.emit('warn', message, options)
  }

  error(message: string, options?: Parameters<LogStream['emit']>[2]): void {
    this.emit('error', message, options)
  }

  /**
   * Register a sink to receive log events
   */
  addSink(sink: LogSink): void {
    if (this.sinks.has(sink.name)) {
      throw new Error(`Sink "${sink.name}" already registered`)
    }
    this.sinks.set(sink.name, sink)
  }

  /**
   * Remove a sink
   */
  removeSink(name: string): void {
    const sink = this.sinks.get(name)
    if (sink?.close) {
      sink.close()
    }
    this.sinks.delete(name)
  }

  /**
   * Query recent logs
   */
  recent(n: number = 100): LogEvent[] {
    return this.buffer.tail(n)
  }

  /**
   * Filter logs
   */
  filter(predicate: LogFilter, limit?: number): LogEvent[] {
    const filtered = this.buffer.filter(predicate)
    return limit ? filtered.slice(-limit) : filtered
  }

  /**
   * Get logs since timestamp
   */
  since(timestamp: number, limit?: number): LogEvent[] {
    const logs = this.buffer.since(timestamp)
    return limit ? logs.slice(-limit) : logs
  }

  /**
   * Get all logs
   */
  all(): LogEvent[] {
    return this.buffer.all()
  }

  /**
   * Get buffer statistics
   */
  stats(): {
    count: number
    capacity: number
    isFull: boolean
    sessionId: string
    sinks: string[]
  } {
    return {
      count: this.buffer.length(),
      capacity: this.buffer.getCapacity(),
      isFull: this.buffer.isFull(),
      sessionId: this.sessionId,
      sinks: Array.from(this.sinks.keys()),
    }
  }

  /**
   * Clear all logs (keeps sinks)
   */
  clear(): void {
    this.buffer.clear()
  }

  /**
   * Close all sinks and clear
   */
  async close(): Promise<void> {
    const closePromises: Promise<void>[] = []

    for (const sink of this.sinks.values()) {
      if (sink.close) {
        const result = sink.close()
        if (result instanceof Promise) {
          closePromises.push(result)
        }
      }
    }

    await Promise.all(closePromises)
    this.sinks.clear()
    this.buffer.clear()
  }

  private generateSessionId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
  }
}

/**
 * Global instance for dev server
 * Initialized once at server startup
 */
let globalLogStream: LogStream | null = null

export function getLogStream(): LogStream {
  if (!globalLogStream) {
    globalLogStream = new LogStream(1000)
  }
  return globalLogStream
}

export function initLogStream(capacity?: number): LogStream {
  globalLogStream = new LogStream(capacity || 1000)
  return globalLogStream
}

export function closeLogStream(): Promise<void> {
  if (globalLogStream) {
    const promise = globalLogStream.close()
    globalLogStream = null
    return promise
  }
  return Promise.resolve()
}
