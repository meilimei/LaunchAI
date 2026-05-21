import { and, desc, eq, isNull, or } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { db } from '@/lib/db/client'
import { memories } from '@/lib/db/schema'
import type { Memory } from '@/lib/db/schema'

export interface CreateMemoryInput {
  userId: string
  campaignId?: string | null
  jobId?: string | null
  sourceType: string
  sourceId?: string | null
  scope?: string
  channel?: string | null
  taskType?: string | null
  content: string
  summary?: string | null
  confidence?: number
  metadata?: Record<string, unknown>
}

export interface RetrieveMemoriesInput {
  userId: string
  campaignId?: string | null
  channel?: string | null
  taskType?: string | null
  scope?: string
  limit?: number
}

export async function createMemory(input: CreateMemoryInput): Promise<string> {
  const id = nanoid()

  await db.insert(memories).values({
    id,
    userId: input.userId,
    campaignId: input.campaignId ?? null,
    jobId: input.jobId ?? null,
    sourceType: input.sourceType,
    sourceId: input.sourceId ?? null,
    scope: input.scope ?? 'campaign',
    channel: input.channel ?? null,
    taskType: input.taskType ?? null,
    content: input.content,
    summary: input.summary ?? null,
    confidence: (input.confidence ?? 0.5).toFixed(3),
    metadata: input.metadata ?? null,
  })

  return id
}

export async function retrieveMemories(input: RetrieveMemoriesInput): Promise<Memory[]> {
  const filters = [eq(memories.userId, input.userId)]

  if (input.campaignId) {
    filters.push(or(eq(memories.campaignId, input.campaignId), isNull(memories.campaignId))!)
  }

  if (input.scope) {
    filters.push(eq(memories.scope, input.scope))
  }

  if (input.channel) {
    filters.push(or(eq(memories.channel, input.channel), isNull(memories.channel))!)
  }

  if (input.taskType) {
    filters.push(or(eq(memories.taskType, input.taskType), isNull(memories.taskType))!)
  }

  return db
    .select()
    .from(memories)
    .where(and(...filters))
    .orderBy(desc(memories.confidence), desc(memories.createdAt))
    .limit(input.limit ?? 8)
}
