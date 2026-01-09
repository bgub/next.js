/**
 * Public API for Next.js structured logging
 */

export {
  LogStream,
  getLogStream,
  initLogStream,
  closeLogStream,
} from './log-stream'
export { RingBuffer } from './ring-buffer'
export { ConsoleSink } from './sinks/console-sink'
export { FileSink } from './sinks/file-sink'
export { IPCSink } from './sinks/ipc-sink'

export type {
  LogEvent,
  LogSink,
  LogFilter,
  LogLevel,
  LogSource,
  LogScope,
  StructuredData,
} from './types'
