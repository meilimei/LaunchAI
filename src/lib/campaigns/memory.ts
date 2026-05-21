import { and, eq } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { analyses, assets, jobs } from '@/lib/db/schema'
import { createMemory } from '@/lib/memory/store'

export interface InitialResearchMemoryInput {
  campaignId: string
  jobId: string
  taskId: string
}

export interface InitialResearchMemoryResult {
  campaignMemoryId: string
  channelMemoryIds: string[]
}

/**
 * After the initial_research task completes, sediment the run into two
 * layers of memory:
 *
 * 1. One campaign-level summary covering analysis + asset counts.
 * 2. One per-channel writer memory holding the recommended version
 *    and the critic's reasoning. These are scoped channel + taskType=writer
 *    so subsequent Writer runs (any campaign for this user) can pull them
 *    via retrieveMemories({ channel, taskType: 'writer' }).
 */
export async function writeInitialResearchMemory(
  input: InitialResearchMemoryInput,
): Promise<InitialResearchMemoryResult | null> {
  const [job] = await db
    .select({
      userId: jobs.userId,
      inputUrl: jobs.inputUrl,
      productType: jobs.productType,
    })
    .from(jobs)
    .where(eq(jobs.id, input.jobId))
    .limit(1)

  if (!job) {
    return null
  }

  const [analysis] = await db
    .select({
      features: analyses.features,
      painPoints: analyses.painPoints,
      keywords: analyses.keywords,
      tone: analyses.tone,
      reviewsSummary: analyses.reviewsSummary,
    })
    .from(analyses)
    .where(eq(analyses.jobId, input.jobId))
    .limit(1)

  const recommendedAssets = await db
    .select({
      channel: assets.channel,
      version: assets.version,
      styleLabel: assets.styleLabel,
      content: assets.content,
      criticScore: assets.criticScore,
      criticReasoning: assets.criticReasoning,
    })
    .from(assets)
    .where(and(eq(assets.jobId, input.jobId), eq(assets.isRecommended, true)))
    .limit(20)

  const summaryContent = [
    `Initial research completed for ${job.inputUrl}.`,
    `Product type: ${job.productType}.`,
    analysis ? `Analysis: ${JSON.stringify(analysis)}` : 'Analysis: unavailable.',
    `Recommended versions: ${recommendedAssets
      .map((a) => `${a.channel}:${a.version}(${a.styleLabel ?? 'unknown'})`)
      .join(', ')}`,
  ].join('\n')

  const campaignMemoryId = await createMemory({
    userId: job.userId,
    campaignId: input.campaignId,
    jobId: input.jobId,
    sourceType: 'initial_research_task',
    sourceId: input.taskId,
    scope: 'campaign',
    taskType: 'initial_research',
    content: summaryContent,
    summary: `Initial research summary for ${job.inputUrl}`,
    confidence: 0.8,
    metadata: {
      productType: job.productType,
      recommendedCount: recommendedAssets.length,
    },
  })

  const channelMemoryIds: string[] = []
  for (const asset of recommendedAssets) {
    const score = asset.criticScore ? Number(asset.criticScore) : null
    const confidence =
      score !== null && Number.isFinite(score)
        ? Math.max(0, Math.min(1, score / 100))
        : 0.6

    const reasoningHead = asset.criticReasoning?.slice(0, 600) ?? 'No critic reasoning recorded.'
    const contentSnippet = JSON.stringify(asset.content).slice(0, 800)

    const memoryContent = [
      `Channel ${asset.channel} recommended style "${asset.styleLabel ?? 'unknown'}" (version ${asset.version}).`,
      `Critic reasoning: ${reasoningHead}`,
      `Content snippet: ${contentSnippet}`,
    ].join('\n')

    const id = await createMemory({
      userId: job.userId,
      campaignId: input.campaignId,
      jobId: input.jobId,
      sourceType: 'critic_recommendation',
      sourceId: `${asset.channel}:${asset.version}`,
      scope: 'channel',
      channel: asset.channel,
      taskType: 'writer',
      content: memoryContent,
      summary: `Recommended ${asset.styleLabel ?? 'unknown'} style for ${asset.channel}`,
      confidence,
      metadata: {
        version: asset.version,
        styleLabel: asset.styleLabel,
        criticScore: score,
      },
    })
    channelMemoryIds.push(id)
  }

  return { campaignMemoryId, channelMemoryIds }
}
