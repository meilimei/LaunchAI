import { createOpenAI } from '@ai-sdk/openai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createDeepSeek } from '@ai-sdk/deepseek'
import {
  generateObject,
  generateText,
  type LanguageModel,
  NoObjectGeneratedError,
} from 'ai'
import pRetry, { AbortError } from 'p-retry'
import type { z } from 'zod'
import { serverEnv } from '@/lib/env'
import {
  estimateCostUsd,
  getModelByKey,
  resolveModel,
  type AgentRole,
  type ModelSpec,
} from './config'

/**
 * Unified LLM client for all agents.
 *
 * Why this layer exists:
 *   1. Route role → model (writer→Sonnet, analyst→4o-mini)
 *   2. Track tokens + cost on every call → feeds decision_logs + cost guardrails
 *   3. Retries with backoff for transient provider errors
 *   4. Hard timeouts so a hung provider can't stall the pipeline
 *   5. Structured output via Zod schemas (single source of type safety)
 *
 * Agents NEVER import @ai-sdk/* directly — only this module.
 */

// ---------- Provider clients (lazy, singleton) ----------

let openaiClient: ReturnType<typeof createOpenAI> | null = null
let anthropicClient: ReturnType<typeof createAnthropic> | null = null
let deepseekClient: ReturnType<typeof createDeepSeek> | null = null
let deepseekClientNoThink: ReturnType<typeof createDeepSeek> | null = null

function getOpenAI() {
  if (!openaiClient) {
    if (!serverEnv.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY is not set')
    }
    openaiClient = createOpenAI({ apiKey: serverEnv.OPENAI_API_KEY })
  }
  return openaiClient
}

function getAnthropic() {
  if (!anthropicClient) {
    if (!serverEnv.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY is not set')
    }
    anthropicClient = createAnthropic({ apiKey: serverEnv.ANTHROPIC_API_KEY })
  }
  return anthropicClient
}

/**
 * Custom fetch that injects `thinking: { type: 'disabled' }` into every
 * outgoing DeepSeek chat completion request. DeepSeek V4 has thinking
 * enabled by default, which:
 *   - Adds 5-15s of latency per call
 *   - Spends 500-3000 reasoning tokens before any output content (silently
 *     truncating short-`maxTokens` responses to empty content, which then
 *     fails Vercel AI SDK's `generateObject` with "could not parse")
 *   - Provides no benefit for bounded structured-output tasks like the
 *     browser agent's tool-call selection
 *
 * The DeepSeek API exposes the toggle via `extra_body.thinking` in the
 * Python SDK, which becomes a top-level `thinking` field in the actual
 * HTTP body. We splice it in at the fetch layer because the @ai-sdk/deepseek
 * package doesn't (yet) expose it via a typed setting.
 *
 * Reference: https://api-docs.deepseek.com/guides/thinking_mode
 */
function createThinkingDisabledFetch(): typeof fetch {
  return async (url, init) => {
    if (init?.body && typeof init.body === 'string') {
      try {
        const body = JSON.parse(init.body) as Record<string, unknown>
        // Don't clobber if a caller has already set it (future-proofing).
        if (body.thinking === undefined) {
          body.thinking = { type: 'disabled' }
        }
        const newInit: RequestInit = { ...init, body: JSON.stringify(body) }
        return globalThis.fetch(url, newInit)
      } catch {
        // Body is not JSON (multipart upload, etc.) — pass through as-is.
      }
    }
    return globalThis.fetch(url, init)
  }
}

