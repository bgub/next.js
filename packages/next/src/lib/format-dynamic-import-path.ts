import path from 'path'
import { pathToFileURL } from 'url'

/**
 * The path for a dynamic route must be URLs with a valid scheme.
 *
 * When an absolute Windows path is passed to it, it interprets the beginning of the path as a protocol (`C:`).
 * Therefore, it is important to always construct a complete path.
 * @param absoluteFilePath Absolute path
 */
export const formatDynamicImportPath = (absoluteFilePath: string) => {
  if (!path.isAbsolute(absoluteFilePath)) {
    throw new Error('filePath must be absolute.')
  }

  return pathToFileURL(absoluteFilePath).toString()
}
