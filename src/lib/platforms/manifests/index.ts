/**
 * Manifest registry — single source of truth for every supported platform.
 *
 * Adding a new platform:
 *   1. Create `<id>.manifest.ts` exporting a `PlatformManifest` constant.
 *   2. Add the platform id to `PlatformId` in ../types.ts.
 *   3. Register it in PLATFORM_MANIFESTS below.
 *   4. Done — registry, probes, and warmup planner all pick it up.
 */
import type { PlatformId } from '../types'
import type { PlatformManifest } from '../manifest'

import { indieHackersManifest } from './indie-hackers.manifest'
import { redditManifest } from './reddit.manifest'
import { xManifest } from './x.manifest'
import { productHuntManifest } from './product-hunt.manifest'
import { hackerNewsManifest } from './hacker-news.manifest'
import { cwsManifest } from './cws.manifest'
import { blogManifest } from './blog.manifest'

export const PLATFORM_MANIFESTS: Record<PlatformId, PlatformManifest> = {
  indie_hackers: indieHackersManifest,
  reddit: redditManifest,
  x: xManifest,
  product_hunt: productHuntManifest,
  hacker_news: hackerNewsManifest,
  cws: cwsManifest,
  blog: blogManifest,
}

export function getManifest(platform: PlatformId): PlatformManifest {
  const m = PLATFORM_MANIFESTS[platform]
  if (!m) throw new Error(`No manifest registered for platform "${platform}"`)
  return m
}

export function listManifests(): PlatformManifest[] {
  return Object.values(PLATFORM_MANIFESTS)
}
