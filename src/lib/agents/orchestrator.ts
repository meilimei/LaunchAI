import { eq, sql } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { analyses, competitors, jobs } from '@/lib/db/schema'
import { nanoid } from 'nanoid'
import type {
  AgentContext,
  CrawlerOutput,
  AnalystOutput,
  WriterOutput,
  CriticOutput,
  SchedulerOutput,
} from './types'
import { makeEmitter } from './emitter'
import { crawlerAgent } from './crawler'
import { analystAgent } from './analyst'
import { writerAgent } from './writer'
import { criticAgent } from './critic'
import { schedulerAgent } from './scheduler'

/**
 * Orchestrator: the deterministic DAG that wires agents together.
 *
 * Pipeline (current):
 *   Crawler → Analyst → Writer (6 channels × 3 versions) → Critic → Scheduler
 *
 * Why deterministic vs. ReAct loop:
 *   - Predictable cost (~$0.45/run)
 *   - Predictable latency (~2-5 min)
 *   - Easier to visualize in the dashboard
 *   - Each step is independently retryable
 *
 * The "autonomous feel" comes from the UI layer streaming decision events.
 */

export interface OrchestratorInput {
  jobId: string
}

export interface OrchestratorResult {
  jobId: string
  status: 'completed' | 'failed'
  totalCostUsd: number
  durationMs: number
  error?: string
}

export async function runOrchestrator(
  input: OrchestratorInput,
): Promise<OrchestratorResult> {
  const startedAt = Date.now()
  const { jobId } = input

  // Load job from DB.
  const job = await db.query.jobs.findFirst({
    where: (j, { eq }) => eq(j.id, jobId),
  })
  if (!job) {
    throw new Error(`Job not found: ${jobId}`)
  }

  let totalCostUsd = 0
  const baseEmit = makeEmitter(jobId)
  const emit: AgentContext['emit'] = async (event) => {
    if (typeof event.costUsd === 'number' && Number.isFinite(event.costUsd)) {
      totalCostUsd += event.costUsd
    }
    await baseEmit(event)
  }
  const ctx: AgentContext = { job, emit }

  try {
    // Mark started.
    await db
      .update(jobs)
      .set({ status: 'crawling', startedAt: new Date() })
      .where(eq(jobs.id, jobId))

    await emit({
      agent: 'orchestrator',
      step: 'pipeline_start',
      inputSummary: job.inputUrl,
      outputSummary: 'Starting Crawler → Analyst → Writer → Critic → Scheduler pipeline',
    })

    // ---------- Step 1: Crawler ----------
    const crawlerOut: CrawlerOutput = await crawlerAgent.run(ctx)
    ctx.crawl = crawlerOut

    // Persist competitors discovered (we'll re-use these in Phase B-2).
    if (crawlerOut.competitors.length > 0) {
      await db.insert(competitors).values(
        crawlerOut.competitors.map((c) => ({
          id: nanoid(),
          jobId,
          competitorUrl: c.url,
          name: c.name ?? null,
          listing: c.raw ? { ...c.raw, rawHtml: undefined } : null,
        })),
      )
    }

    await db
      .update(jobs)
      .set({ status: 'analyzing', productType: crawlerOut.productType })
      .where(eq(jobs.id, jobId))

    // ---------- Step 2: Analyst ----------
    const analystOut: AnalystOutput = await analystAgent.run(ctx)
    ctx.analysis = analystOut

    // Persist analysis row.
    await db.insert(analyses).values({
      id: nanoid(),
      jobId,
      features: analystOut.features,
      painPoints: analystOut.painPoints,
      keywords: analystOut.keywords,
      tone: analystOut.tone,
      reviewsSummary: analystOut.reviewsSummary ?? null,
    })

    await db
      .update(jobs)
      .set({ status: 'generating' })
      .where(eq(jobs.id, jobId))

    // ---------- Step 3: Writer (6 channels × 3 versions) ----------
    const writerOut: WriterOutput[] = await writerAgent.run(ctx)
    ctx.assets = writerOut

    await db
      .update(jobs)
      .set({ status: 'critiquing' })
      .where(eq(jobs.id, jobId))

    // ---------- Step 4: Critic (score + recommend) ----------
    const criticOut: CriticOutput = await criticAgent.run(ctx)
    ctx.critic = criticOut

    await db
      .update(jobs)
      .set({ status: 'scheduling' })
      .where(eq(jobs.id, jobId))

    // ---------- Step 5: Scheduler (deterministic, no LLM) ----------
    const schedulerOut: SchedulerOutput = await schedulerAgent.run(ctx)

    // ---------- Done ----------
    const durationMs = Date.now() - startedAt
    const totalChannels = writerOut.length
    const totalVersions = writerOut.reduce((acc, c) => acc + c.versions.length, 0)
    const recommendedCount = Object.keys(criticOut.byChannel).length

    await emit({
      agent: 'orchestrator',
      step: 'pipeline_complete',
      outputSummary: `Done in ${(durationMs / 1000).toFixed(1)}s — ${totalVersions} versions × ${totalChannels} channels, ${recommendedCount} picks, ${schedulerOut.schedule.length} scheduled.`,
      durationMs,
    })

    await db
      .update(jobs)
      .set({
        status: 'completed',
        completedAt: new Date(),
        totalCostUsd: sql`${jobs.totalCostUsd} + ${totalCostUsd.toFixed(4)}`,
      })
      .where(eq(jobs.id, jobId))

    return {
      jobId,
      status: 'completed',
      totalCostUsd,
      durationMs,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[orchestrator] Job ${jobId} failed:`, err)

    await emit({
      agent: 'orchestrator',
      step: 'pipeline_error',
      status: 'error',
      error: message,
    })

    await db
      .update(jobs)
      .set({
        status: 'failed',
        completedAt: new Date(),
        error: message,
      })
      .where(eq(jobs.id, jobId))

    return {
      jobId,
      status: 'failed',
      totalCostUsd,
      durationMs: Date.now() - startedAt,
      error: message,
    }
  }
}
