import Link from 'next/link'
import { ArrowLeft, ExternalLink, CheckCircle2, XCircle, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

export type JobStatus =
  | 'queued'
  | 'crawling'
  | 'analyzing'
  | 'generating'
  | 'critiquing'
  | 'scheduling'
  | 'completed'
  | 'failed'

export function JobHeader({
  jobId,
  inputUrl,
  status,
  productType,
  totalCostUsd,
  startedAt,
  completedAt,
}: {
  jobId: string
  inputUrl: string
  status: JobStatus
  productType: string
  totalCostUsd?: string | number
  startedAt?: string | null
  completedAt?: string | null
}) {
  const isTerminal = status === 'completed' || status === 'failed'
  const isRunning = !isTerminal && status !== 'queued'

  let durationLabel: string | null = null
  if (startedAt) {
    const end = completedAt ? new Date(completedAt).getTime() : Date.now()
    const ms = end - new Date(startedAt).getTime()
    durationLabel = ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
  }

  return (
    <div className="border-b">
      <div className="container flex h-16 items-center justify-between">
        <Link
          href="/launch"
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          New launch
        </Link>
        <code className="text-xs text-muted-foreground">{jobId}</code>
      </div>

      <div className="container flex flex-col gap-3 pb-6">
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill status={status} />
          <span className="rounded-full border bg-secondary/40 px-2 py-0.5 text-xs text-muted-foreground">
            {productType.replace('_', ' ')}
          </span>
          {durationLabel && (
            <span className="text-xs text-muted-foreground">{durationLabel}</span>
          )}
          {totalCostUsd != null && Number(totalCostUsd) > 0 && (
            <span className="text-xs text-muted-foreground">
              ${Number(totalCostUsd).toFixed(4)}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <span className="truncate font-mono text-sm" title={inputUrl}>
            {inputUrl}
          </span>
          <a
            href={inputUrl}
            target="_blank"
            rel="noreferrer"
            className="text-muted-foreground hover:text-foreground"
            aria-label="Open URL in new tab"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </div>

        <p className="text-xs text-muted-foreground">
          {isRunning && 'Pipeline is running. Watch the timeline below as each agent decides what to do next.'}
          {status === 'queued' && 'Queued. Waiting for a worker to pick this up...'}
          {status === 'completed' && 'Pipeline completed. Recommended launch assets and schedule are ready below.'}
          {status === 'failed' && 'Pipeline failed. Open the failed step below for details.'}
        </p>
      </div>
    </div>
  )
}

function StatusPill({ status }: { status: JobStatus }) {
  const meta = STATUS_META[status]
  const Icon = meta.icon
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium',
        meta.className,
      )}
    >
      <Icon className={cn('h-3.5 w-3.5', meta.spin && 'animate-spin')} />
      {meta.label}
    </span>
  )
}

const STATUS_META: Record<
  JobStatus,
  { label: string; icon: typeof Loader2; spin?: boolean; className: string }
> = {
  queued: {
    label: 'Queued',
    icon: Loader2,
    className: 'bg-zinc-50 text-zinc-700 border-zinc-200 dark:bg-zinc-900 dark:text-zinc-300 dark:border-zinc-800',
  },
  crawling: {
    label: 'Crawling',
    icon: Loader2,
    spin: true,
    className: 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950 dark:text-blue-300 dark:border-blue-900',
  },
  analyzing: {
    label: 'Analyzing',
    icon: Loader2,
    spin: true,
    className: 'bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-950 dark:text-purple-300 dark:border-purple-900',
  },
  generating: {
    label: 'Generating',
    icon: Loader2,
    spin: true,
    className: 'bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-950 dark:text-orange-300 dark:border-orange-900',
  },
  critiquing: {
    label: 'Critiquing',
    icon: Loader2,
    spin: true,
    className: 'bg-pink-50 text-pink-700 border-pink-200 dark:bg-pink-950 dark:text-pink-300 dark:border-pink-900',
  },
  scheduling: {
    label: 'Scheduling',
    icon: Loader2,
    spin: true,
    className: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-300 dark:border-emerald-900',
  },
  completed: {
    label: 'Completed',
    icon: CheckCircle2,
    className: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-300 dark:border-emerald-900',
  },
  failed: {
    label: 'Failed',
    icon: XCircle,
    className: 'bg-destructive/10 text-destructive border-destructive/30',
  },
}
