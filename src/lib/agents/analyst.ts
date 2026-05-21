import { z } from 'zod'
import { generateStructured } from '@/lib/llm/client'
import type { Agent, AgentContext, AnalystOutput } from './types'

/**
 * Analyst Agent.
 *
 * Input: raw scraped product data (name, descriptions, reviews, etc.)
 * Output: structured insight — features, pain points, keywords, tone, reviews summary.
 *
 * This is the "thinking" step: we transform messy product copy into
 * a clean, queryable representation that downstream Writer + Critic agents consume.
 *
 * Model: deepseek-v4-pro by default (1M ctx + thinking mode), with
 *        gpt-4o-mini as the fallback when DeepSeek is not configured.
 *        Role-based routing lives in `@/lib/llm/config`.
 * Hard rule: every feature must include an `evidenceQuote` from the source.
 *           No hallucinations.
 */

// ---------- Schema ----------

const FeatureSchema = z.object({
  name: z.string().min(2).max(50).describe('Short feature name, e.g., "PDF redaction"'),
  benefit: z.string().min(5).max(160).describe('User-visible benefit in one sentence'),
  evidenceQuote: z
    .string()
    .min(3)
    .max(280)
    .describe('Verbatim quote from the source proving this feature exists'),
})

const ToneSchema = z.object({
  formality: z
    .number()
    .int()
    .min(1)
    .max(5)
    .describe('1=very casual, 5=enterprise formal'),
  technicality: z
    .number()
    .int()
    .min(1)
    .max(5)
    .describe('1=non-technical, 5=deep technical'),
  suggestedTone: z
    .string()
    .min(5)
    .max(160)
    .describe('Recommended tone for marketing copy, e.g., "concise, dev-first, low hype"'),
})

const AnalystSchema = z.object({
  features: z.array(FeatureSchema).min(1).max(5),
  painPoints: z
    .array(z.string().min(5).max(160))
    .max(10)
    .describe('Pain points mentioned in reviews or low ratings; empty if none found'),
  keywords: z
    .array(z.string().min(2).max(40))
    .min(3)
    .max(15)
    .describe('SEO/ASO keyword candidates relevant to this product'),
  tone: ToneSchema,
  reviewsSummary: z
    .string()
    .max(500)
    .describe('100-word summary of user review sentiment, or empty string if no reviews'),
})

// ---------- Agent ----------

export const analystAgent: Agent<AnalystOutput> = {
  name: 'analyst',

  async run(ctx: AgentContext): Promise<AnalystOutput> {
    if (!ctx.crawl) {
      throw new Error('Analyst requires crawler output')
    }

    const startedAt = Date.now()
    const { product } = ctx.crawl
    const raw = product.raw

    await ctx.emit({
      agent: 'analyst',
      step: 'start',
      inputSummary: `Analyzing ${raw.name ?? product.url}`,
    })

    const reviews = (raw.reviews ?? [])
      .slice(0, 30) // cap to keep prompt size sane
      .map((r) => `[${r.rating}★] ${r.text}`.slice(0, 400))
      .join('\n')

    const prompt = buildPrompt({
      productUrl: product.url,
      productType: ctx.crawl.productType,
      name: raw.name,
      tagline: raw.tagline,
      description: raw.description,
      longDescription: raw.longDescription,
      category: raw.category,
      installs: raw.installs,
      rating: raw.rating,
      ratingCount: raw.ratingCount,
      reviewsBlock: reviews,
    })

    const { data, usage } = await generateStructured('analyst', AnalystSchema, prompt, {
      system: SYSTEM_PROMPT,
      temperature: 0.2,
      maxTokens: 2000,
    })

    const output: AnalystOutput = data

    await ctx.emit({
      agent: 'analyst',
      step: 'complete',
      outputSummary: `Found ${output.features.length} features, ${output.painPoints.length} pain points, ${output.keywords.length} keywords (tone: ${output.tone.suggestedTone})`,
      reasoning: buildReasoning(output),
      rawOutput: output,
      model: usage.model,
      tokensIn: usage.tokensIn,
      tokensOut: usage.tokensOut,
      costUsd: usage.costUsd,
      durationMs: Date.now() - startedAt,
    })

    return output
  },
}

// ---------- Prompt ----------

const SYSTEM_PROMPT = `You are a B2D (developer-tools) marketing analyst.
Your job is to extract structured insight from a product page so that downstream agents can write multi-channel launch copy.

Hard rules:
1. Every "feature" MUST have an evidenceQuote that is a verbatim substring of the input.
2. Never invent features that are not supported by the input.
3. Pain points come ONLY from user reviews or low-rating signals. If no reviews, return empty array.
4. Keywords should be ASO/SEO candidates, NOT marketing buzzwords. Avoid "revolutionary", "game-changer".
5. The "suggestedTone" should be concrete and developer-friendly (avoid markety language).

Output strict JSON matching the schema. No prose outside the JSON.`

interface PromptInput {
  productUrl: string
  productType: string
  name?: string
  tagline?: string
  description?: string
  longDescription?: string
  category?: string
  installs?: number
  rating?: number
  ratingCount?: number
  reviewsBlock: string
}

function buildPrompt(p: PromptInput): string {
  const lines: string[] = []
  lines.push(`Product URL: ${p.productUrl}`)
  lines.push(`Product type: ${p.productType}`)
  if (p.name) lines.push(`Name: ${p.name}`)
  if (p.tagline) lines.push(`Tagline: ${p.tagline}`)
  if (p.category) lines.push(`Category: ${p.category}`)
  if (typeof p.installs === 'number') lines.push(`Installs: ${p.installs.toLocaleString()}`)
  if (typeof p.rating === 'number')
    lines.push(`Rating: ${p.rating} (${p.ratingCount ?? 0} reviews)`)
  if (p.description) lines.push(`\nShort description:\n${p.description}`)
  if (p.longDescription) lines.push(`\nLong description:\n${p.longDescription.slice(0, 4000)}`)
  if (p.reviewsBlock) lines.push(`\nUser reviews (newest first):\n${p.reviewsBlock}`)

  lines.push(
    `\nExtract: features (max 5, with verbatim evidence quotes), painPoints (from reviews only), keywords (3-15 ASO/SEO candidates), tone (formality 1-5, technicality 1-5, suggestedTone string), reviewsSummary (max 100 words).`,
  )

  return lines.join('\n')
}

function buildReasoning(out: AnalystOutput): string {
  const top = out.features
    .slice(0, 3)
    .map((f) => `${f.name} → ${f.benefit}`)
    .join(' | ')
  return `Top features: ${top}. Tone: formality=${out.tone.formality}/5, technicality=${out.tone.technicality}/5.`
}
