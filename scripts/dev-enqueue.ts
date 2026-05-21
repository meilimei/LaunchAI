/**
 * Dev-only helper: create a synthetic user + job, then enqueue a pipeline run.
 *
 * Usage:
 *   pnpm dev:enqueue https://chromewebstore.google.com/detail/<id>
 *   pnpm dev:enqueue          # uses a default test URL
 *
 * Prerequisites:
 *   - Postgres + Redis running (pnpm docker:up)
 *   - Schema pushed (pnpm db:push)
 *   - .env.local has OPENAI_API_KEY (and optionally ANTHROPIC_API_KEY)
 *   - Worker running in another terminal (pnpm dev:worker)
 *
 * The script prints the job id; the worker picks it up and runs the pipeline.
 * Watch the worker terminal for decision logs.
 */
import { db } from '@/lib/db/client'
import { users } from '@/lib/db/schema'
import { createInitialCampaign } from '@/lib/campaigns/create'
import { detectUrl } from '@/lib/crawl/url'
import { enqueueCampaignTask } from '@/lib/queue/jobs'

const DEFAULT_URL =
  'https://chromewebstore.google.com/detail/grammarly-ai-writing-assi/kbfnbcaeplbcioakkpcpgfkobkghlhen'

async function main() {
  const url = process.argv[2] ?? DEFAULT_URL

  const userId = 'dev-user'
  const urlInfo = detectUrl(url)

  // Upsert dev user.
  await db
    .insert(users)
    .values({
      id: userId,
      email: 'dev@launchai.local',
      plan: 'pro',
    })
    .onConflictDoNothing({ target: users.id })

  const { campaignId, jobId, taskId } = await createInitialCampaign({
    userId,
    productUrl: url,
    productType: urlInfo.productType,
  })

  await enqueueCampaignTask({
    taskId,
    campaignId,
    jobId,
    type: 'initial_research',
  })

  console.log('Enqueued campaign task:')
  console.log(`  campaignId: ${campaignId}`)
  console.log(`  taskId:     ${taskId}`)
  console.log(`  jobId:      ${jobId}`)
  console.log(`  url:        ${url}`)
  console.log('\nWatch the worker terminal for decision logs.')
  console.log('Inspect with:')
  console.log(`  pnpm db:studio  → jobs / decision_logs / analyses tables`)

  // Allow the queue add to flush before exiting.
  setTimeout(() => process.exit(0), 500)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
