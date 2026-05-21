/**
 * Quick sanity test for extractCwsInitData using the captured fixture.
 *
 * Usage: pnpm tsx scripts/test-cws-parser.ts
 *
 * Verifies that the parser recovers a multi-paragraph long description
 * from a real CWS HTML page (currently Rethread).
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { extractCwsInitData } from '@/lib/crawl/cws'

const fixturePath = resolve(process.cwd(), 'tmp/rethread-cws.html')
const html = readFileSync(fixturePath, 'utf-8')

const data = extractCwsInitData(html)

console.log(`HTML: ${html.length} bytes`)
console.log(`category: ${data.category ?? '(none)'}`)
console.log(`longDescription length: ${data.longDescription?.length ?? 0}`)
console.log('')
console.log('--- longDescription (first 1500 chars) ---')
console.log(data.longDescription?.slice(0, 1500) ?? '(empty)')

if (!data.longDescription || data.longDescription.length < 500) {
  console.error('\n❌ FAIL: long description is missing or too short')
  process.exit(1)
}
console.log('\n✅ Parser recovered a long description')
