import { z } from 'zod'
import { nanoid } from 'nanoid'
import { db } from '@/lib/db/client'
import { assets } from '@/lib/db/schema'
import { generateStructured } from '@/lib/llm/client'
import { retrieveMemories } from '@/lib/memory/store'
import type { Memory } from '@/lib/db/schema'
import type {
  Agent,
  AgentContext,
  Channel,
  ChannelContent,
  WriterOutput,
  WriterVersion,
  AnalystOutput,
} from './types'

/**
 * Writer Agent.
 *
 * For each of 6 channels, generates 3 versions of launch copy with
 * distinct styles (technical / story / pain-point).
 *
 * Why a single Writer agent (not one per channel):
 *   - Same LLM call shape for every channel; only schema + prompt differ
 *   - Channel configs live in a static table (CHANNEL_CONFIGS) — easy to audit
 *   - Less code, fewer files, lower cognitive cost
 *
 * Hard rules baked into all prompts:
 *   - No marketing buzzwords (revolutionary, game-changer, ...)
 *   - Concrete claims grounded in Analyst features (not invented)
 *   - Each channel's compliance rules (length, format, self-promo) enforced via Zod
 *
 * Cost: ~6 channels × 3 versions × Sonnet → dominant cost in the pipeline.
 *       Free tier downgrades to mini.
 */

// ---------- Per-channel Zod schemas ----------

const VersionLabelSchema = z.enum(['technical', 'story', 'pain-point'])

// CWS Listing
const CwsContentSchema = z.object({
  channel: z.literal('cws_listing'),
  title: z.string().min(5).max(75),
  shortDescription: z.string().min(20).max(132),
  detailedDescription: z.string().min(200).max(8000),
  promoTile: z.string().min(10).max(120),
  screenshotCaptions: z.array(z.string().min(5).max(120)).min(3).max(5),
})

// Product Hunt
const ProductHuntContentSchema = z.object({
  channel: z.literal('product_hunt'),
  tagline: z.string().min(10).max(60),
  description: z.string().min(100).max(260),
  firstComment: z.string().min(150).max(1500),
  makerComment: z.string().min(80).max(800),
  topics: z.array(z.string().min(2).max(40)).min(2).max(5),
})

// Reddit
const RedditContentSchema = z.object({
  channel: z.literal('reddit'),
  subreddit: z.string().regex(/^[a-z0-9_]{3,21}$/i),
  title: z.string().min(15).max(300),
  body: z.string().min(150).max(2000),
  selfPromoNote: z.string().min(20).max(400),
})

// Hacker News (Show HN)
const HackerNewsContentSchema = z.object({
  channel: z.literal('hacker_news'),
  title: z.string().min(10).max(80).startsWith('Show HN:'),
  body: z.string().min(200).max(2500),
  commentStrategy: z.string().min(50).max(600),
})

// Twitter / X
const TwitterContentSchema = z.object({
  channel: z.literal('twitter'),
  hookTweet: z.string().min(20).max(280),
  thread: z.array(z.string().min(20).max(280)).min(3).max(7),
  retweetCopy: z.string().min(20).max(280),
})

// Indie Hackers
const IndieHackersContentSchema = z.object({
  channel: z.literal('indie_hackers'),
  title: z.string().min(15).max(120),
  body: z.string().min(200).max(3000),
  milestone: z.string().min(20).max(200),
})

// Versions wrapper used per channel
function makeVersionsSchema<T extends z.ZodTypeAny>(contentSchema: T) {
  return z.object({
    versions: z
      .array(
        z.object({
          version: z.enum(['a', 'b', 'c']),
          styleLabel: VersionLabelSchema,
          content: contentSchema,
        }),
      )
      .length(3),
  })
}

// ---------- Channel configs ----------

interface ChannelConfig {
  channel: Channel
  label: string
  systemPrompt: string
  schema: z.ZodTypeAny
  defaults?: { subreddit?: string }
}

const SHARED_GUARDRAILS = `
HARD RULES (apply to EVERY version you write):
1. Concrete claims only. If a claim isn't supported by the Analyst features list, do not write it.
2. Banned vocabulary: "revolutionary", "game-changer", "game changer", "world-class", "next-gen", "next gen",
   "cutting-edge", "leverage", "synergize", "supercharge", "unleash", "unlock the power".
3. Developer-friendly tone. Match the suggestedTone field from the Analyst output.
4. The 3 versions MUST have distinct styles:
     - "technical": lead with how it works / what it does mechanically
     - "story": lead with a relatable problem-solution narrative
     - "pain-point": lead with the user pain point and frame the product as relief
5. Use the product's actual name. Do not call it "this extension" / "our product".
`

