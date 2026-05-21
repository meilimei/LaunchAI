import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createInitialCampaign } from '@/lib/campaigns/create'
import { enqueueCampaignTask } from '@/lib/queue/jobs'
import { ensureDevUser } from '@/lib/dev-user'
import { detectUrl } from '@/lib/crawl/url'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const RequestSchema = z.object({
  url: z.string().url(),
})

/**
 * POST /api/launch
 * Create a job and enqueue the pipeline. Returns the new jobId.
 *
 * Phase C-1: no auth — uses a dev user. Add Clerk in C-2.
 */
export async function POST(req: Request) {
  let body: unknown
  try {
    const ct = req.headers.get('content-type') ?? ''
    if (ct.includes('application/json')) {
      body = await req.json()
    } else {
      const form = await req.formData()
      body = { url: form.get('url') }
    }
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const parsed = RequestSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid URL', details: parsed.error.flatten().fieldErrors },
      { status: 400 },
    )
  }

  // Pre-validate URL shape (also classifies product type for the row).
  let urlInfo
  try {
    urlInfo = detectUrl(parsed.data.url)
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Bad URL' },
      { status: 400 },
    )
  }

  const userId = await ensureDevUser()

  const { campaignId, jobId, taskId } = await createInitialCampaign({
    userId,
    productUrl: parsed.data.url,
    productType: urlInfo.productType,
  })

  await enqueueCampaignTask({
    taskId,
    campaignId,
    jobId,
    type: 'initial_research',
  })

  // If the request was form-encoded (e.g., browser form POST without JS),
  // redirect to the dashboard. Otherwise return JSON for fetch() callers.
  const ct = req.headers.get('content-type') ?? ''
  if (ct.includes('application/x-www-form-urlencoded') || ct.includes('multipart/form-data')) {
    return NextResponse.redirect(new URL(`/launch/${jobId}`, req.url), 303)
  }

  return NextResponse.json({ campaignId, jobId, taskId, status: 'queued' }, { status: 201 })
}
