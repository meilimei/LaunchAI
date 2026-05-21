import { nanoid } from 'nanoid'
import { db } from '@/lib/db/client'
import { decisionLogs } from '@/lib/db/schema'
import { redis, jobEventsChannel } from '@/lib/queue/connection'
import type { DecisionEvent, AgentContext } from './types'

/**
 * The "decision emitter" is what makes LaunchAI's UX feel autonomous.
 *
 * Every agent step calls emit({ ... }):
 *   1. Persist a row in decision_logs (durable timeline)
 *   2. Publish a JSON event to Redis pubsub (real-time SSE stream)
 *
 * The frontend dashboard subscribes to the SSE stream to render the
 * timeline as it happens, and re-hydrates from decision_logs on reload.
 *
 * Failure mode: a failed emit must NEVER crash the pipeline.
 * We log to console and keep going — decision logs are an observability
 * feature, not a correctness feature.
 */

export interface EmitOptions {
  /** Minimum log level to forward to Redis pubsub. Default: all. */
  pubsub?: boolean
}

/**
 * Build an `emit` function bound to a job id.
 * Used by the orchestrator when constructing AgentContext.
 */
export function makeEmitter(jobId: string): AgentContext['emit'] {
  return async function emit(evt) {
    const id = nanoid()
    const fullEvent: DecisionEvent & { id: string; createdAt: string } = {
      id,
      jobId,
      createdAt: new Date().toISOString(),
      status: 'ok',
      ...evt,
    }

    // 1. Persist to Postgres (best-effort).
    try {
      await db.insert(decisionLogs).values({
        id,
        jobId,
        agent: evt.agent,
        step: evt.step,
        inputSummary: evt.inputSummary ?? null,
        outputSummary: evt.outputSummary ?? null,
        reasoning: evt.reasoning ?? null,
        rawInput: (evt.rawInput as object | undefined) ?? null,
        rawOutput: (evt.rawOutput as object | undefined) ?? null,
        model: evt.model ?? null,
        tokensIn: evt.tokensIn ?? null,
        tokensOut: evt.tokensOut ?? null,
        costUsd: evt.costUsd != null ? evt.costUsd.toFixed(6) : null,
        durationMs: evt.durationMs ?? null,
        status: evt.status ?? 'ok',
        error: evt.error ?? null,
      })
    } catch (err) {
      console.error('[emitter] Failed to persist decision_log:', err)
    }

    // 2. Publish to Redis pubsub for SSE consumers (best-effort).
    try {
      // Strip raw_input / raw_output from the live stream — too big for SSE.
      // Frontend can fetch full payload on demand via the API.
      const slim = { ...fullEvent }
      delete slim.rawInput
      delete slim.rawOutput
      await redis.publish(jobEventsChannel(jobId), JSON.stringify(slim))
    } catch (err) {
      console.error('[emitter] Failed to publish to Redis:', err)
    }
  }
}
