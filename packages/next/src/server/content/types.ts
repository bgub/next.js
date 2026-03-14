/**
 * Minimal inline interface matching the Standard Schema v1 spec.
 * Compatible with Zod v3.24+, Valibot v1+, ArkType v2.1+.
 * No npm dependency required.
 * @see https://standardschema.dev/
 */
export interface StandardSchemaV1<Output = unknown> {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    readonly validate: (
      value: unknown
    ) => { value: Output } | { issues: readonly { message: string }[] }
  }
}

export interface StoreEntry {
  id: string
  data: Record<string, any>
}

export interface LoaderContext {
  store: {
    set(entry: StoreEntry): void
  }
  collection: string
}

export interface ContentLoader {
  load: (ctx: LoaderContext) => Promise<void> | void
  watchPaths?: string[]
}

export interface CollectionDefinition {
  loader: ContentLoader
  schema?: StandardSchemaV1
  computed?: (entry: Record<string, any>) => Record<string, any>
}

export interface ContentEntry {
  _meta: {
    id: string
    collection: string
  }
  [key: string]: any
}
