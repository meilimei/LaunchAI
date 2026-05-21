/**
 * Owned blog / CMS — stub manifest.
 *
 * Owned channel. Defaults to API mode (Ghost / Hashnode / dev.to / WP REST).
 * No login probe (auth is per-integration via API key, not browser cookies)
 * — keeping a placeholder probe so the type compiles uniformly.
 */
import type { PlatformManifest } from '../manifest'
import { DEFAULT_COOLDOWN_HOURS } from './common'

export const blogManifest: PlatformManifest = {
  id: 'blog',
  displayName: 'Owned Blog',
  baseUrl: 'https://example.com',
  loginUrl: 'https://example.com',

  audienceProfile: {
    summary:
      'Owned channel — the audience is whoever you can reach via search (SEO long-tail), email, or syndication. Excellent for niche professional buyers who Google specific problems. Compounds slowly but durably; nearly always worth it for B2B / professional-services / tools where buyers research before buying.',
    tags: [
      'seo',
      'long-tail-search',
      'owned-channel',
      'b2b',
      'professional-buyers',
      'evergreen',
      'compounds',
      'any-audience',
    ],
    notSuitableFor: [
      'time-sensitive-launch-buzz',
      'pure-consumer-impulse-buys',
    ],
  },

  loginProbe: {
    loggedInUrl: 'https://example.com',
    loggedOutUrlMarkers: [],
    loggedInTextMarkers: [],
  },

  capabilities: {
    canRead: true,
    canPost: true,
    canComment: false,
    canCollectMetrics: true,
    executionMode: 'api',
    requiresHumanFinalize: false,
    maxAutonomousRiskLevel: 1,
    dailyActionCap: 5,
  },

  defaultRiskByActionType: {},
  systemAddendum: '',
  actions: {},
  blockedHints: [],
  defaultCooldownHoursByReason: DEFAULT_COOLDOWN_HOURS,
  warmupRules: [],
}
