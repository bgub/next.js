/**
 * File sink - writes logs to disk (replaces the old file-logger)
 * Batched writes to avoid I/O thrashing
 */

import type { LogSink, LogEvent } from '../types'
import * as fs from 'fs'
import * as path from 'path'

export class FileSink implements LogSink {
  name = 'file'
  private stream: fs.WriteStream | null = null
  private queue: string[] = []
  private flushTimer: NodeJS.Timeout | null = null
  private readonly flushInterval: number
  private readonly batchSize: number

  constructor(
    logFilePath: string,
    options?: {
      flushInterval?: number // ms between flushes
      batchSize?: number // flush after N logs
    }
  ) {
    this.flushInterval = options?.flushInterval || 1000
    this.batchSize = options?.batchSize || 50

    // Ensure directory exists
    const dir = path.dirname(logFilePath)
    fs.mkdirSync(dir, { recursive: true })

    // Clear existing file
    fs.writeFileSync(logFilePath, '')

    // Open write stream
    this.stream = fs.createWriteStream(logFilePath, { flags: 'a' })

    // Start flush timer
    this.startFlushTimer()
  }

  write(event: LogEvent): void {
    if (!this.stream) return

    const timestamp = new Date(event.ts).toISOString()
    const sessionPrefix = `[${event.sessionId.slice(0, 8)}]`
    const levelStr = event.level.toUpperCase().padEnd(7)
    const scopeStr = event.scope ? `[${event.scope}]` : ''
    const logLine = `[${timestamp}] ${sessionPrefix} ${levelStr} ${scopeStr} ${event.message}\n`

    this.queue.push(logLine)

    // Flush if batch size reached
    if (this.queue.length >= this.batchSize) {
      this.flush()
    }
  }

  private flush(): void {
    if (!this.stream || this.queue.length === 0) return

    const batch = this.queue.join('')
    this.queue = []
    this.stream.write(batch)
  }

  private startFlushTimer(): void {
    this.flushTimer = setInterval(() => {
      this.flush()
    }, this.flushInterval)
  }

  async close(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer)
      this.flushTimer = null
    }

    // Final flush
    this.flush()

    if (this.stream) {
      return new Promise<void>((resolve) => {
        this.stream!.end(() => {
          this.stream = null
          resolve()
        })
      })
    }
  }
}
