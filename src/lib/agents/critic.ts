import { z } from 'zod'
import { and, eq } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { assets } from '@/lib/db/schema'
import { generateStructured } from '@/lib/llm/client'
import type {
  Agent,
  AgentContext,
  Channel,
  CriticOutput,
  CriticScore,
  WriterOutput,
} from './types'

/**
 * Critic Agent.
 *
 * Scores each Writer version on a 4-dimension rubric and picks the best one per channel.
 * Updates the corresponding `assets` rows with isRecommended / criticScore / criticReasoning.
 *
 * Rubric (each 0-10):
 *   - toneB2D:       developer-friendly tone, avoids markety language
 *   - specificity:   concrete claims tied to features, not vague
 *   - compliance:    channel-specific rules (length, format, self-promo)
 *   - hookStrength:  opening line draws attention without clickbait
 *
 * Total = (toneB2D*0.35 + specificity*0.25 + compliance*0.20 + hookStrength*0.20) * 10
 *
 * Critic is the most observable part of the "decision visualization" — its
 * reasoning text is shown to the user as the explanation of why version X was picked.
 */

// ---------- Schema ----------

const ScoreSchema = z.object({
  toneB2D: z.number().min(0).max(10),
  specificity: z.number().min(0).max(10),
  compliance: z.number().min(0).max(10),
  hookStrength: z.number().min(0).max(10),
})

const ChannelCriticSchema = z.object({
  recommendedVersion: z.enum(['a', 'b', 'c']),
  scores: z.object({
    a: ScoreSchema,
    b: ScoreSchema,
    c: ScoreSchema,
  }),
  reasoning: z
    .string()
    .min(60)
    .max(800)
    .describe('Why the recommended version beat the others. Concrete reasons. Mention specific lines.'),
})

// ---------- Agent ----------

export const criticAgent: Agent<CriticOutput> = {
  name: 'critic',

  async run(ctx: AgentContext): Promise<CriticOutput> {
    if (!ctx.assets || ctx.assets.length === 0) {
      throw new Error('Critic requires writer output')
    }

    const byChannel: CriticOutput['byChannel'] = {} as CriticOutput['byChannel']

    for (const writerOut of ctx.assets) {
      const startedAt = Date.now()
      const channel = writerOut.channel

      await ctx.emit({
        agent: 'critic',
        step: `score_${channel}`,
        inputSummary: `Scoring 3 versions for ${channel}`,
      })

      try {
        const decision = await scoreChannel(channel, writerOut)

        // Compute totals.
        const totals: Record<'a' | 'b' | 'c', number> = {
          a: computeTotal(decision.scores.a),
          b: computeTotal(decision.scores.b),
          c: computeTotal(decision.scores.c),
        }

        byChannel[channel] = {
          recommendedVersion: decision.recommendedVersion,
          scores: {
            a: { ...decision.scores.a, total: totals.a },
            b: { ...decision.scores.b, total: totals.b },
            c: { ...decision.scores.c, total: totals.c },
          },
          reasoning: decision.reasoning,
        }

        // Persist scores + recommended flag back to the assets table.
        for (const v of writerOut.versions) {
          const score = byChannel[channel]!.scores[v.version]
          await db
            .update(assets)
            .set({
              isRecommended: v.version === decision.recommendedVersion,
              criticScore: score.total.toFixed(2),
              criticReasoning:
                v.version === decision.recommendedVersion ? decision.reasoning : null,
            })
            .where(and(eq(assets.jobId, ctx.job.id), eq(assets.channel, channel), eq(assets.version, v.version)))
        }

        await ctx.emit({
          agent: 'critic',
          step: `score_${channel}_complete`,
          outputSummary: `Picked version ${decision.recommendedVersion.toUpperCase()} (score ${totals[decision.recommendedVersion].toFixed(1)}/100)`,
          reasoning: decision.reasoning,
          durationMs: Date.now() - startedAt,
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error(`[critic] Failed for ${channel}:`, err)
        await ctx.emit({
          agent: 'critic',
          step: `score_${channel}`,
          status: 'error',
          error: message,
          durationMs: Date.now() - startedAt,
        })
      }
    }

    return { byChannel }
  },
}

// ---------- Helpers ----------

async function scoreChannel(
  channel: Channel,
  writerOut: WriterOutput,
): Promise<z.infer<typeof ChannelCriticSchema>> {
  const prompt = buildCriticPrompt(channel, writerOut)

  const { data } = await generateStructured('critic', ChannelCriticSchema, prompt, {
    system: SYSTEM_PROMPT,
    temperature: 0.1,
    maxTokens: 1500,
  })

  return data
}

function computeTotal(s: Omit<CriticScore, 'total'>): number {
  return (
    s.toneB2D * 0.35 + s.specificity * 0.25 + s.compliance * 0.2 + s.hookStrength * 0.2
  ) * 10
}

const SYSTEM_PROMPT = `You are a senior B2D (developer-tools) marketing reviewer.
You receive 3 versions of launch copy for a single channel and must pick the best.

Score each version on 4 dimensions (0-10 each):
  - toneB2D: developer-friendly. Penalize markety vocabulary ("revolutionary", "game-changer", buzzwords).
             Reward concrete, calm, peer-to-peer voice.
  - specificity: each claim is concrete and references actual product capabilities.
             Penalize vague phrases like "powerful tool", "best-in-class".
  - compliance: matches the channel's hard rules (length, format, no banned terms).
             Penalize obvious schema violations (too long, wrong format, missing required parts).
  - hookStrength: opening grabs attention without clickbait. Penalize question-bait, hype, all-caps.

Pick exactly ONE recommended version (a, b, or c).
Write reasoning that names specific lines from the chosen version and explains why competing versions lost.
The reasoning is shown to the user verbatim, so be concrete and helpful.`

function buildCriticPrompt(channel: Channel, writerOut: WriterOutput): string {
  const lines: string[] = [`Channel: ${channel}`, '']

  for (const v of writerOut.versions) {
    lines.push(`---- Version ${v.version.toUpperCase()} (style: ${v.styleLabel}) ----`)
    lines.push(JSON.stringify(v.content, null, 2))
    lines.push('')
  }

  lines.push('Score every version on the 4 dimensions and pick the best.')
  return lines.join('\n')
}
