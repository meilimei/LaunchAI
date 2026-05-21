import { CopyButton } from './copy-button'
import type { ChannelContent } from '@/lib/agents/types'

/**
 * Per-channel content renderer with field-level copy buttons.
 * Each channel's content shape is different, so we dispatch on `channel`.
 */
export function AssetContent({ content }: { content: ChannelContent }) {
  switch (content.channel) {
    case 'cws_listing':
      return <CwsContent c={content} />
    case 'product_hunt':
      return <PhContent c={content} />
    case 'reddit':
      return <RedditContent c={content} />
    case 'hacker_news':
      return <HnContent c={content} />
    case 'twitter':
      return <TwitterContent c={content} />
    case 'indie_hackers':
      return <IhContent c={content} />
    default:
      return null
  }
}

function Field({
  label,
  value,
  multiline,
  hint,
}: {
  label: string
  value: string
  multiline?: boolean
  hint?: string
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">
          {label}
          {hint && <span className="ml-1 text-muted-foreground/70">· {hint}</span>}
        </span>
        <CopyButton text={value} size="xs" />
      </div>
      <div
        className={
          multiline
            ? 'whitespace-pre-wrap rounded border bg-muted/30 px-3 py-2 text-sm leading-relaxed'
            : 'rounded border bg-muted/30 px-3 py-2 text-sm'
        }
      >
        {value}
      </div>
    </div>
  )
}

function CwsContent({ c }: { c: Extract<ChannelContent, { channel: 'cws_listing' }> }) {
  return (
    <div className="space-y-3">
      <Field label="Title" value={c.title} hint={`${c.title.length}/75`} />
      <Field
        label="Short description"
        value={c.shortDescription}
        hint={`${c.shortDescription.length}/132`}
      />
      <Field label="Detailed description" value={c.detailedDescription} multiline />
      <Field label="Promo tile" value={c.promoTile} />
      <div className="space-y-1">
        <span className="text-xs font-medium text-muted-foreground">Screenshot captions</span>
        <ol className="space-y-1.5 pl-4 text-sm">
          {c.screenshotCaptions.map((cap, i) => (
            <li key={i} className="flex items-start gap-2">
              <span className="mt-0.5 text-muted-foreground">{i + 1}.</span>
              <span className="flex-1">{cap}</span>
              <CopyButton text={cap} size="xs" />
            </li>
          ))}
        </ol>
      </div>
    </div>
  )
}

function PhContent({ c }: { c: Extract<ChannelContent, { channel: 'product_hunt' }> }) {
  return (
    <div className="space-y-3">
      <Field label="Tagline" value={c.tagline} hint={`${c.tagline.length}/60`} />
      <Field label="Description" value={c.description} multiline />
      <Field label="First comment (maker's reply)" value={c.firstComment} multiline />
      <Field label="Maker comment" value={c.makerComment} multiline />
      <div className="space-y-1">
        <span className="text-xs font-medium text-muted-foreground">Topics</span>
        <div className="flex flex-wrap gap-1.5">
          {c.topics.map((t, i) => (
            <span key={i} className="rounded-full border bg-secondary/40 px-2 py-0.5 text-xs">
              {t}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}

function RedditContent({ c }: { c: Extract<ChannelContent, { channel: 'reddit' }> }) {
  return (
    <div className="space-y-3">
      <Field label="Subreddit" value={`r/${c.subreddit}`} />
      <Field label="Title" value={c.title} hint={`${c.title.length}/300`} />
      <Field label="Body" value={c.body} multiline />
      <Field label="Self-promo note" value={c.selfPromoNote} multiline />
    </div>
  )
}

function HnContent({ c }: { c: Extract<ChannelContent, { channel: 'hacker_news' }> }) {
  return (
    <div className="space-y-3">
      <Field label="Title" value={c.title} />
      <Field label="Body" value={c.body} multiline />
      <Field label="Comment strategy (for you, not for posting)" value={c.commentStrategy} multiline />
    </div>
  )
}

function TwitterContent({ c }: { c: Extract<ChannelContent, { channel: 'twitter' }> }) {
  return (
    <div className="space-y-3">
      <Field label="Hook tweet" value={c.hookTweet} hint={`${c.hookTweet.length}/280`} />
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-muted-foreground">
            Thread ({c.thread.length} tweets)
          </span>
          <CopyButton text={c.thread.join('\n\n')} size="xs" label="Copy all" />
        </div>
        <ol className="space-y-1.5">
          {c.thread.map((t, i) => (
            <li
              key={i}
              className="flex items-start gap-2 rounded border bg-muted/30 px-3 py-2 text-sm"
            >
              <span className="mt-0.5 font-mono text-xs text-muted-foreground">
                {i + 1}/{c.thread.length}
              </span>
              <span className="flex-1 whitespace-pre-wrap">{t}</span>
              <CopyButton text={t} size="xs" />
            </li>
          ))}
        </ol>
      </div>
      <Field label="Retweet copy" value={c.retweetCopy} />
    </div>
  )
}

function IhContent({ c }: { c: Extract<ChannelContent, { channel: 'indie_hackers' }> }) {
  return (
    <div className="space-y-3">
      <Field label="Milestone" value={c.milestone} />
      <Field label="Title" value={c.title} />
      <Field label="Body" value={c.body} multiline />
    </div>
  )
}
