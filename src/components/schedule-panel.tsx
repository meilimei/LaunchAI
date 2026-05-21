import { Calendar } from 'lucide-react'
import { CHANNEL_META } from '@/lib/channels'
import type { Channel } from '@/lib/agents/types'

export interface ScheduleItem {
  id: string
  channel: Channel | string
  scheduledAt: string
  notes?: string | null
}

export function SchedulePanel({ items }: { items: ScheduleItem[] }) {
  if (items.length === 0) {
    return (
      <div className="rounded-lg border border-dashed bg-muted/20 p-6 text-center text-sm text-muted-foreground">
        Suggested publish calendar appears once Scheduler runs.
      </div>
    )
  }

  // Sort by scheduledAt ascending
  const sorted = [...items].sort(
    (a, b) => new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime(),
  )

  return (
    <ol className="space-y-2">
      {sorted.map((s) => {
        const meta = CHANNEL_META[s.channel as Channel]
        const date = new Date(s.scheduledAt)
        const label = meta?.label ?? s.channel
        return (
          <li
            key={s.id}
            className="flex items-start gap-3 rounded-lg border bg-card px-4 py-3"
          >
            <Calendar className="mt-0.5 h-4 w-4 text-emerald-500" />
            <div className="min-w-0 flex-1 space-y-0.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium">{label}</span>
                <time className="text-xs text-muted-foreground" dateTime={date.toISOString()}>
                  {formatLocal(date)}
                </time>
              </div>
              {s.notes && (
                <p className="text-xs text-muted-foreground">{s.notes}</p>
              )}
            </div>
          </li>
        )
      })}
    </ol>
  )
}

function formatLocal(d: Date): string {
  // We can't guarantee user locale on the server vs client perfectly,
  // but ISO-like + day-of-week is universally readable.
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()]
  const date = d.toISOString().slice(0, 10)
  const time = d.toISOString().slice(11, 16) + ' UTC'
  return `${dow} ${date} ${time}`
}
