/**
 * BullMQ worker entry point.
 *
 * Run via:  pnpm dev:worker  (watch mode)
 *          pnpm start:worker (prod)
 *
 * Phase A: Skeleton only. The actual orchestrator pipeline is wired in Phase B.
 */
import { Worker } from 'bullmq'
import { redis } from '@/lib/queue/connection'
import { QUEUE_NAME, type LaunchQueueData } from '@/lib/queue/jobs'
import { dispatchQueueJob } from '@/lib/campaigns/dispatcher'

const worker = new Worker<LaunchQueueData>(
  QUEUE_NAME,
  async (job) => {
    console.log(`[worker] Picked up ${job.name} ${job.id}`)

    const result = await dispatchQueueJob(job.data)

    if (result.status === 'failed') {
      throw new Error(`${result.type} failed: ${result.error}`)
    }

    console.log(
      `[worker] ✅ ${result.type} ok in ${((result.durationMs ?? 0) / 1000).toFixed(1)}s, cost $${(result.totalCostUsd ?? 0).toFixed(4)}`,
    )
    return result
  },
  {
    connection: redis,
    concurrency: 4,
    autorun: true,
  },
)

worker.on('completed', (job) => {
  console.log(`[worker] ✅ Completed ${job.id}`)
})

worker.on('failed', (job, err) => {
  console.error(`[worker] ❌ Failed ${job?.id}:`, err)
})

worker.on('error', (err) => {
  console.error('[worker] Worker error:', err)
})

const shutdown = async (signal: string) => {
  console.log(`[worker] Received ${signal}, draining...`)
  await worker.close()
  await redis.quit()
  process.exit(0)
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

console.log('[worker] LaunchAI worker started, waiting for jobs...')
