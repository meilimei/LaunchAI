/**
 * Model routing configuration.
 *
 * Default model is DeepSeek V4 Pro — frontier-class reasoning at a fraction of
 * the price of GPT-4o / Sonnet, 1M context, OpenAI-compatible API, and
 * thinking mode on by default (reasoning_effort=high).
 * See https://api-docs.deepseek.com/news/news260424
 *
 * Override via env vars at runtime (LLM_*_MODEL).
 *
 * Pricing (USD per 1M tokens, as of 2026-05, full list price — V4-Pro has a
 * 75% promo until 2026-05-31, not reflected here):
 *   deepseek-v4-pro         input $0.145 / output $3.48   (1M ctx, thinking)
 *   deepseek-v4-flash       input $0.14  / output $0.28   (1M ctx, thinking)
 *   gpt-4o-mini             input $0.15  / output $0.60   (legacy fallback)
 *   gpt-4o                  input $2.50  / output $10.00  (legacy fallback)
 *   claude-sonnet-4-5       input $3.00  / output $15.00  (legacy fallback)
 *   deepseek-chat           input $0.27  / output $1.10   (legacy alias → v4-flash)
 *   deepseek-reasoner       input $0.55  / output $2.19   (legacy alias → v4-flash)
 *
 * Default routing picks based on which provider keys are configured:
 *   - DeepSeek configured     → deepseek-v4-pro for everything (preferred path)
 *   - OpenAI + Anthropic only → mini for extract/critic, Sonnet for writer
 *   - OpenAI only             → gpt-4o-mini for everything
 *
 * Note on thinking mode: DeepSeek V4 runs thinking=enabled, effort=high by
 * default. The API silently ignores `temperature`, `top_p`, `presence_penalty`,
 * and `frequency_penalty` in thinking mode, so our `temperature: 0.2` calls
 * for extraction still work but are no-ops for the model.
 */

export type LLMProvider = 'openai' | 'anthropic' | 'deepseek'

export interface ModelSpec {
  provider: LLMProvider
  modelId: string
  inputCostPer1M: number
  outputCostPer1M: number
}

const MODELS: Record<string, ModelSpec> = {
  // --- DeepSeek V4 (default path) ---
  'deepseek-v4-pro': {
    provider: 'deepseek',
    modelId: 'deepseek-v4-pro',
    inputCostPer1M: 0.145,
    outputCostPer1M: 3.48,
  },
  'deepseek-v4-flash': {
    provider: 'deepseek',
    modelId: 'deepseek-v4-flash',
    inputCostPer1M: 0.14,
    outputCostPer1M: 0.28,
  },

  // --- Legacy / fallback ---
  'gpt-4o-mini': {
    provider: 'openai',
    modelId: 'gpt-4o-mini',
    inputCostPer1M: 0.15,
    outputCostPer1M: 0.6,
  },
  'gpt-4o': {
    provider: 'openai',
    modelId: 'gpt-4o',
    inputCostPer1M: 2.5,
    outputCostPer1M: 10.0,
  },
  'claude-sonnet-4-5': {
    provider: 'anthropic',
    modelId: 'claude-sonnet-4-5',
    inputCostPer1M: 3.0,
    outputCostPer1M: 15.0,
  },
  // Legacy DeepSeek aliases — deprecated 2026-07-24, server-side route to v4-flash.
  'deepseek-chat': {
    provider: 'deepseek',
    modelId: 'deepseek-chat',
    inputCostPer1M: 0.27,
    outputCostPer1M: 1.1,
  },
  'deepseek-reasoner': {
    provider: 'deepseek',
    modelId: 'deepseek-reasoner',
    inputCostPer1M: 0.55,
    outputCostPer1M: 2.19,
  },
}

export type AgentRole = 'analyst' | 'competitor' | 'writer' | 'critic' | 'extractor'

/**
 * A key counts as "configured" only if it looks like a real key.
 * Rejects empty values and obvious placeholders copied from .env.example
 * (e.g. `sk-...`, `<token>`, `your_key_here`). This avoids the trap where
 * an unedited `OPENAI_API_KEY=sk-...` poisons the routing and the call
 * fails downstream with the provider's own "Incorrect API key" error.
 */
