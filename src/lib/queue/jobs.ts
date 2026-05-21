import { Queue, type JobsOptions } from 'bullmq'
import { redis } from './connection'

export const QUEUE_NAME = 'launchai-pipeline'

export interface LaunchJobData {
  jobId: string
  userId: string
  inputUrl: string
}

export interface CampaignTaskJobData {
  taskId: string
  campaignId: string
  jobId?: string
  type: string
}

export type LaunchQueueData = LaunchJobData | CampaignTaskJobData

export const launchQueue = new Queue<LaunchQueueData>(QUEUE_NAME, {
  connection: redis,
  defaultJobOptions: {
    attempts: 1,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { age: 24 * 3600, count: 1000 },
    removeOnFail: { age: 7 * 24 * 3600 },
  },
})

export async function enqueueLaunchJob(
  data: LaunchJobData,
  opts?: JobsOptions,
): Promise<string> {
  const job = await launchQueue.add('launch', data, opts)
  return job.id ?? data.jobId
}

export async function enqueueCampaignTask(
  data: CampaignTaskJobData,
  opts?: JobsOptions,
): Promise<string> {
  const job = await launchQueue.add(data.type, data, opts)
  return job.id ?? data.taskId
}
