import { z } from 'zod'
import { generateStructured } from '@/lib/llm/client'

const Schema = z.object({
  tool: z.literal('finish'),
  success: z.boolean(),
  summary: z.string(),
})

const result = await generateStructured(
  'extractor',
  Schema,
  'Return one JSON object: tool finish, success true, summary ok.',
  { maxTokens: 120, temperature: 0.1, retries: 0 },
)

console.log(JSON.stringify(result, null, 2))
