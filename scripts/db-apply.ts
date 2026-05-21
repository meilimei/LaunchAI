/**
 * Non-interactive SQL migration applier.
 *
 * Usage:
 *   pnpm db:apply                      # apply the latest migration in drizzle/migrations/
 *   pnpm db:apply 0001_common_silver_sable.sql
 *   pnpm db:apply --all                # apply every migration in order
 *
 * Why this exists:
 *   `drizzle-kit push` opens an arrow-key TUI to confirm. That TUI hangs
 *   when the terminal is not a real interactive PTY (e.g. proxied terminals
 *   or when Cascade runs the command). This script just executes the SQL
 *   files we already generated with `pnpm db:generate`, so it runs cleanly
 *   anywhere.
 *
 * Safety:
 *   - Each statement runs inside a single transaction.
 *   - Errors fail fast with the offending statement printed.
 *   - Idempotency depends on the migration content. Generated migrations
 *     are usually NOT idempotent (no IF NOT EXISTS), so do not re-apply.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import postgres from 'postgres'

const MIGRATIONS_DIR = path.resolve(process.cwd(), 'drizzle', 'migrations')

async function listMigrations(): Promise<string[]> {
  const entries = await fs.readdir(MIGRATIONS_DIR)
  return entries.filter((f) => f.endsWith('.sql')).sort()
}

async function readMigration(file: string): Promise<string> {
  return fs.readFile(path.join(MIGRATIONS_DIR, file), 'utf8')
}

function splitStatements(sql: string): string[] {
  return sql
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

async function applyMigration(sql: postgres.Sql, file: string) {
  const content = await readMigration(file)
  const statements = splitStatements(content)
  console.log(`[db-apply] ${file}: ${statements.length} statement(s)`)

  await sql.begin(async (tx) => {
    for (const [i, stmt] of statements.entries()) {
      try {
        await tx.unsafe(stmt)
        console.log(`  [${i + 1}/${statements.length}] OK ${firstLine(stmt)}`)
      } catch (err) {
        console.error(`\n[db-apply] FAILED on statement ${i + 1}:\n${stmt}\n`)
        throw err
      }
    }
  })

  console.log(`[db-apply] ${file} applied OK.`)
}

function firstLine(s: string): string {
  const line = s.split('\n', 1)[0]?.slice(0, 100) ?? ''
  return line.replace(/\s+/g, ' ').trim()
}

async function main() {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL not set')

  const args = process.argv.slice(2)
  const all = args.includes('--all')
  const explicit = args.find((a) => !a.startsWith('--'))

  const migrations = await listMigrations()
  if (migrations.length === 0) {
    console.log('[db-apply] no migrations found.')
    return
  }

  let toApply: string[] = []
  if (all) {
    toApply = migrations
  } else if (explicit) {
    if (!migrations.includes(explicit)) {
      throw new Error(`Migration not found: ${explicit}\nAvailable:\n  ${migrations.join('\n  ')}`)
    }
    toApply = [explicit]
  } else {
    toApply = [migrations[migrations.length - 1]!]
  }

  const masked = url.replace(/:[^:@/]+@/, ':***@')
  console.log(`[db-apply] connecting to ${masked}`)
  const sql = postgres(url, { max: 1, prepare: false })

  try {
    for (const m of toApply) {
      await applyMigration(sql, m)
    }
    console.log('\n[db-apply] all done.')
  } finally {
    await sql.end({ timeout: 2 })
  }
}

main().catch((err) => {
  console.error('[db-apply] error:', err)
  process.exit(1)
})
