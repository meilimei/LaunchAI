import { NextResponse } from 'next/server'
import { desc, eq } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { campaigns } from '@/lib/db/schema'
import { ensureDevUser } from '@/lib/dev-user'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/campaigns
 * List the dev user's campaigns ordered by creation desc.
 *
 * Phase C-1: scoped to dev user. Phase C-2 (Clerk): scope by Clerk userId.
 */
export async function GET() {
  const userId = await ensureDevUser()

  const rows = await db
    .select({
      id: campaigns.id,
      productUrl: campaigns.productUrl,
      productType: campaigns.productType,
      status: campaigns.status,
      goal: campaigns.goal,
      autopilotLevel: campaigns.autopilotLevel,
      riskPolicy: campaigns.riskPolicy,
      startedAt: campaigns.startedAt,
      endsAt: campaigns.endsAt,
      completedAt: campaigns.completedAt,
      createdAt: campaigns.createdAt,
    })
    .from(campaigns)
    .where(eq(campaigns.userId, userId))
    .orderBy(desc(campaigns.createdAt))
    .limit(50)

  return NextResponse.json({ campaigns: rows })
}