const CHANNEL_CONFIGS: Record<Channel, ChannelConfig> = {
  cws_listing: {
    channel: 'cws_listing',
    label: 'Chrome Web Store listing',
    schema: makeVersionsSchema(CwsContentSchema),
    systemPrompt: `You are writing a Chrome Web Store listing optimized for search + conversion.${SHARED_GUARDRAILS}
Channel-specific rules:
- title ≤ 75 chars, includes primary keyword
- shortDescription ≤ 132 chars (CWS hard cap)
- detailedDescription: scannable; use line breaks; mention 3-5 features
- promoTile: 10-120 chars, hooky
- 3-5 screenshot captions, each ≤ 120 chars`,
  },
  product_hunt: {
    channel: 'product_hunt',
    label: 'Product Hunt launch',
    schema: makeVersionsSchema(ProductHuntContentSchema),
    systemPrompt: `You are writing a Product Hunt launch package.${SHARED_GUARDRAILS}
Channel-specific rules:
- tagline ≤ 60 chars (PH hard limit)
- description: 100-260 chars
- firstComment (the maker's first comment under the launch): 150-1500 chars; greet, problem, solution, ask for feedback
- makerComment: short bio + why you built it (80-800 chars)
- topics: 2-5 relevant PH topics (lowercase, no hashtag)`,
  },
  reddit: {
    channel: 'reddit',
    label: 'Reddit post',
    schema: makeVersionsSchema(RedditContentSchema),
    defaults: { subreddit: 'chrome_extensions' },
    systemPrompt: `You are writing a Reddit post for the chrome_extensions subreddit (Chrome extension makers and users).${SHARED_GUARDRAILS}
Channel-specific rules:
- subreddit: use "chrome_extensions" unless context strongly suggests otherwise
- title: 15-300 chars, no clickbait, no all-caps
- body: 150-2000 chars; explain what it does, why you built it, ask a specific question
- selfPromoNote: short note explaining you're a maker (transparency norm in this sub)`,
  },
  hacker_news: {
    channel: 'hacker_news',
    label: 'Hacker News (Show HN)',
    schema: makeVersionsSchema(HackerNewsContentSchema),
    systemPrompt: `You are writing a Show HN post.${SHARED_GUARDRAILS}
Channel-specific rules:
- title MUST start with "Show HN:" (HN convention; the schema enforces this)
- body: 200-2500 chars; deeply technical, what's interesting/novel, what stack you used, what's the hardest problem you solved
- commentStrategy: 50-600 chars on how to respond to common HN feedback (cynical / technical / dismissive)
- HN crowd hates marketing copy; aim for engineering peer review tone`,
  },
  twitter: {
    channel: 'twitter',
    label: 'X / Twitter launch thread',
    schema: makeVersionsSchema(TwitterContentSchema),
    systemPrompt: `You are writing a launch thread for X / Twitter.${SHARED_GUARDRAILS}
Channel-specific rules:
- hookTweet: ≤ 280 chars, must stop scroll
- thread: 3-7 tweets, each ≤ 280 chars; 1 idea per tweet; numbering optional
- retweetCopy: ≤ 280 chars; suggested copy for the user to quote-RT later
- avoid emoji bloat (≤ 2 per tweet)`,
  },
  indie_hackers: {
    channel: 'indie_hackers',
    label: 'Indie Hackers milestone',
    schema: makeVersionsSchema(IndieHackersContentSchema),
    systemPrompt: `You are writing an Indie Hackers milestone post.${SHARED_GUARDRAILS}
Channel-specific rules:
- title: 15-120 chars, descriptive (not clickbait)
- body: 200-3000 chars; first-person; include a concrete number if possible (users, revenue, days)
- milestone: 20-200 chars, the headline event being shared`,
  },
}

const ALL_CHANNELS: Channel[] = [
  'cws_listing',
  'product_hunt',
  'reddit',
  'hacker_news',
  'twitter',
  'indie_hackers',
]

// ---------- Agent ----------

