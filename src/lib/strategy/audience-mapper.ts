/**
 * AudienceMapper — Strategist (L3) component that ranks platforms by fit
 * for a campaign's ideal customer profile (ICP).
 *
 * Inputs
 *   - campaign ICP (free-text or structured)
 *   - product context (name, one-liner, URL, type)
 *   - all available PlatformManifests (with audienceProfile)
 *
 * Output
 *   - per-platform fit score (0..1) + rationale + recommended tactics
 *   - missing-platforms list — known platforms the LLM thinks are a great fit
 *     but no manifest exists yet (e.g. linkedin, niche forums)
 *
 * The LLM is the only place "what audience is on what platform" judgement
 * lives. The manifest's audienceProfile is the ground truth the LLM reads;
 * it does not invent platform demographics.
 *
 * No persistence at this layer — caller decides whether to save to a campaign
 * row, render in UI, or use as a one-shot dev planner.
 */
import { z } from 'zod'
import { generateStructured } from '@/lib/llm/client'
import { listManifests } from '@/lib/platforms/manifests'
import type { PlatformManifest } from '@/lib/platforms/manifest'
import type { PlatformId } from '@/lib/platforms/types'

// ─── Public types ───────────────────────────────────────────────────────────

export interface ProductContext {
  /** Short product name. */
  name: string
  /** One-sentence value prop. */
  oneLiner: string
  /** Public landing URL (used as a hint, not crawled). */
  url: string
  /**
   * Distribution type — informs the LLM whether owned channels (CWS, blog)
   * are inherently relevant.
   */
  type: 'chrome_extension' | 'web_app' | 'desktop_app' | 'mobile_app' | 'service' | 'other'
}

export interface AudienceMapperInput {
  /**
   * Free-text description of who the campaign is trying to reach. Should
   * include role/profession, industry, demographics, pain points.
   * Example: "Lawyers and paralegals in mid-size US firms who need to redact
   *           PII from client documents before sharing them externally."
   */
  audience: string
  product: ProductContext
  /** Optional override; defaults to all registered manifests. */
  manifests?: PlatformManifest[]
}

export interface PlatformRecommendation {
  platform: PlatformId
  /** 0 (terrible fit) .. 1 (perfect fit). */
  fitScore: number
  /** One short sentence explaining the score. Persisted to decision_logs. */
  rationale: string
  /**
   * Suggested tactics specific to this platform — e.g. "target r/Lawyers",
   * "publish long-tail SEO posts", "Show HN on a technical sub-component".
   */
  recommendedTactics: string[]
}

export interface MissingPlatform {
  /** LLM-suggested platform identifier (snake_case). */
  suggestedId: string
  /** Why the LLM thinks this audience is reachable there. */
  rationale: string
}

export interface AudienceMapperResult {
  recommendations: PlatformRecommendation[]
  /**
   * Platforms the LLM thinks ARE a strong fit but we have no manifest for.
   * The user / supervisor can prioritize building these next.
   */
  missingPlatforms: MissingPlatform[]
  /** LLM cost + tokens for the call. */
  usage: {
    model: string
    tokensIn: number
    tokensOut: number
    costUsd: number
  }
}

// ─── LLM output schema ──────────────────────────────────────────────────────

const RecommendationSchema = z.object({
  platform: z.string().describe('platform_id from the provided list, exactly'),
  fitScore: z
    .number()
    .min(0)
    .max(1)
    .describe('0 = terrible fit, 1 = perfect fit. Be honest, not generous.'),
  rationale: z
    .string()
    .min(15)
    .max(400)
    .describe('One short sentence explaining the score in plain English.'),
  recommendedTactics: z
    .array(z.string().min(5).max(200))
    .min(1)
    .max(5)
    .describe(
      'Concrete platform-specific tactics. For Reddit list 1–3 specific subreddits; for X list 1–3 follow-graph seeds; for blog suggest 1–3 SEO query themes.',
    ),
})

const MissingSchema = z.object({
  suggestedId: z
    .string()
    .min(2)
    .max(40)
    .describe('snake_case platform identifier, e.g. "linkedin", "tiktok".'),
  rationale: z.string().min(15).max(400),
})

const ResultSchema = z.object({
  recommendations: z.array(RecommendationSchema),
  missingPlatforms: z.array(MissingSchema),
})

// ─── Prompt ─────────────────────────────────────────────────────────────────

