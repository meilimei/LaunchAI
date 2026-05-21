/**
 * Product Hunt — stub manifest.
 *
 * The official Launch button is a one-shot, high-stakes click — even when
 * automated, the supervisor will require human approval before pressing it.
 */
import type { PlatformManifest } from '../manifest'
import { DEFAULT_COOLDOWN_HOURS } from './common'

const PH_ADDENDUM = [
  'Product Hunt launches are scheduled. Comments on others should be',
  'specific and helpful — generic encouragement gets downranked. The',
  'official Launch action requires explicit human confirmation regardless',
  'of capability flags.',
].join(' ')

export const productHuntManifest: PlatformManifest = {
  id: 'product_hunt',
  displayName: 'Product Hunt',
  baseUrl: 'https://www.producthunt.com',
  loginUrl: 'https://www.producthunt.com/sessions/new',

  audienceProfile: {
    summary:
      'Early adopters, makers, designers, PMs, startup-curious consumers, and tech press. Strong for one-day awareness spikes; weak for sustained niche-audience reach. Audience skews tech-forward and English-speaking.',
    tags: [
      'early-adopters',
      'makers',
      'designers',
      'product-managers',
      'startup-curious',
      'tech-press',
      'investors',
      'tech-savvy-consumers',
    ],
    notSuitableFor: [
      'regulated-professionals',
      'enterprise-procurement',
      'non-english-markets',
      'sustained-engagement',
    ],
  },

  loginProbe: {
    loggedInUrl: 'https://www.producthunt.com/my/upcoming',
    loggedOutUrlMarkers: ['/sessions/new'],
    loggedInTextMarkers: ['Upcoming', 'My Products', 'Notifications'],
  },

  capabilities: {
    canRead: true,
    canPost: true,
    canComment: true,
    canCollectMetrics: true,
    executionMode: 'browser_assisted',
    requiresHumanFinalize: true,
    maxAutonomousRiskLevel: 1,
    dailyActionCap: 4,
  },

  defaultRiskByActionType: {},
  systemAddendum: PH_ADDENDUM,
  actions: {},
  blockedHints: [],
  defaultCooldownHoursByReason: DEFAULT_COOLDOWN_HOURS,
  warmupRules: [],
}
