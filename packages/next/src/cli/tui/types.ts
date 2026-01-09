import type { ChildProcess } from 'child_process'

export interface FetchMetricData {
  method: string
  url: string
  status: number
  totalTime: number
  cacheStatus?: string
  cacheReason?: string
  cacheWarning?: string
}

export interface TuiLogEntry {
  timestamp: number
  level: 'info' | 'warn' | 'error'
  message: string
  extraLines?: string[]
  structured?: Record<string, any>
  source?: 'system' | 'userland' | 'browser'
}

export interface CompilationState {
  loading: boolean
  trigger?: string
  errors?: string[]
  warnings?: string[]
}

export type LogFilter = 'all' | 'errors' | 'warnings' | 'requests' | 'console'

export interface TuiState {
  logs: TuiLogEntry[]
  serverUrl: string
  isReady: boolean
  logFilter: LogFilter
  compilationState: CompilationState
}

export type TuiIpcMessage =
  | { type: 'log'; payload: { level: string; message: string } }
  | { type: 'compilation'; payload: CompilationState }
  | { type: 'structured-log'; payload: Record<string, any> }

export interface TuiProps {
  child: ChildProcess
  serverUrl: string
  distDir: string
}
