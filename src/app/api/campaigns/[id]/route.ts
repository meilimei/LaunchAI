import { NextResponse } from 'next/server'
import { asc, desc, eq } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import {
  actions,
  campaignPhases,
  campaigns,
  jobs,
  platformPosts,
  tasks,
} from '@/lib/db/schema'
import { ensureDevUser } from '@/lib/dev-user'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/campaigns/[id]
 * Returns a campaign with its phases, recent tasks, jobs, actions, and posts.
 *
 * Used by the upcoming campaign dashboard. Returns 404 if the campaign
 * doesn't belong to the current dev user.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const userId = await ensureDevUser()

  const [campaign] = await db
    .select()
    .from(campaigns)
    .where(eq(campaigns.id, id))
    .limit(1)

  if (!campaign || campaign.userId !== userId) {
    return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })
  }

  const [phases, campaignTasks, campaignJobs, campaignActions, campaignPosts] =
    await Promise.all([
      db
        .select()
        .from(campaignPhases)
        .where(eq(campaignPhases.campaignId, id))
        .orderBy(asc(campaignPhases.startsAt)),
      db
        .select()
        .from(tasks)
        .where(eq(tasks.campaignId, id))
        .orderBy(desc(tasks.createdAt))
        .limit(50),
      db
        .select({
          id: jobs.id,
          status: jobs.status,
          inputUrl: jobs.inputUrl,
          totalCostUsd: jobs.totalCostUsd,
          startedAt: jobs.startedAt,
          completedAt: jobs.completedAt,
          createdAt: jobs.createdAt,
        })
        .from(jobs)
        .where(eq(jobs.campaignId, id))
        .orderBy(desc(jobs.createdAt))
        .limit(20),
      db
        .select()
        .from(actions)
        .where(eq(actions.campaignId, id))
        .orderBy(desc(actions.createdAt))
        .limit(50),
      db
        .select()
        .from(platformPosts)
        .where(eq(platformPosts.campaignId, id))
        .orderBy(desc(platformPosts.createdAt))
        .limit(50),
    ])

  return NextResponse.json({
    campaign,
    phases,
    tasks: campaignTasks,
    jobs: campaignJobs,
    actions: campaignActions,
    platformPosts: campaignPosts,
  })
}
