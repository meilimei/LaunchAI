/**
 * Dump everything we know about a job: jobs row + analysis + decision_logs + assets.
 *
 * Usage:
 *   pnpm dump:job              # latest job
 *   pnpm dump:job <jobId>      # specific job
 *   pnpm dump:job <jobId> --md # write a markdown report instead of stdout
 *
 * This is the primary tool for prompt iteration: read what each agent
 * actually saw and produced, then change prompts accordingly.
 */
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { desc, eq, asc } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import {
  jobs,
  analyses,
  decisionLogs,
  assets,
  rawScrapes,
} from '@/lib/db/schema'

async function main() {
  const args = process.argv.slice(2)
  const wantMd = args.includes('--md')
  const positional = args.filter((a) => !a.startsWith('--'))
  const jobIdArg = positional[0]

  // Locate the job.
  const job = jobIdArg
    ? await db.query.jobs.findFirst({ where: (j, { eq }) => eq(j.id, jobIdArg) })
    : await db.query.jobs.findFirst({ orderBy: [desc(jobs.createdAt)] })

  if (!job) {
    console.error('No job found.')
    process.exit(1)
  }

  const [analysis] = await db.select().from(analyses).where(eq(analyses.jobId, job.id))
  const logs = await db
    .select()
    .from(decisionLogs)
    .where(eq(decisionLogs.jobId, job.id))
    .orderBy(asc(decisionLogs.createdAt))
  const assetRows = await db.select().from(assets).where(eq(assets.jobId, job.id))
  const scrapes = await db.select().from(rawScrapes).where(eq(rawScrapes.jobId, job.id))

  if (wantMd) {
    const md = renderMarkdown({ job, analysis, logs, assetRows, scrapes })
    const path = resolve(process.cwd(), `tmp/job-${job.id}.md`)
    writeFileSync(path, md, 'utf-8')
    console.log(`Wrote ${path}`)
    process.exit(0)
  }

  // Plain stdout.
  console.log(`# Job ${job.id}`)
  console.log(
    `  url=${job.inputUrl} status=${job.status} cost=$${job.totalCostUsd} created=${job.createdAt.toISOString()}`,
  )

  console.log(`\n## Analysis`)
  if (analysis) {
    console.log(`  features (${(analysis.features as unknown[]).length}):`)
    for (const f of analysis.features as Array<{ name: string; benefit: string; evidenceQuote: string }>) {
      console.log(`    - ${f.name}: ${f.benefit}`)
      console.log(`      evidence: "${f.evidenceQuote.slice(0, 100)}..."`)
    }
    console.log(`  painPoints (${(analysis.painPoints as string[]).length}):`)
    for (const p of analysis.painPoints as string[]) console.log(`    - ${p}`)
    console.log(`  keywords: ${(analysis.keywords as string[]).join(', ')}`)
    console.log(`  tone:`, analysis.tone)
    console.log(`  reviewsSummary: ${analysis.reviewsSummary?.slice(0, 200) ?? '(none)'}`)
  } else {
    console.log('  (no analysis row)')
  }

  console.log(`\n## Raw scrapes (${scrapes.length})`)
  for (const s of scrapes) {
    const parsed = s.parsedJson as Record<string, unknown> | null
    const reviews = parsed && Array.isArray(parsed.reviews) ? parsed.reviews.length : 0
    console.log(
      `  - ${s.sourceType} ${s.sourceUrl} reviews=${reviews} html=${s.rawHtml ? s.rawHtml.length + 'b' : '0b'}`,
    )
  }

  console.log(`\n## Decision logs (${logs.length})`)
  for (const log of logs) {
    const head = `[${log.agent}] ${log.step} (${log.status})`
    const meta = [
      log.model && `model=${log.model}`,
      log.tokensIn != null && `in=${log.tokensIn}`,
      log.tokensOut != null && `out=${log.tokensOut}`,
      log.costUsd && `cost=$${log.costUsd}`,
      log.durationMs != null && `dur=${log.durationMs}ms`,
    ]
      .filter(Boolean)
      .join(' ')
    console.log(`  ${head}  ${meta}`)
    if (log.inputSummary) console.log(`    input: ${log.inputSummary}`)
    if (log.outputSummary) console.log(`    output: ${log.outputSummary}`)
    if (log.reasoning) console.log(`    reasoning: ${log.reasoning.slice(0, 200)}`)
    if (log.error) console.log(`    error: ${log.error}`)
  }

  console.log(`\n## Assets (${assetRows.length})`)
  for (const a of assetRows) {
    console.log(
      `  - ${a.channel} v${a.version} (${a.styleLabel}) score=${a.criticScore} recommended=${a.isRecommended}`,
    )
  }

  process.exit(0)
}

