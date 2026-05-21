/**
 * URL → cache-key normalization for selector telemetry.
 *
 * The same selector that works on /r/ChatGPT/about/rules works on
 * /r/privacy/about/rules — the page templates are identical, only the
 * dynamic path segments differ. By collapsing those segments into `*`
 * we let one URL's learned selectors transfer to every URL of the same
 * shape, so the system learns once per page-kind, not once per page.
 *
 * This is a heuristic, not a parser. We pattern-match on common
 * shapes (subreddit slugs, user slugs, post ids, numeric ids, hex/uuid
 * ids) and leave anything we don't recognize alone. It's better to be
 * too specific (treat /r/ChatGPT/something as its own pattern) than too
 * lossy (collapse /privacy and /tos into the same pattern).
 */

/**
 * Normalize a URL into a stable pattern key suitable for indexing
 * selector telemetry. Returns "host/path" without scheme/query/hash.
 *
 * Examples:
 *   https://old.reddit.com/r/ChatGPT/about/rules
 *     → old.reddit.com/r/*\/about/rules
 *   https://www.reddit.com/r/ChatGPT/comments/abc123/some-slug/
 *     → www.reddit.com/r/*\/comments/*
 *   https://news.ycombinator.com/item?id=12345678
 *     → news.ycombinator.com/item
 */
export function urlToPattern(url: string): string {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    // Not a parseable URL — return as-is so we don't crash, but the
    // resulting "pattern" will be unique to this exact string.
    return url
  }

  const host = u.host.toLowerCase()
  let path = u.pathname

  // Reddit-style /r/<sub>, /u/<user>, /user/<user>
  path = path.replace(/\/r\/[^/]+/gi, '/r/*')
  path = path.replace(/\/u\/[^/]+/gi, '/u/*')
  path = path.replace(/\/user\/[^/]+/gi, '/user/*')

  // Reddit/HN /comments/<id> with optional slug segment
  path = path.replace(/\/comments\/[^/]+(?:\/[^/]+)?/gi, '/comments/*')

  // /posts/<id>, /threads/<id>, /status/<id> — common platform shapes
  path = path.replace(/\/(posts|threads|status|p)\/[^/]+/gi, '/$1/*')

  // Hex / uuid-like ids (8+ hex chars). Run after the named-segment rules
  // so we don't accidentally collapse /r/ChatGPT (where ChatGPT is a slug).
  path = path.replace(/\/[0-9a-f]{8,}/gi, '/*')

  // Numeric ids (3+ digits). 3+ avoids collapsing version segments like /v2.
  path = path.replace(/\/\d{3,}/g, '/*')

  // Drop trailing slash for consistent keys (but keep root "/" if path is empty)
  path = path.replace(/\/+$/, '') || '/'

  return `${host}${path}`
}
