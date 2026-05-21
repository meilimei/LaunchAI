/**
 * Chrome Web Store (developer dashboard) — stub manifest.
 *
 * Listing edits are level-4 risk and ALWAYS require explicit user approval.
 * Even with a connected session, the autonomous cap is 0 — the agent can
 * draft changes but never submits without a human.
 */
import type { PlatformManifest } from '../manifest'
import { DEFAULT_COOLDOWN_HOURS } from './common'

const CWS_ADDENDUM = [
  'Chrome Web Store listing edits affect production for every user.',
  'Never submit a draft. Output a diff and wait for human review.',
].join(' ')

export const cwsManifest: PlatformManifest = {
  id: 'cws',
  displayName: 'Chrome Web Store',
  baseUrl: 'https://chrome.google.com/webstore',
  loginUrl: 'https://chrome.google.com/webstore/devconsole',

  audienceProfile: {
    summary:
      'Distribution channel rather than a community. Reaches every Chrome user worldwide who searches for or browses extensions. Listing copy, screenshots, ratings, and store-search keywords are the entire conversion surface. Always relevant for any Chrome-extension product regardless of end-user demographic.',
    tags: [
      'distribution-channel',
      'chrome-users',
      'extension-buyers',
      'general-audience',
      'global',
      'seo-store-search',
    ],
    notSuitableFor: [
      'non-chrome-products',
    ],
  },

  loginProbe: {
    loggedInUrl: 'https://chrome.google.com/webstore/devconsole',
    loggedOutUrlMarkers: ['accounts.google.com'],
    loggedInTextMarkers: ['Developer Console', 'Items', 'Account'],
  },

  capabilities: {
    canRead: true,
    canPost: false,
    canComment: false,
    canCollectMetrics: true,
    executionMode: 'browser_assisted',
    requiresHumanFinalize: true,
    maxAutonomousRiskLevel: 0,
    dailyActionCap: 0,
  },

  defaultRiskByActionType: {},
  systemAddendum: CWS_ADDENDUM,
  actions: {},
  blockedHints: [],
  defaultCooldownHoursByReason: DEFAULT_COOLDOWN_HOURS,
  warmupRules: [],
}
