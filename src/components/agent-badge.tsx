import { cn } from '@/lib/utils'
import {
  Bot,
  Search,
  Sparkles,
  ScanSearch,
  PenTool,
  Gauge,
  Calendar,
  type LucideIcon,
} from 'lucide-react'

export type AgentName =
  | 'crawler'
  | 'analyst'
  | 'competitor'
  | 'writer'
  | 'critic'
  | 'scheduler'
  | 'orchestrator'

interface AgentMeta {
  label: string
  icon: LucideIcon
  className: string
}

const AGENT_META: Record<AgentName, AgentMeta> = {
  crawler: {
    label: 'Crawler',
    icon: Search,
    className: 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950 dark:text-blue-300 dark:border-blue-900',
  },
  analyst: {
    label: 'Analyst',
    icon: Sparkles,
    className: 'bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-950 dark:text-purple-300 dark:border-purple-900',
  },
  competitor: {
    label: 'Competitor',
    icon: ScanSearch,
    className: 'bg-cyan-50 text-cyan-700 border-cyan-200 dark:bg-cyan-950 dark:text-cyan-300 dark:border-cyan-900',
  },
  writer: {
    label: 'Writer',
    icon: PenTool,
    className: 'bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-950 dark:text-orange-300 dark:border-orange-900',
  },
  critic: {
    label: 'Critic',
    icon: Gauge,
    className: 'bg-pink-50 text-pink-700 border-pink-200 dark:bg-pink-950 dark:text-pink-300 dark:border-pink-900',
  },
  scheduler: {
    label: 'Scheduler',
    icon: Calendar,
    className: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-300 dark:border-emerald-900',
  },
  orchestrator: {
    label: 'System',
    icon: Bot,
    className: 'bg-zinc-50 text-zinc-700 border-zinc-200 dark:bg-zinc-900 dark:text-zinc-300 dark:border-zinc-800',
  },
}

export function AgentBadge({
  agent,
  className,
}: {
  agent: AgentName
  className?: string
}) {
  const meta = AGENT_META[agent]
  const Icon = meta.icon
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium',
        meta.className,
        className,
      )}
    >
      <Icon className="h-3 w-3" />
      {meta.label}
    </span>
  )
}
