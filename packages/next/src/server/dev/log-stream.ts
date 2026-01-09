/**
 * Structured logging for Next.js dev mode
 *
 * Simple architecture:
 * - Ring buffer for bounded memory
 * - Sinks for output (IPC to TUI, file for MCP)
 * - Single global instance
 */

// ============================================================================
// Types
// ============================================================================

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export type LogSource = 'system' | 'userland' | 'browser'

export interface LogEvent {
  ts: number
  sessionId: string
  level: LogLevel
  source: LogSource
  scope?: string
  message: string
  structured?: Record<string, any>
  location?: string
  stack?: string[]
}

export interface LogSink {
  name: string
  write(event: LogEvent): void | Promise<void>
  close?(): void | Promise<void>
}

// ============================================================================
// Ring Buffer
// ============================================================================

class RingBuffer<T> {
  private buffer: T[]
  private writeIndex = 0
  private size = 0
  private readonly capacity: number

  constructor(capacity: number) {
    this.capacity = capacity
    this.buffer = new Array(capacity)
  }

  push(item: T): void {
    this.buffer[this.writeIndex] = item
    this.writeIndex = (this.writeIndex + 1) % this.capacity
    if (this.size < this.capacity) this.size++
  }

  tail(n: number): T[] {
    const count = Math.min(n, this.size)
    if (count <= 0) return []

    const result: T[] = new Array(count)
    let readIndex =
      this.size < this.capacity
        ? Math.max(0, this.size - count)
        : (this.writeIndex - count + this.capacity) % this.capacity

    for (let i = 0; i < count; i++) {
      result[i] = this.buffer[readIndex]
      readIndex = (readIndex + 1) % this.capacity
    }
    return result
  }

  filter(predicate: (item: T) => boolean): T[] {
    return this.tail(this.size).filter(predicate)
  }

  length(): number {
    return this.size
  }

  getCapacity(): number {
    return this.capacity
  }

  clear(): void {
    this.writeIndex = 0
    this.size = 0
  }
}

// ============================================================================
// Sinks
// ============================================================================

/** Sends logs to parent process for TUI */
export class IPCSink implements LogSink {
  name = 'ipc'

  write(event: LogEvent): void {
    if (!process.send) return
    process.send({
      tuiMessage: {
        type: 'structured-log',
        payload: {
          ts: event.ts,
          level: event.level,
          source: event.source,
          scope: event.scope,
          message: event.message,
          structured: event.structured,
          location: event.location,
          stack: event.stack,
        },
      },
    })
  }
}

/** Writes logs to file for MCP */
export class FileSink implements LogSink {
  name = 'file'
  private stream: import('fs').WriteStream | null = null
  private queue: string[] = []
  private flushTimer: NodeJS.Timeout | null = null
  private batchSize: number

  constructor(
    logFilePath: string,
    opts?: { flushInterval?: number; batchSize?: number }
  ) {
    const fs = require('fs') as typeof import('fs')
    const path = require('path') as typeof import('path')

    this.batchSize = opts?.batchSize || 50

    fs.mkdirSync(path.dirname(logFilePath), { recursive: true })
    fs.writeFileSync(logFilePath, '')
    this.stream = fs.createWriteStream(logFilePath, { flags: 'a' })

    this.flushTimer = setInterval(
      () => this.flush(),
      opts?.flushInterval || 1000
    )
  }

  write(event: LogEvent): void {
    if (!this.stream) return
    const ts = new Date(event.ts).toISOString()
    const level = event.level.toUpperCase().padEnd(5)
    const scope = event.scope ? `[${event.scope}] ` : ''
    this.queue.push(`[${ts}] ${level} ${scope}${event.message}\n`)

    if (this.queue.length >= this.batchSize) this.flush()
  }

  private flush(): void {
    if (!this.stream || this.queue.length === 0) return
    this.stream.write(this.queue.join(''))
    this.queue = []
  }

  close(): void {
    if (this.flushTimer) clearInterval(this.flushTimer)
    this.flush()
    this.stream?.end()
    this.stream = null
  }
}

// ============================================================================
// LogStream
// ============================================================================

export class LogStream {
  private buffer: RingBuffer<LogEvent>
  private sinks: LogSink[] = []
  private sessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

  constructor(capacity = 1000) {
    this.buffer = new RingBuffer<LogEvent>(capacity)
  }

  emit(
    level: LogLevel,
    message: string,
    opts?: {
      source?: LogSource
      scope?: string
      structured?: Record<string, any>
      location?: string
      stack?: string[]
    }
  ): void {
    const event: LogEvent = {
      ts: Date.now(),
      sessionId: this.sessionId,
      level,
      source: opts?.source || 'system',
      scope: opts?.scope,
      message,
      structured: opts?.structured,
      location: opts?.location,
      stack: opts?.stack,
    }

    this.buffer.push(event)

    for (const sink of this.sinks) {
      try {
        sink.write(event)
      } catch {
        // Don't let sink errors break logging
      }
    }
  }

  info(msg: string, opts?: Parameters<LogStream['emit']>[2]): void {
    this.emit('info', msg, opts)
  }
  warn(msg: string, opts?: Parameters<LogStream['emit']>[2]): void {
    this.emit('warn', msg, opts)
  }
  error(msg: string, opts?: Parameters<LogStream['emit']>[2]): void {
    this.emit('error', msg, opts)
  }

  addSink(sink: LogSink): void {
    this.sinks.push(sink)
  }

  recent(n = 100): LogEvent[] {
    return this.buffer.tail(n)
  }

  since(timestamp: number, limit?: number): LogEvent[] {
    const logs = this.buffer.filter((e) => e.ts >= timestamp)
    return limit ? logs.slice(-limit) : logs
  }

  stats(): { count: number; capacity: number } {
    return {
      count: this.buffer.length(),
      capacity: this.buffer.getCapacity(),
    }
  }

  close(): void {
    for (const sink of this.sinks) sink.close?.()
    this.sinks = []
    this.buffer.clear()
  }
}

// ============================================================================
// Global Instance
// ============================================================================

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