interface RenderInput {
  job: typeof jobs.$inferSelect
  analysis: typeof analyses.$inferSelect | undefined
  logs: Array<typeof decisionLogs.$inferSelect>
  assetRows: Array<typeof assets.$inferSelect>
  scrapes: Array<typeof rawScrapes.$inferSelect>
}

function renderMarkdown(d: RenderInput): string {
  const lines: string[] = []
  lines.push(`# Job ${d.job.id}`)
  lines.push('')
  lines.push(`- URL: ${d.job.inputUrl}`)
  lines.push(`- Status: ${d.job.status}`)
  lines.push(`- Cost: $${d.job.totalCostUsd}`)
  lines.push(`- Created: ${d.job.createdAt.toISOString()}`)
  lines.push('')

  if (d.analysis) {
    lines.push(`## Analyst output`)
    lines.push('```json')
    lines.push(
      JSON.stringify(
        {
          features: d.analysis.features,
          painPoints: d.analysis.painPoints,
          keywords: d.analysis.keywords,
          tone: d.analysis.tone,
          reviewsSummary: d.analysis.reviewsSummary,
        },
        null,
        2,
      ),
    )
    lines.push('```')
    lines.push('')
  }

  lines.push(`## Decision logs`)
  for (const log of d.logs) {
    lines.push(
      `### [${log.agent}] ${log.step} — ${log.status}` +
        (log.durationMs != null ? ` (${log.durationMs}ms)` : ''),
    )
    if (log.inputSummary) lines.push(`**input**: ${log.inputSummary}`)
    if (log.outputSummary) lines.push(`**output**: ${log.outputSummary}`)
    if (log.reasoning) {
      lines.push(`**reasoning**:`)
      lines.push('> ' + log.reasoning.replace(/\n/g, '\n> '))
    }
    if (log.rawInput) {
      lines.push(`<details><summary>raw_input</summary>\n`)
      lines.push('```json')
      lines.push(JSON.stringify(log.rawInput, null, 2).slice(0, 8000))
      lines.push('```')
      lines.push(`</details>`)
    }
    if (log.rawOutput) {
      lines.push(`<details><summary>raw_output</summary>\n`)
      lines.push('```json')
      lines.push(JSON.stringify(log.rawOutput, null, 2).slice(0, 8000))
      lines.push('```')
      lines.push(`</details>`)
    }
    lines.push('')
  }

  lines.push(`## Assets`)
  for (const a of d.assetRows) {
    lines.push(
      `### ${a.channel} v${a.version} (${a.styleLabel})` +
        ` — score=${a.criticScore} ${a.isRecommended ? '✓ recommended' : ''}`,
    )
    lines.push('```json')
    lines.push(JSON.stringify(a.content, null, 2))
    lines.push('```')
    if (a.criticReasoning) {
      lines.push(`**Critic**: ${a.criticReasoning}`)
    }
    lines.push('')
  }

  lines.push(`## Scrapes`)
  for (const s of d.scrapes) {
    const parsed = s.parsedJson as Record<string, unknown> | null
    const reviews = parsed && Array.isArray(parsed.reviews) ? parsed.reviews : []
    lines.push(`### ${s.sourceType} — ${s.sourceUrl}`)
    lines.push(`reviews: ${reviews.length}, html: ${s.rawHtml?.length ?? 0} bytes`)
    if (parsed) {
      lines.push('```json')
      const slim = { ...parsed }
      // Don't dump rawHtml-like fields.
      if ('rawHtml' in slim) delete (slim as Record<string, unknown>).rawHtml
      lines.push(JSON.stringify(slim, null, 2).slice(0, 6000))
      lines.push('```')
    }
    lines.push('')
  }

  return lines.join('\n')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
