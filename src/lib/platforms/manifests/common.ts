/**
 * Shared manifest defaults — DRY across stub manifests.
 */
import type { CooldownReason } from '../manifest'

/**
 * Sensible default cooldown durations applied when a manifest does not
 * specify its own. Adapters can still override per-hint (BlockedHint.retryHours).
 */
export const DEFAULT_COOLDOWN_HOURS: Record<CooldownReason, number> = {
  new_account: 24,
  karma_threshold: 12,
  rate_limit: 1,
  verify_email: 24 * 30, // effectively paused until user re-verifies
  captcha: 6,
  manual_review: 24 * 30,
  // Sub-rules don't typically change; re-check fortnightly.
  subreddit_rules: 24 * 14,
  // Agent self-aborted (e.g. no good engage candidate, drafts failed
  // self-review). Platform itself did NOT refuse anything — we just want
  // a brief pause so the next run sees fresh candidates instead of the
  // identical hot.json snapshot.
  no_target: 1,
  unknown: 6,
}
