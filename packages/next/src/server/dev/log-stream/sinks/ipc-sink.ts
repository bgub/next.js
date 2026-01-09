/**
 * IPC sink - sends logs to parent process (for TUI)
 * This replaces the scattered process.send() calls throughout the codebase
 */

import type { LogSink, LogEvent } from '../types'

export class IPCSink implements LogSink {
  name = 'ipc'

  write(event: LogEvent): void {
    if (!process.send) return

    // Send in format TUI expects (maintains compatibility)
    process.send({
      tuiMessage: {
        type: 'structured-log',
        payload: {
          ts: event.ts,
          level: event.level,
          source: event.source,
          message: event.message,
          structured: event.structured,
          location: event.location,
          stack: event.stack,
        },
      },
    })
  }
}
