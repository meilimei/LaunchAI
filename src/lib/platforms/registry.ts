/**
 * Platform adapter registry — manifest-driven.
 *
 * Every platform is described by a `PlatformManifest` in
 * `src/lib/platforms/manifests/`. The registry wraps each manifest in a
 * single `ManifestBrowserAdapter` instance, giving the rest of the system
 * a uniform `PlatformAdapter` surface.
 *
 * Adding a new platform = create a manifest + register it in
 * `manifests/index.ts`. No new adapter class.
 *
 * See docs/PLATFORM_EXTENSIBILITY.md for the layered architecture.
 */
import type { PlatformAdapter, PlatformId } from './types'
import { ManifestBrowserAdapter } from './adapters/manifest-adapter'
import { PLATFORM_MANIFESTS } from './manifests'

const adapters: Record<PlatformId, PlatformAdapter> = (() => {
  const out = {} as Record<PlatformId, PlatformAdapter>
  for (const id of Object.keys(PLATFORM_MANIFESTS) as PlatformId[]) {
    out[id] = new ManifestBrowserAdapter(PLATFORM_MANIFESTS[id])
  }
  return out
})()

export function getPlatformAdapter(platform: PlatformId): PlatformAdapter {
  const adapter = adapters[platform]
  if (!adapter) throw new Error(`Unknown platform adapter: ${platform}`)
  return adapter
}

export function listPlatformAdapters(): PlatformAdapter[] {
  return Object.values(adapters)
}
