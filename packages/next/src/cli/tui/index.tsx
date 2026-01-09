import type { ChildProcess } from 'child_process'
import { exec } from 'child_process'
import React, { useState, useEffect, useCallback } from 'react'
import { render, Box, Text, useApp, useInput, useStdout } from 'ink'
import type {
  TuiState,
  TuiIpcMessage,
  TuiLogEntry,
  TuiProps,
  LogFilter,
} from './types'
import { LogPanel } from './components/LogPanel'
import { CompilationStatus } from './components/CompilationStatus'

export interface TuiInstance {
  unmount: () => void
  waitUntilExit: () => Promise<void>
}

const MAX_LOGS = 500

export function startTui(
  child: ChildProcess,
  serverUrl: string,
  _distDir: string
): TuiInstance {
  function TuiApp({ child: childProcess, serverUrl: url }: TuiProps) {
    const { exit } = useApp()
    const { stdout } = useStdout()
    const [selectedIndex, setSelectedIndex] = useState(0)
    const [autoFollow, setAutoFollow] = useState(true)
    const [startupInfo, setStartupInfo] = useState<{
      version?: string
      turbopack?: boolean
      readyTime?: string
    }>({})
    const [state, setState] = useState<TuiState>({
      logs: [],
      serverUrl: url,
      isReady: true,
      logFilter: 'all',
      compilationState: { loading: false },
    })

    const addLog = useCallback(
      (level: TuiLogEntry['level'], message: string, structured?: any) => {
        // Parse startup info
        const versionMatch = message.match(/Next\.js\s+([\d.]+(?:-[\w.]+)?)/)
        if (versionMatch) {
          setStartupInfo((prev) => ({
            ...prev,
            version: versionMatch[1],
            turbopack: message.includes('Turbopack'),
          }))
        }
        const readyMatch = message.match(/Ready\s+in\s+(\S+)/)
        if (readyMatch) {
          setStartupInfo((prev) => ({ ...prev, readyTime: readyMatch[1] }))
        }

        setState((prev) => {
          // Determine source
          let source: TuiLogEntry['source'] = 'system'
          if (structured?.type === 'console') {
            source = structured.source === 'browser' ? 'browser' : 'userland'
          }

          const entry: TuiLogEntry = {
            timestamp: Date.now(),
            level,
            message,
            structured,
            source,
          }

          return {
            ...prev,
            logs: [...prev.logs.slice(-(MAX_LOGS - 1)), entry],
          }
        })
      },
      []
    )

    // Handle IPC messages from child
    useEffect(() => {
      const handleMessage = (msg: any) => {
        if (!msg?.tuiMessage) return

        const tuiMsg = msg.tuiMessage as TuiIpcMessage

        if (tuiMsg.type === 'compilation') {
          setState((prev) => ({ ...prev, compilationState: tuiMsg.payload }))
        } else if (tuiMsg.type === 'structured-log') {
          const p = tuiMsg.payload as any
          const level =
            p.level === 'error' || p.type === 'error'
              ? 'error'
              : p.level === 'warn' || p.type === 'warning'
                ? 'warn'
                : 'info'

          let message = p.message || ''
          if (p.type === 'request') {
            message = `${p.method} ${p.url} ${p.status} in ${p.totalTime}ms`
          }

          addLog(level, message, p.structured || p)
        }
      }

      childProcess.on('message', handleMessage)
      return () => {
        childProcess.off('message', handleMessage)
      }
    }, [childProcess, addLog])

    // Capture stdout/stderr
    useEffect(() => {
      const onStdout = (data: Buffer) => {
        const text = data.toString().trim()
        if (text) addLog('info', text)
      }
      const onStderr = (data: Buffer) => {
        const text = data.toString().trim()
        if (text) addLog('error', text)
      }

      childProcess.stdout?.on('data', onStdout)
      childProcess.stderr?.on('data', onStderr)
      return () => {
        childProcess.stdout?.off('data', onStdout)
        childProcess.stderr?.off('data', onStderr)
      }
    }, [childProcess, addLog])

    // Filter logs for display
    const filteredLogs = state.logs
      .filter((log) => {
        // Skip startup noise
        const msg = log.message
        if (
          msg.includes('Next.js') ||
          msg.includes('Local:') ||
          msg.includes('Network:') ||
          msg.match(/Ready\s+in/)
        )
          return false

        if (state.logFilter === 'all') return true
        if (state.logFilter === 'console')
          return log.source === 'userland' || log.source === 'browser'
        if (state.logFilter === 'errors') return log.level === 'error'
        if (state.logFilter === 'warnings')
          return log.level === 'warn' || log.level === 'error'
        if (state.logFilter === 'requests')
          return log.structured?.type === 'request'
        return true
      })
      .slice(-50)

    // Auto-follow
    useEffect(() => {
      if (autoFollow && filteredLogs.length > 0) {
        setSelectedIndex(filteredLogs.length - 1)
      }
    }, [filteredLogs.length, autoFollow])

    // Keyboard shortcuts
    useInput((input, key) => {
      if (input === 'q' || (key.ctrl && input === 'c')) {
        exit()
        return
      }

      if (key.upArrow) {
        setAutoFollow(false)
        setSelectedIndex((prev) => Math.max(0, prev - 1))
        return
      }

      if (key.downArrow) {
        setSelectedIndex((prev) => {
          const newIndex = Math.min(filteredLogs.length - 1, prev + 1)
          if (newIndex === filteredLogs.length - 1) setAutoFollow(true)
          return newIndex
        })
        return
      }

      // Filter shortcuts
      const filterMap: Record<string, LogFilter> = {
        a: 'all',
        e: 'errors',
        w: 'warnings',
        r: 'requests',
        l: 'console',
      }
      if (filterMap[input]) {
        setState((prev) => ({ ...prev, logFilter: filterMap[input] }))
        setAutoFollow(true)
      }

      // Copy
      if (input === 'c') {
        const log = filteredLogs[selectedIndex]
        if (log) {
          const cmd =
            process.platform === 'darwin'
              ? 'pbcopy'
              : process.platform === 'win32'
                ? 'clip'
                : 'xclip -selection clipboard'
          const cp = exec(cmd)
          cp.stdin?.write(log.message)
          cp.stdin?.end()
        }
      }

      if (input === 'f') {
        setAutoFollow(true)
        setSelectedIndex(filteredLogs.length - 1)
      }
    })

    return (
      <Box flexDirection="column" height="100%">
        <Box paddingX={1} gap={1}>
          <Text bold color="white">
            ▲ Next.js
          </Text>
          {startupInfo.version && <Text dimColor>{startupInfo.version}</Text>}
          {startupInfo.turbopack && <Text color="cyan">Turbopack</Text>}
          <Text dimColor>|</Text>
          <Text color="cyan">{state.serverUrl}</Text>
          <Box flexGrow={1} />
          <CompilationStatus
            compilationState={state.compilationState}
            isReady={state.isReady}
            readyTime={startupInfo.readyTime}
          />
        </Box>
        <LogPanel
          logs={filteredLogs}
          logFilter={state.logFilter}
          selectedIndex={selectedIndex}
          terminalWidth={stdout?.columns || 80}
          compilationState={state.compilationState}
        />
      </Box>
    )
  }

  process.stdout.write('\x1B[2J\x1B[H')

  const { unmount, waitUntilExit } = render(
    <TuiApp child={child} serverUrl={serverUrl} distDir={_distDir} />
  )

  return { unmount, waitUntilExit }
}
