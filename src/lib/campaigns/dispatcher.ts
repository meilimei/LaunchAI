import { eq, sql } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { tasks } from '@/lib/db/schema'
import { runOrchestrator } from '@/lib/agents/orchestrator'
import type { CampaignTaskJobData, LaunchJobData, LaunchQueueData } from '@/lib/queue/jobs'
import { writeInitialResearchMemory } from './memory'

export interface DispatchResult {
  type: string
  status: 'completed' | 'failed'
  jobId?: string
  taskId?: string
  campaignId?: string
  durationMs?: number
  totalCostUsd?: number
  error?: string
}

function isCampaignTask(data: LaunchQueueData): data is CampaignTaskJobData {
  return 'taskId' in data && 'campaignId' in data && 'type' in data
}

async function runLegacyLaunchJob(data: LaunchJobData): Promise<DispatchResult> {
  const result = await runOrchestrator({ jobId: data.jobId })
  if (result.status === 'failed') {
    return {
      type: 'launch',
      status: 'failed',
      jobId: data.jobId,
      durationMs: result.durationMs,
      totalCostUsd: result.totalCostUsd,
      error: result.error,
    }
  }

  return {
    type: 'launch',
    status: 'completed',
    jobId: data.jobId,
    durationMs: result.durationMs,
    totalCostUsd: result.totalCostUsd,
  }
}

async function runInitialResearchTask(data: CampaignTaskJobData): Promise<DispatchResult> {
  if (!data.jobId) {
    throw new Error(`Campaign task ${data.taskId} is missing jobId`)
  }

  await db
    .update(tasks)
    .set({
      status: 'running',
      startedAt: new Date(),
      attempts: sql`${tasks.attempts} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, data.taskId))

  const result = await runOrchestrator({ jobId: data.jobId })

  if (result.status === 'failed') {
    await db
      .update(tasks)
      .set({
        status: 'failed',
        error: result.error ?? 'Initial research failed',
        completedAt: new Date(),
        output: {
          jobId: data.jobId,
          status: result.status,
          durationMs: result.durationMs,
          totalCostUsd: result.totalCostUsd,
          error: result.error,
        },
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, data.taskId))

    return {
      type: data.type,
      status: 'failed',
      taskId: data.taskId,
      campaignId: data.campaignId,
      jobId: data.jobId,
      durationMs: result.durationMs,
      totalCostUsd: result.totalCostUsd,
      error: result.error,
    }
  }

  await db
    .update(tasks)
    .set({
      status: 'completed',
      completedAt: new Date(),
      output: {
        jobId: data.jobId,
        status: result.status,
        durationMs: result.durationMs,
        totalCostUsd: result.totalCostUsd,
      },
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, data.taskId))

  await writeInitialResearchMemory({
    campaignId: data.campaignId,
    jobId: data.jobId,
    taskId: data.taskId,
  })

  return {
    type: data.type,
    status: 'completed',
    taskId: data.taskId,
    campaignId: data.campaignId,
    jobId: data.jobId,
    durationMs: result.durationMs,
    totalCostUsd: result.totalCostUsd,
  }
}

export async function dispatchQueueJob(data: LaunchQueueData): Promise<DispatchResult> {
  if (!isCampaignTask(data)) {
    return runLegacyLaunchJob(data)
  }

  switch (data.type) {
    case 'initial_research':
      return runInitialResearchTask(data)
    default:
      throw new Error(`Unsupported campaign task type: ${data.type}`)
  }
}
