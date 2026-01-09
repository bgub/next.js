/**
 * Console sink - writes logs to stdout/stderr
 * This is the traditional behavior (can be disabled when TUI is active)
 */

import type { LogSink, LogEvent } from '../types'

export class ConsoleSink implements LogSink {
  name = 'console'
  private enabled: boolean

  constructor(enabled: boolean = true) {
    this.enabled = enabled
  }

  write(event: LogEvent): void {
    if (!this.enabled) return

    const timestamp = new Date(event.ts).toISOString()
    const prefix = `[${timestamp}] [${event.level.toUpperCase()}]`
    const message = event.scope
      ? `${prefix} [${event.scope}] ${event.message}`
      : `${prefix} ${event.message}`

    if (event.level === 'error') {
      console.error(message)
      if (event.stack) {
        event.stack.forEach((line) => console.error(`  ${line}`))
      }
    } else if (event.level === 'warn') {
      console.warn(message)
    } else {
      console.log(message)
    }
  }

  enable(): void {
    this.enabled = true
  }

  disable(): void {
    this.enabled = false
  }
}
