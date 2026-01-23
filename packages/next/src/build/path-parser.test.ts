import {
  parsePath,
  isRoutablePath,
  isAppPath,
  isPagesPath,
  isApiRoute,
  isLayout,
  isIgnoredPath,
  getParamNames,
} from './path-parser'

const pageExtensions = ['tsx', 'ts', 'jsx', 'js']

describe('parsePath', () => {
  describe('basic normalization', () => {
    it('should normalize app page paths', () => {
      const parsed = parsePath('/app/blog/[slug]/page.tsx', { pageExtensions })

      expect(parsed.normalized).toBe('/blog/[slug]')
      expect(parsed.type).toBe('app-page')
      expect(parsed.directory).toBe('app')
    })

    it('should normalize app route handler paths', () => {
      const parsed = parsePath('/app/api/users/route.ts', { pageExtensions })

      expect(parsed.normalized).toBe('/api/users')
      expect(parsed.type).toBe('app-route')
      expect(parsed.directory).toBe('app')
    })

    it('should normalize app layout paths', () => {
      const parsed = parsePath('/app/dashboard/layout.tsx', { pageExtensions })

      expect(parsed.normalized).toBe('/dashboard')
      expect(parsed.type).toBe('app-layout')
    })

    it('should normalize pages directory paths', () => {
      const parsed = parsePath('/pages/blog/[slug].tsx', { pageExtensions })

      expect(parsed.normalized).toBe('/blog/[slug]')
      expect(parsed.type).toBe('pages-page')
      expect(parsed.directory).toBe('pages')
    })

    it('should normalize pages API routes', () => {
      const parsed = parsePath('/pages/api/users.ts', { pageExtensions })

      expect(parsed.normalized).toBe('/api/users')
      expect(parsed.type).toBe('pages-api')
    })

    it('should handle root index page', () => {
      const parsed = parsePath('/app/page.tsx', { pageExtensions })

      expect(parsed.normalized).toBe('/')
      expect(parsed.type).toBe('app-page')
    })

    it('should handle pages index', () => {
      const parsed = parsePath('/pages/index.tsx', { pageExtensions })

      expect(parsed.normalized).toBe('/')
      expect(parsed.type).toBe('pages-page')
    })
  })

  describe('route groups', () => {
    it('should remove route groups from normalized path', () => {
      const parsed = parsePath('/app/(marketing)/blog/page.tsx', {
        pageExtensions,
      })

      expect(parsed.normalized).toBe('/blog')
      expect(parsed.normalizedWithGroups).toBe('/(marketing)/blog')
    })

    it('should handle nested route groups', () => {
      const parsed = parsePath('/app/(marketing)/(features)/pricing/page.tsx', {
        pageExtensions,
      })

      expect(parsed.normalized).toBe('/pricing')
    })

    it('should handle root-level route group', () => {
      const parsed = parsePath('/app/(auth)/login/page.tsx', { pageExtensions })

      expect(parsed.normalized).toBe('/login')
    })
  })

  describe('parallel routes', () => {
    it('should detect parallel route slots', () => {
      const parsed = parsePath('/app/@modal/photo/[id]/page.tsx', {
        pageExtensions,
      })

      expect(parsed.slot).toEqual({
        name: 'modal',
        parent: '/',
      })
    })

    it('should detect nested parallel routes', () => {
      const parsed = parsePath('/app/dashboard/@sidebar/settings/page.tsx', {
        pageExtensions,
      })

      expect(parsed.slot).toEqual({
        name: 'sidebar',
        parent: '/dashboard',
      })
    })

    it('should remove parallel routes from normalized path', () => {
      const parsed = parsePath('/app/@modal/photo/page.tsx', { pageExtensions })

      expect(parsed.normalized).toBe('/photo')
    })
  })

  describe('dynamic segments', () => {
    it('should detect single dynamic segment', () => {
      const parsed = parsePath('/app/blog/[slug]/page.tsx', { pageExtensions })

      expect(parsed.isDynamic).toBe(true)
      expect(parsed.hasCatchAll).toBe(false)
      expect(parsed.hasOptionalCatchAll).toBe(false)
      expect(parsed.params()).toEqual({
        names: ['slug'],
        types: { slug: 'dynamic' },
      })
    })

    it('should detect multiple dynamic segments', () => {
      const parsed = parsePath('/app/[category]/[slug]/page.tsx', {
        pageExtensions,
      })

      expect(parsed.isDynamic).toBe(true)
      expect(parsed.params()).toEqual({
        names: ['category', 'slug'],
        types: { category: 'dynamic', slug: 'dynamic' },
      })
    })

    it('should detect catch-all segments', () => {
      const parsed = parsePath('/app/docs/[...slug]/page.tsx', {
        pageExtensions,
      })

      expect(parsed.isDynamic).toBe(true)
      expect(parsed.hasCatchAll).toBe(true)
      expect(parsed.hasOptionalCatchAll).toBe(false)
      expect(parsed.params()).toEqual({
        names: ['slug'],
        types: { slug: 'catch-all' },
      })
    })

    it('should detect optional catch-all segments', () => {
      const parsed = parsePath('/app/docs/[[...slug]]/page.tsx', {
        pageExtensions,
      })

      expect(parsed.isDynamic).toBe(true)
      expect(parsed.hasCatchAll).toBe(false)
      expect(parsed.hasOptionalCatchAll).toBe(true)
      expect(parsed.params()).toEqual({
        names: ['slug'],
        types: { slug: 'optional-catch-all' },
      })
    })

    it('should return empty params for static routes', () => {
      const parsed = parsePath('/app/about/page.tsx', { pageExtensions })

      expect(parsed.isDynamic).toBe(false)
      expect(parsed.params()).toEqual({
        names: [],
        types: {},
      })
    })
  })

  describe('interception routes', () => {
    it('should detect interception route with (.)', () => {
      const parsed = parsePath('/app/feed/(.)photo/[id]/page.tsx', {
        pageExtensions,
      })

      expect(parsed.isInterceptionRoute).toBe(true)
    })

    it('should detect interception route with (..)', () => {
      const parsed = parsePath('/app/feed/(..)photo/[id]/page.tsx', {
        pageExtensions,
      })

      expect(parsed.isInterceptionRoute).toBe(true)
    })

    it('should detect interception route with (...)', () => {
      const parsed = parsePath('/app/feed/(...)photo/[id]/page.tsx', {
        pageExtensions,
      })

      expect(parsed.isInterceptionRoute).toBe(true)
    })

    it('should not detect interception on regular routes', () => {
      const parsed = parsePath('/app/blog/page.tsx', { pageExtensions })

      expect(parsed.isInterceptionRoute).toBe(false)
    })
  })

  describe('segment parsing', () => {
    it('should parse static segments', () => {
      const parsed = parsePath('/app/blog/posts/page.tsx', { pageExtensions })

      // Segments include all parts including the leaf file name (page)
      const staticSegments = parsed.segments.filter((s) => s.type === 'static')
      expect(staticSegments).toHaveLength(3)
      expect(staticSegments[0].value).toBe('blog')
      expect(staticSegments[1].value).toBe('posts')
      expect(staticSegments[2].value).toBe('page')
    })

    it('should parse dynamic segments with param names', () => {
      const parsed = parsePath('/app/blog/[slug]/page.tsx', { pageExtensions })

      const dynamicSegments = parsed.segments.filter(
        (s) => s.type === 'dynamic'
      )
      expect(dynamicSegments).toHaveLength(1)
      expect(dynamicSegments[0].value).toBe('[slug]')
      expect(dynamicSegments[0].paramName).toBe('slug')
    })

    it('should parse group segments', () => {
      const parsed = parsePath('/app/(marketing)/blog/page.tsx', {
        pageExtensions,
      })

      const groupSegments = parsed.segments.filter((s) => s.type === 'group')
      expect(groupSegments).toHaveLength(1)
      expect(groupSegments[0].value).toBe('(marketing)')
    })

    it('should parse parallel route segments', () => {
      const parsed = parsePath('/app/@modal/photo/page.tsx', { pageExtensions })

      const parallelSegments = parsed.segments.filter(
        (s) => s.type === 'parallel'
      )
      expect(parallelSegments).toHaveLength(1)
      expect(parallelSegments[0].value).toBe('@modal')
      expect(parallelSegments[0].paramName).toBe('modal')
    })
  })

  describe('regex generation', () => {
    it('should generate regex for static routes', () => {
      const parsed = parsePath('/app/about/page.tsx', { pageExtensions })
      const { re } = parsed.regex()

      expect(re.test('/about')).toBe(true)
      expect(re.test('/about/')).toBe(true)
      expect(re.test('/other')).toBe(false)
    })

    it('should generate regex for dynamic routes', () => {
      const parsed = parsePath('/app/blog/[slug]/page.tsx', { pageExtensions })
      const { re } = parsed.regex()

      expect(re.test('/blog/hello-world')).toBe(true)
      expect(re.test('/blog/123')).toBe(true)
      expect(re.test('/blog')).toBe(false)
    })

    it('should cache regex on subsequent calls', () => {
      const parsed = parsePath('/app/blog/[slug]/page.tsx', { pageExtensions })

      const regex1 = parsed.regex()
      const regex2 = parsed.regex()

      expect(regex1).toBe(regex2) // Same reference (cached)
    })
  })

  describe('path types', () => {
    it('should identify app-page', () => {
      const parsed = parsePath('/app/blog/page.tsx', { pageExtensions })
      expect(parsed.type).toBe('app-page')
    })

    it('should identify app-route', () => {
      const parsed = parsePath('/app/api/route.ts', { pageExtensions })
      expect(parsed.type).toBe('app-route')
    })

    it('should identify app-layout', () => {
      const parsed = parsePath('/app/layout.tsx', { pageExtensions })
      expect(parsed.type).toBe('app-layout')
    })

    it('should identify app-default', () => {
      const parsed = parsePath('/app/@modal/default.tsx', { pageExtensions })
      expect(parsed.type).toBe('app-default')
    })

    it('should identify app-not-found', () => {
      const parsed = parsePath('/app/not-found.tsx', { pageExtensions })
      expect(parsed.type).toBe('app-not-found')
    })

    it('should identify app-error', () => {
      const parsed = parsePath('/app/error.tsx', { pageExtensions })
      expect(parsed.type).toBe('app-error')
    })

    it('should identify app-loading', () => {
      const parsed = parsePath('/app/loading.tsx', { pageExtensions })
      expect(parsed.type).toBe('app-loading')
    })

    it('should identify pages-page', () => {
      const parsed = parsePath('/pages/about.tsx', { pageExtensions })
      expect(parsed.type).toBe('pages-page')
    })

    it('should identify pages-api', () => {
      const parsed = parsePath('/pages/api/hello.ts', { pageExtensions })
      expect(parsed.type).toBe('pages-api')
    })
  })

  describe('absolute paths', () => {
    it('should handle absolute app directory paths', () => {
      const parsed = parsePath('/project/app/blog/page.tsx', {
        pageExtensions,
        appDir: '/project/app',
        isAbsolutePath: true,
      })

      expect(parsed.directory).toBe('app')
      expect(parsed.normalized).toBe('/blog')
    })

    it('should handle absolute pages directory paths', () => {
      const parsed = parsePath('/project/pages/blog.tsx', {
        pageExtensions,
        pagesDir: '/project/pages',
        isAbsolutePath: true,
      })

      expect(parsed.directory).toBe('pages')
      expect(parsed.normalized).toBe('/blog')
    })

    it('should handle absolute root directory paths', () => {
      const parsed = parsePath('/project/middleware.ts', {
        pageExtensions,
        rootDir: '/project',
        isAbsolutePath: true,
      })

      expect(parsed.directory).toBe('root')
    })
  })

  describe('alias paths', () => {
    it('should handle private-next-app-dir alias', () => {
      const parsed = parsePath('private-next-app-dir/blog/page.tsx', {
        pageExtensions,
      })

      expect(parsed.directory).toBe('app')
      expect(parsed.normalized).toBe('/blog')
    })

    it('should handle private-next-pages alias', () => {
      const parsed = parsePath('private-next-pages/blog.tsx', {
        pageExtensions,
      })

      expect(parsed.directory).toBe('pages')
      expect(parsed.normalized).toBe('/blog')
    })
  })
})

