/**
 * One-shot Postgres schema inspector.
 *
 * Run: pnpm diag:db
 *
 * Verifies that the campaign-runtime tables / enums / new columns are present
 * after `pnpm db:push`. Used to confirm a migration round-trip without
 * opening drizzle-studio.
 */
import postgres from 'postgres'

const EXPECTED_TABLES = [
  'users',
  'campaigns',
  'campaign_phases',
  'jobs',
  'tasks',
  'actions',
  'raw_scrapes',
  'analyses',
  'competitors',
  'assets',
  'decision_logs',
  'feedback',
  'schedules',
  'integrations',
  'browser_sessions',
  'approvals',
  'platform_posts',
  'metrics_snapshots',
  'memories',
  'platform_selector_hints',
] as const

const EXPECTED_ENUMS = [
  'plan',
  'job_status',
  'product_type',
  'channel',
  'agent',
  'feedback_action',
  'campaign_status',
  'campaign_phase',
  'campaign_phase_status',
  'autopilot_level',
  'risk_policy',
  'task_status',
  'action_status',
] as const

async function main() {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL missing in env')

  const sql = postgres(url, { max: 1, prepare: false })

  try {
    const masked = url.replace(/:[^:@/]+@/, ':***@')
    console.log(`[diag-db] connected to ${masked}`)

    const tables = await sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' ORDER BY table_name
    `
    const tableSet = new Set(tables.map((r) => r.table_name))
    console.log(`\n[diag-db] tables (${tables.length}):`)
    for (const t of EXPECTED_TABLES) {
      console.log(`  ${tableSet.has(t) ? 'OK ' : 'MISS'}  ${t}`)
    }
    const extras = tables.map((r) => r.table_name).filter((n) => !EXPECTED_TABLES.includes(n as never))
    if (extras.length > 0) {
      console.log(`  extra:`, extras.join(', '))
    }

    const enums = await sql<{ typname: string }[]>`
      SELECT t.typname FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE t.typtype = 'e' AND n.nspname = 'public'
      ORDER BY t.typname
    `
    const enumSet = new Set(enums.map((r) => r.typname))
    console.log(`\n[diag-db] enums (${enums.length}):`)
    for (const e of EXPECTED_ENUMS) {
      console.log(`  ${enumSet.has(e) ? 'OK ' : 'MISS'}  ${e}`)
    }

    const jobsCols = await sql<{ column_name: string; data_type: string }[]>`
      SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'jobs'
      ORDER BY ordinal_position
    `
    console.log(`\n[diag-db] jobs columns (${jobsCols.length}):`)
    for (const c of jobsCols) {
      console.log(`  ${c.column_name.padEnd(20)}  ${c.data_type}`)
    }
    const hasCampaignId = jobsCols.some((c) => c.column_name === 'campaign_id')
    console.log(`\n[diag-db] jobs.campaign_id present: ${hasCampaignId ? 'YES' : 'NO'}`)

    const counts = await sql<{ tname: string; n: number }[]>`
      SELECT 'campaigns' AS tname, COUNT(*)::int AS n FROM campaigns
      UNION ALL SELECT 'tasks', COUNT(*)::int FROM tasks
      UNION ALL SELECT 'actions', COUNT(*)::int FROM actions
      UNION ALL SELECT 'memories', COUNT(*)::int FROM memories
      UNION ALL SELECT 'browser_sessions', COUNT(*)::int FROM browser_sessions
      UNION ALL SELECT 'jobs', COUNT(*)::int FROM jobs
    `
    console.log(`\n[diag-db] row counts:`)
    for (const r of counts) console.log(`  ${r.tname.padEnd(12)}  ${r.n}`)

    const missingTables = EXPECTED_TABLES.filter((t) => !tableSet.has(t))
    const missingEnums = EXPECTED_ENUMS.filter((e) => !enumSet.has(e))
    if (missingTables.length > 0 || missingEnums.length > 0 || !hasCampaignId) {
      console.log('\n[diag-db] FAIL — schema is incomplete.')
      process.exit(2)
    }
    console.log('\n[diag-db] OK — campaign runtime schema is fully applied.')
  } finally {
    await sql.end({ timeout: 2 })
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
