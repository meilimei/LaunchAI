import { nanoid } from 'nanoid'
import { db } from '@/lib/db/client'
import { campaignPhases, campaigns, jobs, tasks } from '@/lib/db/schema'
import type { NewCampaign } from '@/lib/db/schema'

export interface CreateInitialCampaignInput {
  userId: string
  productUrl: string
  productType: NewCampaign['productType']
  goal?: string
  autopilotLevel?: NewCampaign['autopilotLevel']
  riskPolicy?: NewCampaign['riskPolicy']
}

export interface CreateInitialCampaignResult {
  campaignId: string
  jobId: string
  taskId: string
}

const addDays = (date: Date, days: number) => {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

export async function createInitialCampaign(
  input: CreateInitialCampaignInput,
): Promise<CreateInitialCampaignResult> {
  const campaignId = nanoid()
  const jobId = nanoid()
  const taskId = nanoid()
  const startedAt = new Date()
  const endsAt = addDays(startedAt, 90)

  await db.transaction(async (tx) => {
    await tx.insert(campaigns).values({
      id: campaignId,
      userId: input.userId,
      productUrl: input.productUrl,
      productType: input.productType,
      goal: input.goal ?? '90_day_product_led_growth',
      autopilotLevel: input.autopilotLevel ?? 'full_autopilot',
      riskPolicy: input.riskPolicy ?? 'balanced',
      startedAt,
      endsAt,
    })

    await tx.insert(campaignPhases).values([
      {
        id: nanoid(),
        campaignId,
        phase: 'research',
        status: 'active',
        startsAt: startedAt,
        endsAt: addDays(startedAt, 2),
      },
      {
        id: nanoid(),
        campaignId,
        phase: 'launch',
        status: 'pending',
        startsAt: addDays(startedAt, 2),
        endsAt: addDays(startedAt, 7),
      },
      {
        id: nanoid(),
        campaignId,
        phase: 'amplify',
        status: 'pending',
        startsAt: addDays(startedAt, 7),
        endsAt: addDays(startedAt, 30),
      },
      {
        id: nanoid(),
        campaignId,
        phase: 'compound',
        status: 'pending',
        startsAt: addDays(startedAt, 30),
        endsAt: addDays(startedAt, 60),
      },
      {
        id: nanoid(),
        campaignId,
        phase: 'optimize',
        status: 'pending',
        startsAt: addDays(startedAt, 60),
        endsAt,
      },
    ])

    await tx.insert(jobs).values({
      id: jobId,
      userId: input.userId,
      campaignId,
      status: 'queued',
      inputUrl: input.productUrl,
      productType: input.productType,
    })

    await tx.insert(tasks).values({
      id: taskId,
      campaignId,
      jobId,
      type: 'initial_research',
      status: 'queued',
      input: {
        productUrl: input.productUrl,
        productType: input.productType,
      },
    })
  })

  return { campaignId, jobId, taskId }
}
