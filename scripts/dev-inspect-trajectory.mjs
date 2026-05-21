// Dev helper: summarize a trajectory JSON for quick post-run review.
// Usage: node scripts/dev-inspect-trajectory.mjs <path-to-trajectory.json>
import fs from 'node:fs'

const path = process.argv[2]
if (!path) {
  console.error('Usage: node scripts/dev-inspect-trajectory.mjs <trajectory.json>')
  process.exit(1)
}

const t = JSON.parse(fs.readFileSync(path, 'utf8'))

console.log('=== STEP SUMMARY ===')
for (const s of t.raw.trajectory) {
  const tc = s.toolCall
  const ok = s.result && s.result.ok ? 'OK ' : 'ERR'
  let d = ''
  if (tc.tool === 'navigate') d = tc.url.slice(0, 90)
  else if (tc.tool === 'click') d = tc.selector
  else if (tc.tool === 'type') d = `${tc.selector} (${(tc.text || '').length} chars)`
  else if (tc.tool === 'describe_page') d = '(describe)'
  else if (tc.tool === 'finish')
    d = `success=${tc.success} url=${((tc.output || {}).url || '').slice(0, 100)}`
  console.log(`STEP ${s.index}  ${ok}  ${tc.tool.padEnd(18)}${d}`)
}

console.log('')
console.log('=== LAST describe_page OBSERVATION ===')
const dpStep = [...t.raw.trajectory].reverse().find((s) => s.toolCall.tool === 'describe_page')
if (!dpStep) {
  console.log('(no describe_page step in trajectory)')
  process.exit(0)
}
const obs = dpStep.result.observation
console.log('obs length:', obs.length)
const statusIdx = obs.indexOf('STATUS MESSAGES')
console.log('STATUS MESSAGES present:', statusIdx === -1 ? 'NO' : `yes (at ${statusIdx})`)
if (statusIdx !== -1) {
  console.log('--- STATUS MESSAGES block ---')
  console.log(obs.slice(statusIdx, statusIdx + 600))
}
const editRe = /- a "edit" [^\n]{0,120}/g
const delRe = /- a "delete" [^\n]{0,120}/g
const permaRe = /- a "permalink" [^\n]{0,200}/g
console.log('edit links:', obs.match(editRe)?.length || 0)
console.log('delete links:', obs.match(delRe)?.length || 0)
const permas = obs.match(permaRe) || []
console.log('permalinks:', permas.length)
permas.slice(0, 3).forEach((p) => console.log('  ' + p))

console.log('')
console.log('=== FINISH reason / evidence ===')
const finishStep = t.raw.trajectory.find((s) => s.toolCall.tool === 'finish')
if (finishStep) {
  console.log('summary:', finishStep.toolCall.summary)
  console.log('output:', JSON.stringify(finishStep.toolCall.output, null, 2))
}
