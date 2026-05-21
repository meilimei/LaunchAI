import type { Channel } from '@/lib/agents/types'

/**
 * Channel display metadata + deep-link helpers.
 *
 * Deep links open the platform's publish page with prefilled fields where
 * supported. We NEVER auto-publish — user copies content + clicks through.
 *
 * Notes per platform:
 *   - CWS: no public deep link; user must edit listing in dev console.
 *   - PH: /posts/new (no prefill API publicly).
 *   - Reddit: /r/{sub}/submit supports ?title=&text= query params.
 *   - HN: /submit takes no query params (HN convention; clipboard only).
 *   - X: /intent/tweet?text= for hook tweet; thread is manual.
 *   - IH: /post/new (no prefill API).
 */

export interface ChannelMeta {
  channel: Channel
  label: string
  shortLabel: string
  publishHint: string
  publishUrl?: (content: unknown) => string | null
}

export const CHANNEL_META: Record<Channel, ChannelMeta> = {
  cws_listing: {
    channel: 'cws_listing',
    label: 'Chrome Web Store listing',
    shortLabel: 'CWS',
    publishHint: 'Update your listing in the Chrome Web Store developer console.',
    publishUrl: () => 'https://chrome.google.com/webstore/devconsole',
  },
  product_hunt: {
    channel: 'product_hunt',
    label: 'Product Hunt',
    shortLabel: 'PH',
    publishHint: 'Submit a new post on Product Hunt and paste the tagline + description.',
    publishUrl: () => 'https://www.producthunt.com/posts/new',
  },
  reddit: {
    channel: 'reddit',
    label: 'Reddit',
    shortLabel: 'Reddit',
    publishHint: 'Open the subreddit submit page with your title + body prefilled.',
    publishUrl: (content) => {
      const c = content as { subreddit: string; title: string; body: string }
      const sub = encodeURIComponent(c.subreddit || 'chrome_extensions')
      const title = encodeURIComponent(c.title)
      const text = encodeURIComponent(c.body)
      return `https://www.reddit.com/r/${sub}/submit?title=${title}&text=${text}`
    },
  },
  hacker_news: {
    channel: 'hacker_news',
    label: 'Hacker News',
    shortLabel: 'HN',
    publishHint: 'HN doesn\'t accept prefilled posts. Copy the title + body and paste manually.',
    publishUrl: () => 'https://news.ycombinator.com/submit',
  },
  twitter: {
    channel: 'twitter',
    label: 'X / Twitter',
    shortLabel: 'X',
    publishHint: 'Open the tweet composer with your hook prefilled. Thread the rest manually.',
    publishUrl: (content) => {
      const c = content as { hookTweet: string }
      const text = encodeURIComponent(c.hookTweet)
      return `https://x.com/intent/tweet?text=${text}`
    },
  },
  indie_hackers: {
    channel: 'indie_hackers',
    label: 'Indie Hackers',
    shortLabel: 'IH',
    publishHint: 'Submit a milestone post on Indie Hackers.',
    publishUrl: () => 'https://www.indiehackers.com/post/new',
  },
}

/**
 * Fixed display order for the dashboard.
 */
export const CHANNEL_ORDER: Channel[] = [
  'cws_listing',
  'product_hunt',
  'reddit',
  'hacker_news',
  'twitter',
  'indie_hackers',
]