export const writerAgent: Agent<WriterOutput[]> = {
  name: 'writer',

  async run(ctx: AgentContext): Promise<WriterOutput[]> {
    if (!ctx.analysis) {
      throw new Error('Writer requires analyst output')
    }
    if (!ctx.crawl) {
      throw new Error('Writer requires crawler output')
    }

    const productName = ctx.crawl.product.raw.name ?? 'this product'
    // TODO(Phase C-3): downgrade to mini for free-tier users (`ctx.job.user.plan === 'free'`).
    const freeTier = false

    const outputs: WriterOutput[] = []

    for (const channel of ALL_CHANNELS) {
      const cfg = CHANNEL_CONFIGS[channel]
      const startedAt = Date.now()

      await ctx.emit({
        agent: 'writer',
        step: `write_${channel}`,
        inputSummary: `Generating 3 versions for ${cfg.label}`,
      })

      try {
        const priorMemories = await retrieveMemories({
          userId: ctx.job.userId,
          campaignId: ctx.job.campaignId,
          channel,
          taskType: 'writer',
          limit: 4,
        })

        const prompt = buildWriterPrompt({
          channel,
          productName,
          productUrl: ctx.crawl.product.url,
          analysis: ctx.analysis,
          subredditDefault: cfg.defaults?.subreddit,
          priorMemories,
        })

        const { data, usage } = await generateStructured(
          'writer',
          cfg.schema,
          prompt,
          {
            system: cfg.systemPrompt,
            temperature: 0.7,
            maxTokens: 3500,
            freeTier,
          },
        )

        const parsed = data as { versions: WriterVersion[] }
        const versions: WriterVersion[] = parsed.versions

        // Persist each version as its own asset row.
        await db.insert(assets).values(
          versions.map((v) => ({
            id: nanoid(),
            jobId: ctx.job.id,
            channel,
            version: v.version,
            styleLabel: v.styleLabel,
            content: v.content as ChannelContent,
            isRecommended: false, // Critic sets this in the next step
          })),
        )

        outputs.push({ channel, versions })

        await ctx.emit({
          agent: 'writer',
          step: `write_${channel}_complete`,
          outputSummary:
            `Generated 3 versions (${versions.map((v) => v.styleLabel).join(', ')})` +
            (priorMemories.length > 0
              ? ` — informed by ${priorMemories.length} prior memories`
              : ''),
          model: usage.model,
          tokensIn: usage.tokensIn,
          tokensOut: usage.tokensOut,
          costUsd: usage.costUsd,
          durationMs: Date.now() - startedAt,
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error(`[writer] Failed for ${channel}:`, err)
        // Keep going on other channels — don't fail the whole pipeline if one channel rejects.
        await ctx.emit({
          agent: 'writer',
          step: `write_${channel}`,
          status: 'error',
          error: message,
          durationMs: Date.now() - startedAt,
        })
      }
    }

    return outputs
  },
}

// ---------- Prompt construction ----------

interface WriterPromptInput {
  channel: Channel
  productName: string
  productUrl: string
  analysis: AnalystOutput
  subredditDefault?: string
  priorMemories?: Memory[]
}

function buildWriterPrompt(p: WriterPromptInput): string {
  const lines: string[] = []
  lines.push(`Product: ${p.productName}`)
  lines.push(`URL: ${p.productUrl}`)
  lines.push(`Channel: ${p.channel}`)
  if (p.subredditDefault) {
    lines.push(`Default subreddit: ${p.subredditDefault}`)
  }

  lines.push(`\nFEATURES (verbatim from product page; do not invent more):`)
  for (const f of p.analysis.features) {
    lines.push(`- ${f.name}: ${f.benefit}`)
  }

  if (p.analysis.painPoints.length > 0) {
    lines.push(`\nPAIN POINTS users have mentioned:`)
    for (const pp of p.analysis.painPoints) {
      lines.push(`- ${pp}`)
    }
  }

  lines.push(`\nKEYWORDS: ${p.analysis.keywords.join(', ')}`)
  lines.push(
    `\nTONE: formality ${p.analysis.tone.formality}/5, technicality ${p.analysis.tone.technicality}/5. ` +
      `Suggested: ${p.analysis.tone.suggestedTone}`,
  )

  if (p.analysis.reviewsSummary) {
    lines.push(`\nREVIEWS SUMMARY: ${p.analysis.reviewsSummary}`)
  }

  if (p.priorMemories && p.priorMemories.length > 0) {
    lines.push(`\nPRIOR LEARNINGS (apply only if compatible with the current product facts above):`)
    for (const mem of p.priorMemories) {
      const head = mem.summary ?? mem.content.slice(0, 240)
      lines.push(`- (${mem.sourceType}, conf=${mem.confidence}) ${head}`)
    }
  }

  lines.push(
    `\nGenerate exactly 3 versions with versions a, b, c and distinct styleLabels (technical, story, pain-point). ` +
      `Each version's content MUST conform to the channel-specific schema.`,
  )

  return lines.join('\n')
}
