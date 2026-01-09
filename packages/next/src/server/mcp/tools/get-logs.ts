/**
 * MCP tool for querying structured Next.js development logs.
 */
import type { McpServer } from 'next/dist/compiled/@modelcontextprotocol/sdk/server/mcp'
import { mcpTelemetryTracker } from '../mcp-telemetry-tracker'
import { getLogStream } from '../../dev/log-stream'

export function registerGetLogsTool(server: McpServer, _distDir: string) {
  server.registerTool(
    'get_logs',
    {
      description:
        'Query structured Next.js development logs. Supports filtering by level, source, scope, and time range.',
      inputSchema: {},
    },
    async (args: any) => {
      mcpTelemetryTracker.recordToolCall('mcp/get_logs')

      try {
        const logStream = getLogStream()
        const limit = args.limit || 100

        let logs = args.since
          ? logStream.since(args.since, limit)
          : logStream.recent(limit)

        // Apply filters
        if (args.level) {
          logs = logs.filter((log) => log.level === args.level)
        }
        if (args.source) {
          logs = logs.filter((log) => log.source === args.source)
        }
        if (args.scope) {
          logs = logs.filter((log) => log.scope === args.scope)
        }

        const formattedLogs = logs.map((log) => {
          const timestamp = new Date(log.ts).toISOString()
          const parts = [
            `[${timestamp}]`,
            `[${log.level.toUpperCase()}]`,
            log.scope ? `[${log.scope}]` : '',
            log.message,
          ]
          return parts.filter(Boolean).join(' ')
        })

        const stats = logStream.stats()
        const summary = `Showing ${formattedLogs.length} logs (buffer: ${stats.count}/${stats.capacity})\n\n`

        return {
          content: [
            {
              type: 'text',
              text: summary + formattedLogs.join('\n'),
            },
          ],
        }
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error querying logs: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        }
      }
    }
  )
}
