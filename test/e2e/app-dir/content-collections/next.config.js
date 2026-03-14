/**
 * @type {import('next').NextConfig}
 */
const { glob } = require('next/content')

function parseFrontmatter(raw) {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!match) return { body: raw }

  const frontmatter = {}
  for (const line of match[1].split('\n')) {
    const colonIdx = line.indexOf(':')
    if (colonIdx === -1) continue
    const key = line.slice(0, colonIdx).trim()
    const val = line.slice(colonIdx + 1).trim()
    if (!key) continue
    frontmatter[key] = val.replace(/^['"]|['"]$/g, '')
  }
  return { ...frontmatter, body: match[2].trim() }
}

const nextConfig = {
  contentCollections: {
    posts: {
      loader: glob({
        pattern: '*.md',
        base: 'content/posts',
        parse: (raw) => parseFrontmatter(raw),
      }),
      computed: (entry) => ({
        readingTime: Math.ceil(entry.body.split(/\s+/).length / 200),
      }),
    },
    products: {
      loader: {
        load: async ({ store }) => {
          store.set({ id: 'widget', data: { name: 'Widget', price: 9.99 } })
          store.set({
            id: 'gadget',
            data: { name: 'Gadget', price: 19.99 },
          })
        },
      },
    },
  },
}

module.exports = nextConfig