function isJsonText(text: string): boolean {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

/**
 * Find a balanced JSON object embedded in arbitrary model text.
 *
 * Scoped to objects only (`{...}`) because every schema we use for
 * `generateObject` is a top-level object or discriminated-union of objects.
 * Allowing arrays here is dangerous: a stray "[3]" in the model's prose
 * (e.g. "picking candidate [3]") would hijack the repair and produce a
 * valid-but-wrong JSON value that Zod then rejects with a hard-to-diagnose
 * error.
 *
 * Strategy: scan for the LARGEST balanced `{...}` substring, prefer fenced
 * ```json blocks first, and require it to be valid JSON before returning.
 */
function extractJsonText(text: string): string | null {
  const trimmed = text.trim()
  if (!trimmed) return null

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  if (fenced?.[1]) {
    const candidate = fenced[1].trim()
    if (candidate.startsWith('{') && isJsonText(candidate)) return candidate
  }

  // Walk every '{' position and try to close it. Track the longest balanced
  // candidate that also JSON.parses. Real model outputs are big objects, so
  // length is a good proxy for the intended payload.
  let best: string | null = null

  for (let start = 0; start < trimmed.length; start++) {
    if (trimmed[start] !== '{') continue

    let depth = 0
    let inString = false
    let escaped = false

    for (let i = start; i < trimmed.length; i++) {
      const char = trimmed[i]

      if (escaped) {
        escaped = false
        continue
      }
      if (char === '\\') {
        escaped = true
        continue
      }
      if (char === '"') {
        inString = !inString
        continue
      }
      if (inString) continue

      if (char === '{') depth++
      else if (char === '}') {
        depth--
        if (depth === 0) {
          const candidate = trimmed.slice(start, i + 1)
          if (isJsonText(candidate) && (!best || candidate.length > best.length)) {
            best = candidate
          }
          break
        }
      }
    }
  }

  return best
}

function formatNoObjectGeneratedError(err: NoObjectGeneratedError): string {
  const parts = [err.message]
  if (err.finishReason) parts.push(`finishReason=${err.finishReason}`)
  if (err.usage) {
    parts.push(
      `usage=${JSON.stringify({
        promptTokens: err.usage.promptTokens,
        completionTokens: err.usage.completionTokens,
      })}`,
    )
  }
  if (err.text !== undefined) {
    const preview = err.text.length > 1200 ? `${err.text.slice(0, 1200)}…` : err.text
    parts.push(`text=${JSON.stringify(preview)}`)
  }
  return parts.join(' | ')
}

function isTopLevelObjectSchema(schema: z.ZodTypeAny): boolean {
  return (schema as z.ZodTypeAny & { _def?: { typeName?: string } })._def?.typeName === 'ZodObject'
}

function getDeepSeek(disableThinking = false) {
  if (!serverEnv.DEEPSEEK_API_KEY) {
    throw new Error('DEEPSEEK_API_KEY is not set')
  }
  if (disableThinking) {
    if (!deepseekClientNoThink) {
      deepseekClientNoThink = createDeepSeek({
        apiKey: serverEnv.DEEPSEEK_API_KEY,
        fetch: createThinkingDisabledFetch(),
      })
    }
    return deepseekClientNoThink
  }
  if (!deepseekClient) {
    deepseekClient = createDeepSeek({ apiKey: serverEnv.DEEPSEEK_API_KEY })
  }
  return deepseekClient
}

function buildModel(spec: ModelSpec, opts?: { disableThinking?: boolean }): LanguageModel {
  if (spec.provider === 'openai') return getOpenAI()(spec.modelId)
  if (spec.provider === 'anthropic') return getAnthropic()(spec.modelId)
  if (spec.provider === 'deepseek') return getDeepSeek(opts?.disableThinking)(spec.modelId)
  throw new Error(`Unsupported provider: ${spec.provider}`)
}

// ---------- Public types ----------

export interface LLMUsage {
  model: string
  provider: string
  tokensIn: number
  tokensOut: number
  costUsd: number
  durationMs: number
}

export interface LLMResult<T> {
  data: T
  usage: LLMUsage
}

export interface LLMCallOptions {
  /** Override the role-based model routing. */
  model?: string
  /** Free-tier downgrades writer → mini. */
  freeTier?: boolean
  /** Total LLM call timeout (default 60s). */
  timeoutMs?: number
  /** Retry count on transient errors (default 2 = up to 3 attempts). */
  retries?: number
  /** Sampling temperature. Lower for extraction, higher for writing. */
  temperature?: number
  /** Max output tokens. */
  maxTokens?: number
  /** Optional system prompt prepended to user prompt. */
  system?: string
  /**
   * Disable provider-level thinking / reasoning tokens (currently DeepSeek
   * V4 only — no-op for OpenAI / Anthropic). Set true for any call where:
   *   - latency matters (per-step browser agent decisions)
   *   - structured output reliability matters (`generateObject` with a
   *     small `maxTokens` budget gets silently truncated when thinking
   *     burns through the budget before any content is emitted)
   *   - reasoning depth doesn't help (bounded tool-call selection)
   *
   * Defaults are role-aware:
   *   - `generateStructured`: defaults to true (safer for JSON output)
   *   - `generateFreeText`: defaults to false (writer benefits from CoT)
   */
  disableThinking?: boolean
}

const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_RETRIES = 2

// ---------- Error normalization ----------

/**
 * Decide which errors are worth retrying. 4xx (auth, bad request) is not.
 */
function isRetryableError(err: unknown): boolean {
  if (err instanceof AbortError) return false
  if (err instanceof NoObjectGeneratedError) return true // schema mismatch — try again
  const msg = err instanceof Error ? err.message.toLowerCase() : ''
  if (msg.includes('rate limit') || msg.includes('429')) return true
  if (msg.includes('timeout') || msg.includes('etimedout')) return true
  if (msg.includes('econnreset') || msg.includes('socket')) return true
  if (msg.includes('5')) {
    // crude 5xx detection
    if (/\b5\d{2}\b/.test(msg)) return true
  }
  return false
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`LLM timeout (${label}, ${ms}ms)`)), ms)
  })
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

// ---------- Public API ----------

