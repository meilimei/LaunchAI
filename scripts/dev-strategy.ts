/**
 * dev:strategy — run the AudienceMapper against a fixture and print
 * ranked platform recommendations + missing-platform suggestions.
 *
 * Usage:
 *   pnpm dev:strategy [fixturePath]
 *
 * Defaults to scripts/fixtures/strategy-docmask.json when no path given.
 *
 * The script does not write to the database — it is a planning oracle the
 * user runs to sanity-check campaign positioning before the supervisor
 * starts scheduling actions on platforms that will not work for their ICP.
 */
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  mapAudienceToPlatforms,
  type AudienceMapperInput,
} from '@/lib/strategy/audience-mapper'

function readFixture(path: string): AudienceMapperInput {
  const abs = resolve(process.cwd(), path)
  if (!existsSync(abs)) throw new Error(`Fixture not found: ${abs}`)
  const raw = readFileSync(abs, 'utf-8')
  const data = JSON.parse(raw) as AudienceMapperInput
  if (!data.audience || !data.product?.name) {
    throw new Error(`Fixture is missing required fields (audience, product.name) at ${abs}`)
  }
  return data
}

function fitBucket(score: number): string {
  if (score >= 0.8) return 'STRONG'
  if (score >= 0.5) return 'MODERATE'
  if (score >= 0.2) return 'WEAK'
  return 'AVOID'
}

async function main() {
  const fixturePath = process.argv[2] ?? 'scripts/fixtures/strategy-docmask.json'
  const input = readFixture(fixturePath)

  console.log(`[dev-strategy] fixture=${fixturePath}`)
  console.log(`[dev-strategy] product=${input.product.name}`)
  console.log(`[dev-strategy] audience preview: ${input.audience.slice(0, 120)}...`)
  console.log('[dev-strategy] running AudienceMapper...\n')

  const result = await mapAudienceToPlatforms(input)

  console.log('=== platform recommendations (sorted by fit) ===')
  for (const rec of result.recommendations) {
    const score = rec.fitScore.toFixed(2)
    const bucket = fitBucket(rec.fitScore)
    console.log(`\n  [${bucket}] ${rec.platform.padEnd(15)} fit=${score}`)
    console.log(`    ${rec.rationale}`)
    if (rec.recommendedTactics.length > 0) {
      console.log('    tactics:')
      for (const t of rec.recommendedTactics) {
        console.log(`      - ${t}`)
      }
    }
  }

  if (result.missingPlatforms.length > 0) {
    console.log('\n=== missing platforms (no manifest yet — consider adding) ===')
    for (const mp of result.missingPlatforms) {
      console.log(`\n  ${mp.suggestedId}`)
      console.log(`    ${mp.rationale}`)
    }
  } else {
    console.log('\n=== missing platforms: none ===')
  }

  console.log(
    `\n[dev-strategy] usage: model=${result.usage.model} tokensIn=${result.usage.tokensIn} tokensOut=${result.usage.tokensOut} cost=$${result.usage.costUsd.toFixed(5)}`,
  )
}

main().catch((err) => {
  console.error('[dev-strategy] error:', err)
  process.exit(1)
})
