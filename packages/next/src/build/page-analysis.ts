import type { NextConfigComplete } from '../server/config-shared'
import type { MiddlewareManifest } from './webpack/plugins/middleware-plugin'
import type { Span } from '../trace'
import type { PageInfo, PageInfos } from './utils'
import type { PrerenderedRoute } from './static-paths/types'
import type { AppSegmentConfig } from './segment-config/app/app-segment-config'
import type {
  MappedPages,
  FunctionsConfigManifest,
  StaticWorker,
} from './build-context'

import path from 'path'
import { STATIC_STATUS_PAGE_GET_INITIAL_PROPS_ERROR } from '../lib/constants'
import {
  RSC_MODULE_TYPES,
  SERVER_DIRECTORY,
  MIDDLEWARE_MANIFEST,
  STATIC_STATUS_PAGES,
} from '../shared/lib/constants'
import { isReservedPage, isAppBuiltinPage } from './utils'
import { normalizePagePath } from '../shared/lib/page-path/normalize-page-path'
import { normalizePathSep } from '../shared/lib/page-path/normalize-path-sep'
import { isDynamicRoute } from '../shared/lib/router/utils'
import { isEdgeRuntime } from '../lib/is-edge-runtime'
import isError from '../lib/is-error'
import { getStaticInfoIncludingLayouts } from './get-static-info-including-layouts'
import { FallbackMode } from '../lib/fallback'
import * as ciEnvironment from '../server/ci-info'
import * as Log from './output/log'

export interface PageAnalysisOptions {
  staticCheckSpan: Span
  staticWorker: StaticWorker
  isCompileMode: boolean
  config: NextConfigComplete
  distDir: string
  dir: string
  hasCustomErrorPage: boolean
  hasUserPagesRoutes: boolean
  hasPages404: boolean
  pageKeys: { pages: string[]; app: string[] | undefined }
  mappedAppPages: MappedPages | undefined
  appPathRoutes: Record<string, string>
  pagesDir: string | undefined
  appDir: string | undefined
  pagesPaths: string[]
  buildId: string
  isAppCacheComponentsEnabled: boolean
  isAuthInterruptsEnabled: boolean
}

export interface PageAnalysisCounters {
  staticAppPagesCount: number
  serverAppPagesCount: number
  edgeRuntimeAppCount: number
  edgeRuntimePagesCount: number
}

export interface PageAnalysisResult {
  pageInfos: PageInfos
  ssgPages: Set<string>
  ssgStaticFallbackPages: Set<string>
  ssgBlockingFallbackPages: Set<string>
  staticPages: Set<string>
  invalidPages: Set<string>
  serverPropsPages: Set<string>
  additionalPaths: Map<string, PrerenderedRoute[]>
  staticPaths: Map<string, PrerenderedRoute[]>
  appNormalizedPaths: Map<string, string>
  fallbackModes: Map<string, FallbackMode>
  appDefaultConfigs: Map<string, AppSegmentConfig>
  functionsConfigManifest: FunctionsConfigManifest
  customAppGetInitialProps: boolean
  namedExports: ReadonlyArray<string>
  isNextImageImported: boolean | undefined
  hasNonStaticErrorPage: boolean | undefined
  counters: PageAnalysisCounters
}

export function errorFromUnsupportedSegmentConfig(): never {
  Log.error(
    `Invalid segment configuration export detected. This can cause unexpected behavior from the configs not being applied. You should see the relevant failures in the logs above. Please fix them to continue.`
  )
  process.exit(1)
}