/**
 * Generate a structured object validated against a Zod schema.
 * Use this for:
 *   - Analyst extraction (features, pain_points, ...)
 *   - Critic scoring
 *   - Any time the agent needs typed JSON
 */
export async function generateStructured<TSchema extends z.ZodTypeAny>(
  role: AgentRole,
  schema: TSchema,
  prompt: string,
  opts: LLMCallOptions = {},
): Promise<LLMResult<z.infer<TSchema>>> {
  const spec = opts.model
    ? getModelByKey(opts.model)
    : resolveModel(role, { freeTier: opts.freeTier })
  // Default thinking-OFF for structured output. DeepSeek V4 thinking-mode
  // routinely truncates short-`maxTokens` responses to empty content (the
  // budget is consumed by reasoning tokens before any output content), and
  // structured-output tasks rarely benefit from CoT anyway. Callers can
  // override with `disableThinking: false` if they specifically want it.
  const disableThinking = opts.disableThinking ?? true
  const model = buildModel(spec, { disableThinking })
  const startedAt = Date.now()
  const providerOptions =
    spec.provider === 'deepseek' && disableThinking
      ? { deepseek: { thinking: { type: 'disabled' } } }
      : undefined
  const repairText = async ({ text }: { text: string }) => extractJsonText(text)

  const generate = (mode: 'auto' | 'json' | 'tool') =>
    withTimeout(
      generateObject({
        model,
        schema,
        prompt,
        system: opts.system,
        temperature: opts.temperature ?? 0.2,
        maxTokens: opts.maxTokens,
        mode,
        providerOptions,
        experimental_repairText: repairText,
      }),
      opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      `${role}:generateObject:${spec.modelId}`,
    )

  const run = async () => {
    if (spec.provider === 'deepseek') {
      if (!isTopLevelObjectSchema(schema)) {
        return generate('json')
      }
      try {
        return await generate('tool')
      } catch (err) {
        const message = err instanceof Error ? err.message.toLowerCase() : ''
        if (!NoObjectGeneratedError.isInstance(err) && !message.includes('invalid schema')) throw err
        return generate('json')
      }
    }
    return generate('auto')
  }

  let result: Awaited<ReturnType<typeof generate>>
  try {
    result = await pRetry(run, {
      retries: opts.retries ?? DEFAULT_RETRIES,
      minTimeout: 1000,
      factor: 2,
      onFailedAttempt: (err) => {
        if (!isRetryableError(err)) {
          // Convert to AbortError so pRetry stops retrying.
          throw new AbortError(err.message)
        }
      },
    })
  } catch (err) {
    if (NoObjectGeneratedError.isInstance(err)) {
      throw new Error(formatNoObjectGeneratedError(err), { cause: err })
    }
    throw err
  }

  const tokensIn = result.usage?.promptTokens ?? 0
  const tokensOut = result.usage?.completionTokens ?? 0

  return {
    data: result.object,
    usage: {
      model: spec.modelId,
      provider: spec.provider,
      tokensIn,
      tokensOut,
      costUsd: estimateCostUsd(spec, tokensIn, tokensOut),
      durationMs: Date.now() - startedAt,
    },
  }
}

/**
 * Generate plain text (no schema). Used rarely — most agents need structure.
 * Reserved for short helper calls (e.g., summarize a single review).
 */
export async function generateFreeText(
  role: AgentRole,
  prompt: string,
  opts: LLMCallOptions = {},
): Promise<LLMResult<string>> {
  const spec = opts.model
    ? getModelByKey(opts.model)
    : resolveModel(role, { freeTier: opts.freeTier })
  // Default thinking-ON for free-text. The Writer is the canonical caller
  // and benefits from CoT (reasoning improves copy quality without parsing
  // risk since we don't enforce a schema).
  const disableThinking = opts.disableThinking ?? false
  const model = buildModel(spec, { disableThinking })
  const startedAt = Date.now()

  const run = async () => {
    return withTimeout(
      generateText({
        model,
        prompt,
        system: opts.system,
        temperature: opts.temperature ?? 0.5,
        maxTokens: opts.maxTokens,
      }),
      opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      `${role}:generateText:${spec.modelId}`,
    )
  }

  const result = await pRetry(run, {
    retries: opts.retries ?? DEFAULT_RETRIES,
    minTimeout: 1000,
    factor: 2,
    onFailedAttempt: (err) => {
      if (!isRetryableError(err)) {
        throw new AbortError(err.message)
      }
    },
  })

  const tokensIn = result.usage?.promptTokens ?? 0
  const tokensOut = result.usage?.completionTokens ?? 0

  return {
    data: result.text,
    usage: {
      model: spec.modelId,
      provider: spec.provider,
      tokensIn,
      tokensOut,
      costUsd: estimateCostUsd(spec, tokensIn, tokensOut),
      durationMs: Date.now() - startedAt,
    },
  }
}

