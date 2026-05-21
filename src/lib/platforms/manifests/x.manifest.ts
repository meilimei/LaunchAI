/**
 * X (Twitter) — stub manifest.
 */
import type { PlatformManifest } from '../manifest'
import { DEFAULT_COOLDOWN_HOURS } from './common'

const X_ADDENDUM = [
  'X favors concise, high-signal posts. No hashtag spam, no thread-bait.',
  'Replies should add a concrete observation or question, not just emojis.',
].join(' ')

export const xManifest: PlatformManifest = {
  id: 'x',
  displayName: 'X (Twitter)',
  baseUrl: 'https://x.com',
  loginUrl: 'https://x.com/i/flow/login',

  audienceProfile: {
    summary:
      'Public-facing professionals, journalists, founders, marketers, developers, politically-engaged consumers. Heavily algorithmic — reach depends on building a follow graph in your niche before you post. Low-context platform; long-form rarely lands.',
    tags: [
      'tech-twitter',
      'journalists',
      'founders',
      'marketers',
      'developers',
      'creators',
      'public-intellectuals',
      'consumers',
      'commentators',
    ],
    notSuitableFor: [
      'enterprise-procurement',
      'private-b2b',
      'highly-regulated-industries',
    ],
  },

  loginProbe: {
    loggedInUrl: 'https://x.com/home',
    loggedOutUrlMarkers: ['/i/flow/login', '/login'],
    loggedInTextMarkers: ['For you', 'Following', 'What is happening'],
  },

  capabilities: {
    canRead: true,
    canPost: true,
    canComment: true,
    canCollectMetrics: true,
    executionMode: 'hybrid',
    requiresHumanFinalize: false,
    maxAutonomousRiskLevel: 3,
    dailyActionCap: 8,
  },

  defaultRiskByActionType: {},
  systemAddendum: X_ADDENDUM,
  actions: {},
  blockedHints: [],
  defaultCooldownHoursByReason: DEFAULT_COOLDOWN_HOURS,
  warmupRules: [],
}