function hasRealKey(value: string | undefined): boolean {
  if (!value) return false
  const v = value.trim()
  if (v.length < 10) return false
  if (v.includes('...')) return false
  if (v.includes('<') || v.includes('>')) return false
  if (/^(your[_-].*[_-](key|here)|placeholder|changeme|example)$/i.test(v)) return false
  return true
}

/**
 * Computed lazily so tests/runtime env changes are honored,
 * and so the module load order doesn't matter.
 *
 * Priority: DeepSeek V4 Pro wins for every role whenever configured. V4-Pro
 * is cheaper than gpt-4o and comparable in quality to Sonnet 4.5 with a 1M
 * context, so it dominates the analyst / writer / critic / extractor roles.
 *
 * Thinking-mode handling — important nuance:
 *   DeepSeek V4 has thinking enabled by default. That's great for the writer
 *   (CoT improves copy quality, no parsing) but actively breaks
 *   `generateObject` because thinking eats the maxTokens budget before any
 *   content is emitted. The fix lives in `client.ts`: `generateStructured`
 *   defaults `disableThinking: true` and a fetch interceptor injects
 *   `thinking: { type: 'disabled' }` into the request body. So routing can
 *   safely use V4-Pro everywhere; the call layer flips thinking off where
 *   needed.
 */
function pickDefaultRouting(): Record<AgentRole, string> {
  const hasOpenAI = hasRealKey(process.env.OPENAI_API_KEY)
  const hasAnthropic = hasRealKey(process.env.ANTHROPIC_API_KEY)
  const hasDeepSeek = hasRealKey(process.env.DEEPSEEK_API_KEY)

  // Preferred path: DeepSeek V4 Pro for every role.
  if (hasDeepSeek) {
    return {
      analyst: 'deepseek-v4-pro',
      competitor: 'deepseek-v4-pro',
      extractor: 'deepseek-v4-pro',
      writer: 'deepseek-v4-pro',
      critic: 'deepseek-v4-pro',
    }
  }

  // OpenAI without Anthropic — downgrade writer to mini (avoid breakage).
  if (hasOpenAI && !hasAnthropic) {
    return {
      analyst: 'gpt-4o-mini',
      competitor: 'gpt-4o-mini',
      extractor: 'gpt-4o-mini',
      writer: 'gpt-4o-mini',
      critic: 'gpt-4o-mini',
    }
  }

  // OpenAI + Anthropic — quality writer via Sonnet, mini for extraction.
  return {
    analyst: 'gpt-4o-mini',
    competitor: 'gpt-4o-mini',
    extractor: 'gpt-4o-mini',
    writer: 'claude-sonnet-4-5',
    critic: 'gpt-4o-mini',
  }
}

/**
 * Resolve which model an agent role should use.
 * Free-tier users are routed to cheaper models everywhere.
 */
export function resolveModel(role: AgentRole, opts?: { freeTier?: boolean }): ModelSpec {
  const envOverride =
    role === 'analyst'
      ? process.env.LLM_ANALYST_MODEL
      : role === 'writer'
        ? process.env.LLM_WRITER_MODEL
        : role === 'critic'
          ? process.env.LLM_CRITIC_MODEL
          : undefined

  const defaults = pickDefaultRouting()
  let key = envOverride ?? defaults[role]

  if (opts?.freeTier && role === 'writer') {
    // Free-tier: pick cheapest available writer model.
    // V4-Flash is ~12x cheaper on output than V4-Pro and still runs with
    // thinking enabled, so it's the preferred free-tier writer.
    key = hasRealKey(process.env.DEEPSEEK_API_KEY)
      ? 'deepseek-v4-flash'
      : 'gpt-4o-mini'
  }

  const spec = MODELS[key]
  if (!spec) {
    throw new Error(`Unknown model key: ${key}`)
  }
  return spec
}

export function estimateCostUsd(spec: ModelSpec, tokensIn: number, tokensOut: number): number {
  return (
    (tokensIn / 1_000_000) * spec.inputCostPer1M +
    (tokensOut / 1_000_000) * spec.outputCostPer1M
  )
}

/**
 * Direct lookup by model key. Throws if unknown.
 * Used when a caller wants to override role-based routing.
 */
export function getModelByKey(key: string): ModelSpec {
  const spec = MODELS[key]
  if (!spec) {
    throw new Error(
      `Unknown model key: ${key}. Available: ${Object.keys(MODELS).join(', ')}`,
    )
  }
  return spec
}