export async function analyzePages(
  options: PageAnalysisOptions
): Promise<PageAnalysisResult> {
  const {
    staticCheckSpan,
    staticWorker,
    isCompileMode,
    config,
    distDir,
    dir,
    hasCustomErrorPage,
    hasUserPagesRoutes,
    hasPages404,
    pageKeys,
    mappedAppPages,
    appPathRoutes,
    pagesDir,
    appDir,
    pagesPaths,
    buildId,
    isAppCacheComponentsEnabled,
    isAuthInterruptsEnabled,
  } = options

  let staticAppPagesCount = 0
  let serverAppPagesCount = 0
  let edgeRuntimeAppCount = 0
  let edgeRuntimePagesCount = 0
  const ssgPages = new Set<string>()
  const ssgStaticFallbackPages = new Set<string>()
  const ssgBlockingFallbackPages = new Set<string>()
  const staticPages = new Set<string>()
  const invalidPages = new Set<string>()
  const serverPropsPages = new Set<string>()
  const additionalPaths = new Map<string, PrerenderedRoute[]>()
  const staticPaths = new Map<string, PrerenderedRoute[]>()
  const appNormalizedPaths = new Map<string, string>()
  const fallbackModes = new Map<string, FallbackMode>()
  const appDefaultConfigs = new Map<string, AppSegmentConfig>()
  const pageInfos: PageInfos = new Map<string, PageInfo>()

  const functionsConfigManifest: FunctionsConfigManifest = {
    version: 1,
    functions: {},
  }

  if (isCompileMode) {
    return {
      pageInfos,
      ssgPages,
      ssgStaticFallbackPages,
      ssgBlockingFallbackPages,
      staticPages,
      invalidPages,
      serverPropsPages,
      additionalPaths,
      staticPaths,
      appNormalizedPaths,
      fallbackModes,
      appDefaultConfigs,
      functionsConfigManifest,
      customAppGetInitialProps: false,
      namedExports: [],
      isNextImageImported: true,
      hasNonStaticErrorPage: hasUserPagesRoutes,
      counters: {
        staticAppPagesCount,
        serverAppPagesCount,
        edgeRuntimeAppCount,
        edgeRuntimePagesCount,
      },
    }
  }

  const { configFileName } = config
  const sriEnabled = Boolean(config.experimental.sri?.algorithm)

  const nonStaticErrorPageSpan = staticCheckSpan.traceChild(
    'check-static-error-page'
  )
  const errorPageHasCustomGetInitialProps = nonStaticErrorPageSpan.traceAsyncFn(
    async () =>
      hasCustomErrorPage &&
      (await staticWorker.hasCustomGetInitialProps({
        page: '/_error',
        distDir,
        checkingApp: false,
        sriEnabled,
      }))
  )

  const errorPageStaticResult = nonStaticErrorPageSpan.traceAsyncFn(
    async () =>
      hasCustomErrorPage &&
      staticWorker.isPageStatic({
        dir,
        page: '/_error',
        distDir,
        configFileName,
        cacheComponents: isAppCacheComponentsEnabled,
        authInterrupts: isAuthInterruptsEnabled,
        httpAgentOptions: config.httpAgentOptions,
        locales: config.i18n?.locales,
        defaultLocale: config.i18n?.defaultLocale,
        nextConfigOutput: config.output,
        pprConfig: config.experimental.ppr,
        cacheLifeProfiles: config.cacheLife,
        buildId,
        sriEnabled,
        cacheMaxMemorySize: config.cacheMaxMemorySize,
      })
  )

  const appPageToCheck = '/_app'

  const customAppGetInitialPropsPromise = hasUserPagesRoutes
    ? staticWorker.hasCustomGetInitialProps({
        page: appPageToCheck,
        distDir,
        checkingApp: true,
        sriEnabled,
      })
    : Promise.resolve(false)

  const namedExportsPromise = hasUserPagesRoutes
    ? staticWorker.getDefinedNamedExports({
        page: appPageToCheck,
        distDir,
        sriEnabled,
      })
    : Promise.resolve([])

  let isNextImageImported: boolean | undefined

  const middlewareManifest: MiddlewareManifest = require(
    path.join(distDir, SERVER_DIRECTORY, MIDDLEWARE_MANIFEST)
  )

  for (const key of Object.keys(middlewareManifest?.functions)) {
    if (key.startsWith('/api')) {
      edgeRuntimePagesCount++
    }
  }

  type WorkerResult = Awaited<ReturnType<StaticWorker['isPageStatic']>>

  /** Classify an app router page based on worker analysis results. */
  function classifyAppPage(
    page: string,
    originalAppPath: string,
    workerResult: WorkerResult,
    pageRuntime: string | undefined
  ) {
    appNormalizedPaths.set(originalAppPath, page)

    // TODO-APP: handle prerendering with edge
    if (isEdgeRuntime(pageRuntime)) {
      Log.warnOnce(
        `Using edge runtime on a page currently disables static generation for that page`
      )
      return {
        isSSG: false,
        isStatic: false,
        isRoutePPREnabled: false,
        ssgPageRoutes: null as string[] | null,
      }
    }

    let isSSG = false
    let isStatic = false
    let isRoutePPREnabled = false
    let ssgPageRoutes: string[] | null = null
    const isDynamic = isDynamicRoute(page)

    if (typeof workerResult.isRoutePPREnabled === 'boolean') {
      isRoutePPREnabled = workerResult.isRoutePPREnabled
    }

    // If this route can be partially pre-rendered, then
    // mark it as such and mark that it can be
    // generated server-side.
    if (workerResult.isRoutePPREnabled) {
      isSSG = true
      isStatic = true
      staticPaths.set(originalAppPath, [])
    }

    if (workerResult.prerenderedRoutes) {
      staticPaths.set(originalAppPath, workerResult.prerenderedRoutes)
      ssgPageRoutes = workerResult.prerenderedRoutes.map(
        (route) => route.pathname
      )
      isSSG = true
    }

    const appConfig = workerResult.appConfig || {}
    if (appConfig.revalidate !== 0) {
      const hasGenerateStaticParams =
        workerResult.prerenderedRoutes &&
        workerResult.prerenderedRoutes.length > 0

      if (config.output === 'export' && isDynamic && !hasGenerateStaticParams) {
        throw new Error(
          `Page "${page}" is missing "generateStaticParams()" so it cannot be used with "output: export" config.`
        )
      }

      // Mark the app as static if:
      // - It has no dynamic param
      // - It doesn't have generateStaticParams but `dynamic` is set to
      //   `error` or `force-static`
      if (!isDynamic) {
        staticPaths.set(originalAppPath, [
          {
            params: {},
            pathname: page,
            encodedPathname: page,
            fallbackRouteParams: [],
            fallbackMode: workerResult.prerenderFallbackMode,
            fallbackRootParams: [],
            throwOnEmptyStaticShell: true,
          },
        ])
        isStatic = true
      } else if (
        !hasGenerateStaticParams &&
        (appConfig.dynamic === 'error' || appConfig.dynamic === 'force-static')
      ) {
        staticPaths.set(originalAppPath, [])
        isStatic = true
        isRoutePPREnabled = false
      }
    }

    if (workerResult.prerenderFallbackMode) {
      fallbackModes.set(originalAppPath, workerResult.prerenderFallbackMode)
    }

    appDefaultConfigs.set(originalAppPath, appConfig)

    return { isSSG, isStatic, isRoutePPREnabled, ssgPageRoutes }
  }

  /** Classify a pages router page based on worker analysis results. */
  async function classifyPagesPage(
    page: string,
    workerResult: WorkerResult,
    isServerComponent: boolean,
    pageRuntime: string | undefined
  ) {
    if (isEdgeRuntime(pageRuntime)) {
      if (workerResult.hasStaticProps) {
        console.warn(
          `"getStaticProps" is not yet supported fully with "experimental-edge", detected on ${page}`
        )
      }
      workerResult.isStatic = false
      workerResult.hasStaticProps = false
    }

    if (workerResult.isNextImageImported) {
      isNextImageImported = true
    }

    let isSSG = false
    let isStatic = false
    let ssgPageRoutes: string[] | null = null

    if (workerResult.hasStaticProps) {
      ssgPages.add(page)
      isSSG = true

      if (
        workerResult.prerenderedRoutes &&
        workerResult.prerenderedRoutes.length > 0
      ) {
        additionalPaths.set(page, workerResult.prerenderedRoutes)
        ssgPageRoutes = workerResult.prerenderedRoutes.map(
          (route) => route.pathname
        )
      }

      if (
        workerResult.prerenderFallbackMode ===
        FallbackMode.BLOCKING_STATIC_RENDER
      ) {
        ssgBlockingFallbackPages.add(page)
      } else if (
        workerResult.prerenderFallbackMode === FallbackMode.PRERENDER
      ) {
        ssgStaticFallbackPages.add(page)
      }
    } else if (workerResult.hasServerProps) {
      serverPropsPages.add(page)
    } else if (
      workerResult.isStatic &&
      !isServerComponent &&
      (await customAppGetInitialPropsPromise) === false
    ) {
      staticPages.add(page)
      isStatic = true
    } else if (isServerComponent) {
      // This is a static server component page that doesn't have
      // gSP or gSSP. We still treat it as a SSG page.
      ssgPages.add(page)
      isSSG = true
    }

    if (hasPages404 && page === '/404') {
      if (!workerResult.isStatic && !workerResult.hasStaticProps) {
        throw new Error(
          `\`pages/404\` ${STATIC_STATUS_PAGE_GET_INITIAL_PROPS_ERROR}`
        )
      }
      // we need to ensure the 404 lambda is present since we use
      // it when _app has getInitialProps
      if (
        (await customAppGetInitialPropsPromise) &&
        !workerResult.hasStaticProps
      ) {
        staticPages.delete(page)
      }
    }

    if (
      STATIC_STATUS_PAGES.includes(page) &&
      !workerResult.isStatic &&
      !workerResult.hasStaticProps
    ) {
      throw new Error(
        `\`pages${page}\` ${STATIC_STATUS_PAGE_GET_INITIAL_PROPS_ERROR}`
      )
    }

    return { isSSG, isStatic, ssgPageRoutes }
  }

  await Promise.all(
    Object.entries(pageKeys).flatMap(([key, files]) => {
      if (!files) return []
      const pageType = key as keyof typeof pageKeys

      return files.map((page) => {
        const checkPageSpan = staticCheckSpan.traceChild('check-page', {
          page,
        })
        return checkPageSpan.traceAsyncFn(async () => {
          const actualPage = normalizePagePath(page)
          let pagePath = ''

          if (pageType === 'pages') {
            pagePath =
              pagesPaths.find((p) => {
                p = normalizePathSep(p)
                return (
                  p.startsWith(actualPage + '.') ||
                  p.startsWith(actualPage + '/index.')
                )
              }) || ''
          }

          let originalAppPath: string | undefined
          if (pageType === 'app' && mappedAppPages) {
            for (const [originalPath, normalizedPath] of Object.entries(
              appPathRoutes
            )) {
              if (normalizedPath === page) {
                pagePath = mappedAppPages[originalPath].replace(
                  /^private-next-app-dir/,
                  ''
                )
                originalAppPath = originalPath
                break
              }
            }
          }

          const pageFilePath = isAppBuiltinPage(pagePath)
            ? pagePath
            : path.join(
                (pageType === 'pages' ? pagesDir : appDir) || '',
                pagePath
              )

          const isInsideAppDir = pageType === 'app'
          const staticInfo = pagePath
            ? await getStaticInfoIncludingLayouts({
                isInsideAppDir,
                pageFilePath,
                pageExtensions: config.pageExtensions,
                appDir,
                config,
                isDev: false,
                // If this route is an App Router page route, inherit the
                // route segment configs (e.g. `runtime`) from the layout by
                // passing the `originalAppPath`, which should end with `/page`.
                page: isInsideAppDir ? originalAppPath! : page,
              })
            : undefined

          if (staticInfo?.hadUnsupportedValue) {
            errorFromUnsupportedSegmentConfig()
          }

          // If there's anything that would contribute to the functions
          // configuration, we need to add it to the manifest.
          if (
            typeof staticInfo?.runtime !== 'undefined' ||
            typeof staticInfo?.maxDuration !== 'undefined' ||
            typeof staticInfo?.preferredRegion !== 'undefined'
          ) {
            const regions = staticInfo?.preferredRegion
              ? typeof staticInfo.preferredRegion === 'string'
                ? [staticInfo.preferredRegion]
                : staticInfo.preferredRegion
              : undefined

            functionsConfigManifest.functions[page] = {
              maxDuration: staticInfo?.maxDuration,
              ...(regions && { regions }),
            }
          }

          const pageRuntime = middlewareManifest.functions[
            originalAppPath || page
          ]
            ? 'edge'
            : staticInfo?.runtime

          const isServerComponent =
            pageType === 'app' && staticInfo?.rsc !== RSC_MODULE_TYPES.client

          let isSSG = false
          let isStatic = false
          let isRoutePPREnabled = false
          let ssgPageRoutes: string[] | null = null

          if (pageType === 'app' || !isReservedPage(page)) {
            try {
              let edgeInfo: any
              if (isEdgeRuntime(pageRuntime)) {
                if (pageType === 'app') {
                  edgeRuntimeAppCount++
                } else {
                  edgeRuntimePagesCount++
                }
                const manifestKey =
                  pageType === 'pages' ? page : originalAppPath || ''
                edgeInfo = middlewareManifest.functions[manifestKey]
              }

              const isPageStaticSpan =
                checkPageSpan.traceChild('is-page-static')
              const workerResult = await isPageStaticSpan.traceAsyncFn(() =>
                staticWorker.isPageStatic({
                  dir,
                  page,
                  originalAppPath,
                  distDir,
                  configFileName,
                  httpAgentOptions: config.httpAgentOptions,
                  locales: config.i18n?.locales,
                  defaultLocale: config.i18n?.defaultLocale,
                  parentId: isPageStaticSpan.getId(),
                  pageRuntime,
                  edgeInfo,
                  pageType,
                  cacheComponents: isAppCacheComponentsEnabled,
                  authInterrupts: isAuthInterruptsEnabled,
                  cacheHandler: config.cacheHandler,
                  cacheHandlers: config.cacheHandlers,
                  isrFlushToDisk: ciEnvironment.hasNextSupport
                    ? false
                    : config.experimental.isrFlushToDisk,
                  cacheMaxMemorySize: config.cacheMaxMemorySize,
                  nextConfigOutput: config.output,
                  pprConfig: config.experimental.ppr,
                  cacheLifeProfiles: config.cacheLife,
                  buildId,
                  sriEnabled,
                })
              )

              if (pageType === 'app' && originalAppPath) {
                ;({ isSSG, isStatic, isRoutePPREnabled, ssgPageRoutes } =
                  classifyAppPage(
                    page,
                    originalAppPath,
                    workerResult,
                    pageRuntime
                  ))
              } else {
                ;({ isSSG, isStatic, ssgPageRoutes } = await classifyPagesPage(
                  page,
                  workerResult,
                  isServerComponent,
                  pageRuntime
                ))
              }
            } catch (err) {
              if (!isError(err) || err.message !== 'INVALID_DEFAULT_EXPORT')
                throw err
              invalidPages.add(page)
            }
          }

          if (pageType === 'app') {
            if (isSSG || isStatic) {
              staticAppPagesCount++
            } else {
              serverAppPagesCount++
            }
          }

          pageInfos.set(page, {
            originalAppPath,
            isStatic,
            isSSG,
            isRoutePPREnabled,
            ssgPageRoutes,
            initialCacheControl: undefined,
            runtime: pageRuntime,
            pageDuration: undefined,
            ssgPageDurations: undefined,
            hasEmptyStaticShell: undefined,
          })
        })
      })
    })
  )

  const errorPageResult = await errorPageStaticResult
  const nonStaticErrorPage =
    (await errorPageHasCustomGetInitialProps) ||
    (errorPageResult && errorPageResult.hasServerProps)

  return {
    pageInfos,
    ssgPages,
    ssgStaticFallbackPages,
    ssgBlockingFallbackPages,
    staticPages,
    invalidPages,
    serverPropsPages,
    additionalPaths,
    staticPaths,
    appNormalizedPaths,
    fallbackModes,
    appDefaultConfigs,
    functionsConfigManifest,
    customAppGetInitialProps: await customAppGetInitialPropsPromise,
    namedExports: await namedExportsPromise,
    isNextImageImported,
    hasNonStaticErrorPage: nonStaticErrorPage,
    counters: {
      staticAppPagesCount,
      serverAppPagesCount,
      edgeRuntimeAppCount,
      edgeRuntimePagesCount,
    },
  }
}