describe('utility functions', () => {
  describe('isRoutablePath', () => {
    it('should return true for app pages', () => {
      const parsed = parsePath('/app/blog/page.tsx', { pageExtensions })
      expect(isRoutablePath(parsed)).toBe(true)
    })

    it('should return true for app routes', () => {
      const parsed = parsePath('/app/api/route.ts', { pageExtensions })
      expect(isRoutablePath(parsed)).toBe(true)
    })

    it('should return true for pages', () => {
      const parsed = parsePath('/pages/blog.tsx', { pageExtensions })
      expect(isRoutablePath(parsed)).toBe(true)
    })

    it('should return false for layouts', () => {
      const parsed = parsePath('/app/layout.tsx', { pageExtensions })
      expect(isRoutablePath(parsed)).toBe(false)
    })
  })

  describe('isAppPath', () => {
    it('should return true for app directory paths', () => {
      const parsed = parsePath('/app/blog/page.tsx', { pageExtensions })
      expect(isAppPath(parsed)).toBe(true)
    })

    it('should return false for pages directory paths', () => {
      const parsed = parsePath('/pages/blog.tsx', { pageExtensions })
      expect(isAppPath(parsed)).toBe(false)
    })
  })

  describe('isPagesPath', () => {
    it('should return true for pages directory paths', () => {
      const parsed = parsePath('/pages/blog.tsx', { pageExtensions })
      expect(isPagesPath(parsed)).toBe(true)
    })

    it('should return false for app directory paths', () => {
      const parsed = parsePath('/app/blog/page.tsx', { pageExtensions })
      expect(isPagesPath(parsed)).toBe(false)
    })
  })

  describe('isApiRoute', () => {
    it('should return true for app route handlers', () => {
      const parsed = parsePath('/app/api/users/route.ts', { pageExtensions })
      expect(isApiRoute(parsed)).toBe(true)
    })

    it('should return true for pages API routes', () => {
      const parsed = parsePath('/pages/api/users.ts', { pageExtensions })
      expect(isApiRoute(parsed)).toBe(true)
    })

    it('should return false for pages', () => {
      const parsed = parsePath('/app/blog/page.tsx', { pageExtensions })
      expect(isApiRoute(parsed)).toBe(false)
    })
  })

  describe('isLayout', () => {
    it('should return true for layouts', () => {
      const parsed = parsePath('/app/layout.tsx', { pageExtensions })
      expect(isLayout(parsed)).toBe(true)
    })

    it('should return false for pages', () => {
      const parsed = parsePath('/app/page.tsx', { pageExtensions })
      expect(isLayout(parsed)).toBe(false)
    })
  })

  describe('isIgnoredPath', () => {
    it('should return true for paths with underscore prefix', () => {
      const parsed = parsePath('/app/_components/Button.tsx', {
        pageExtensions,
      })
      expect(isIgnoredPath(parsed)).toBe(true)
    })

    it('should return false for normal paths', () => {
      const parsed = parsePath('/app/blog/page.tsx', { pageExtensions })
      expect(isIgnoredPath(parsed)).toBe(false)
    })
  })

  describe('getParamNames', () => {
    it('should return param names', () => {
      const parsed = parsePath('/app/[category]/[slug]/page.tsx', {
        pageExtensions,
      })
      expect(getParamNames(parsed)).toEqual(['category', 'slug'])
    })

    it('should return empty array for static routes', () => {
      const parsed = parsePath('/app/about/page.tsx', { pageExtensions })
      expect(getParamNames(parsed)).toEqual([])
    })
  })
})
