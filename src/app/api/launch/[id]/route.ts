import { NextResponse } from 'next/server'
import { db } from '@/lib/db/client'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/launch/[id]
 * Snapshot of the job + ordered decision logs.
 * Used by the dashboard for the initial render before SSE attaches.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  const job = await db.query.jobs.findFirst({
    where: (j, { eq }) => eq(j.id, id),
  })
  if (!job) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 })
  }

  const logs = await db.query.decisionLogs.findMany({
    where: (d, { eq }) => eq(d.jobId, id),
    orderBy: (d, { asc }) => [asc(d.createdAt)],
  })

  const analysis = await db.query.analyses.findFirst({
    where: (a, { eq }) => eq(a.jobId, id),
  })

  return NextResponse.json({ job, logs, analysis })
}
