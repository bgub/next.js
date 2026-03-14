import fs from 'fs/promises'
import path from 'path'
import picomatch from 'next/dist/compiled/picomatch'

import type { ContentLoader } from './types'

interface GlobOptions {
  pattern: string
  base: string
  parse: (raw: string, filePath: string) => Record<string, any>
}

export function glob(options: GlobOptions): ContentLoader {
  const { pattern, base, parse } = options
  return {
    watchPaths: [base],
    load: async (ctx) => {
      const projectDir = process.env.__NEXT_PRIVATE_CONTENT_DIR || process.cwd()
      const contentDir = path.resolve(projectDir, base)
      const dirEntries = await fs.readdir(contentDir, {
        recursive: true,
        withFileTypes: true,
      })

      const isMatch = picomatch(pattern)

      await Promise.all(
        dirEntries.map(async (entry) => {
          if (!entry.isFile()) return
          // parentPath was added in Node 20.12/18.20; older 18.x has `path`
          const dir = entry.parentPath ?? (entry as any).path
          const relFile = path.relative(contentDir, path.join(dir, entry.name))
          if (!isMatch(relFile)) return

          const raw = await fs.readFile(path.join(contentDir, relFile), 'utf-8')
          const ext = path.extname(relFile)

          ctx.store.set({
            id: relFile.slice(0, -ext.length),
            data: {
              ...parse(raw, relFile),
              _file: relFile,
            },
          })
        })
      )
    },
  }
}
