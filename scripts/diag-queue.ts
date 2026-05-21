/**
 * One-shot BullMQ queue inspector.
 *
 * Run: pnpm diag:queue
 *
 * Prints job counts and the first ~20 jobs in waiting / active / delayed / failed.
 * Used to diagnose "stuck in Queued" cases — verifies the worker is actually
 * connected to the same Redis + queue name as the web process.
 */
import { Queue } from 'bullmq'
import { Redis } from 'ioredis'
import { QUEUE_NAME } from '@/lib/queue/jobs'

async function main() {
  const url = process.env.REDIS_URL
  if (!url) throw new Error('REDIS_URL missing')

  const u = new URL(url)
  const conn = new Redis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: false,
    family: 0,
    ...(u.protocol === 'rediss:' ? { tls: { servername: u.hostname } } : {}),
  })

  const q = new Queue(QUEUE_NAME, { connection: conn })

  console.log(`[diag-queue] queue = ${QUEUE_NAME}`)
  console.log(`[diag-queue] redis = ${u.protocol}//${u.hostname}:${u.port}`)

  const counts = await q.getJobCounts(
    'waiting',
    'active',
    'delayed',
    'failed',
    'completed',
    'paused',
    'waiting-children',
    'prioritized',
  )
  console.log('[diag-queue] counts:', counts)

  for (const s of ['waiting', 'active', 'delayed', 'failed'] as const) {
    const jobs = await q.getJobs([s], 0, 20, true)
    console.log(`\n[diag-queue] ${s} (${jobs.length}):`)
    for (const j of jobs) {
      console.log(
        ` - id=${j.id} name=${j.name} attempts=${j.attemptsMade}` +
          ` ts=${new Date(j.timestamp).toISOString()}` +
          (j.processedOn ? ` processedOn=${new Date(j.processedOn).toISOString()}` : '') +
          (j.failedReason ? ` failed="${j.failedReason}"` : ''),
      )
      console.log(`   data=`, j.data)
    }
  }

  // Active workers reported to the queue.
  const workers = await q.getWorkers()
  console.log(`\n[diag-queue] active workers (${workers.length}):`)
  for (const w of workers) {
    console.log(` - name=${w.name} addr=${w.addr} age=${w.age}s idle=${w.idle}s`)
  }

  await q.close()
  await conn.quit()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