const SYSTEM = `You are a marketing strategist who matches an early-stage product to the platforms where its real buyers spend time.

Discipline:
- Be HONEST about fit. A B2B legal tool scores ~0.05 on Hacker News even if developers might find it interesting — the actual buyers (lawyers) are not there.
- Read each platform's audienceProfile.summary literally. Do not invent demographics. Do not assume "developers everywhere" applies to non-developer buyers.
- Owned distribution channels (Chrome Web Store for an extension, owned blog for SEO) are nearly always relevant if the product matches — score them on tactical relevance, not audience overlap.
- If a platform's "notSuitableFor" overlaps with the campaign audience, score ≤ 0.2 unless there is a specific subgroup tactic that makes it work.
- Surface "missing platforms" only when you are confident a major audience hub is not covered (LinkedIn for B2B professionals, TikTok for Gen-Z consumers, niche forums for specialized industries). Do not invent obscure ones.

Output schema discipline:
- One recommendation per provided platform, exact id match, no extras.
- recommendedTactics must be specific — for Reddit, name the actual subreddits; for blog, name SEO query themes; for X, name follow-graph seed accounts.`

function buildPrompt(input: AudienceMapperInput, manifests: PlatformManifest[]): string {
  const manifestSummaries = manifests
    .map((m) => {
      const ap = m.audienceProfile
      const parts = [
        `### ${m.id} — ${m.displayName}`,
        `summary: ${ap.summary}`,
        `tags: ${ap.tags.join(', ')}`,
      ]
      if (ap.notSuitableFor && ap.notSuitableFor.length > 0) {
        parts.push(`notSuitableFor: ${ap.notSuitableFor.join(', ')}`)
      }
      parts.push(`capabilities: canPost=${m.capabilities.canPost}, canComment=${m.capabilities.canComment}, executionMode=${m.capabilities.executionMode}`)
      return parts.join('\n')
    })
    .join('\n\n')

  return `# CAMPAIGN

## Product
- name: ${input.product.name}
- one-liner: ${input.product.oneLiner}
- type: ${input.product.type}
- url: ${input.product.url}

## Target audience
${input.audience}

# AVAILABLE PLATFORMS (you MUST emit one recommendation per platform_id below)

${manifestSummaries}

# TASK

1. For each platform above, emit a recommendation with fitScore (0..1), rationale, and 1-5 specific recommendedTactics.
2. Emit missingPlatforms[] for any major audience hubs not covered above (only if confident; usually 0-2 entries).

Be terse and honest. Do not pad with optimistic language.`
}

// ─── Public API ─────────────────────────────────────────────────────────────

export async function mapAudienceToPlatforms(
  input: AudienceMapperInput,
): Promise<AudienceMapperResult> {
  const manifests = input.manifests ?? listManifests()
  if (manifests.length === 0) {
    throw new Error('AudienceMapper: no manifests provided / registered')
  }

  const prompt = buildPrompt(input, manifests)

  const { data, usage } = await generateStructured('analyst', ResultSchema, prompt, {
    system: SYSTEM,
    temperature: 0.1,
    maxTokens: 2000,
  })

  // Validate that every manifest got a recommendation and that ids are real.
  const validIds = new Set(manifests.map((m) => m.id))
  const recommendations: PlatformRecommendation[] = []
  for (const r of data.recommendations) {
    if (!validIds.has(r.platform as PlatformId)) {
      // The LLM hallucinated an id. Skip silently — the missing real id will
      // be caught by the completeness check below.
      continue
    }
    recommendations.push({
      platform: r.platform as PlatformId,
      fitScore: r.fitScore,
      rationale: r.rationale,
      recommendedTactics: r.recommendedTactics,
    })
  }

  // Backfill any manifest the LLM forgot, with a low-confidence stub. This
  // keeps the UI / supervisor's downstream code simple (one row per platform).
  const seen = new Set(recommendations.map((r) => r.platform))
  for (const m of manifests) {
    if (!seen.has(m.id)) {
      recommendations.push({
        platform: m.id,
        fitScore: 0,
        rationale: '(LLM omitted this platform; treat as unknown fit)',
        recommendedTactics: [],
      })
    }
  }

  // Sort by fitScore descending so the caller can pick top-K easily.
  recommendations.sort((a, b) => b.fitScore - a.fitScore)

  return {
    recommendations,
    missingPlatforms: data.missingPlatforms,
    usage: {
      model: usage.model,
      tokensIn: usage.tokensIn,
      tokensOut: usage.tokensOut,
      costUsd: usage.costUsd,
    },
  }
}
