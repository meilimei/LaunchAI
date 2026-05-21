import { notFound } from 'next/navigation'
import { db } from '@/lib/db/client'
import { JobHeader, type JobStatus } from '@/components/job-header'
import { TimelineLive } from '@/components/timeline-live'
import { AnalysisPanel } from '@/components/analysis-panel'
import { AssetCard, type AssetVersion } from '@/components/asset-card'
import { SchedulePanel, type ScheduleItem } from '@/components/schedule-panel'
import { AgentProgress } from '@/components/agent-progress'
import { CHANNEL_ORDER } from '@/lib/channels'
import type { DecisionItem } from '@/components/decision-card'
import type { AgentName } from '@/components/agent-badge'
import type { Channel, ChannelContent } from '@/lib/agents/types'

export const dynamic = 'force-dynamic'
export const revalidate = 0

interface PageProps {
  params: Promise<{ id: string }>
}

export default async function LaunchDashboardPage({ params }: PageProps) {
  const { id } = await params

  const job = await db.query.jobs.findFirst({
    where: (j, { eq }) => eq(j.id, id),
  })
  if (!job) {
    notFound()
  }

  const logs = await db.query.decisionLogs.findMany({
    where: (d, { eq }) => eq(d.jobId, id),
    orderBy: (d, { asc }) => [asc(d.createdAt)],
  })

  const analysis = await db.query.analyses.findFirst({
    where: (a, { eq }) => eq(a.jobId, id),
  })

  const assetRows = await db.query.assets.findMany({
    where: (a, { eq }) => eq(a.jobId, id),
    orderBy: (a, { asc }) => [asc(a.channel), asc(a.version)],
  })

  const scheduleRows = await db.query.schedules.findMany({
    where: (s, { eq }) => eq(s.jobId, id),
  })

  // Group assets by channel for AssetCard rendering.
  const assetsByChannel = new Map<Channel, AssetVersion[]>()
  for (const a of assetRows) {
    const list = assetsByChannel.get(a.channel as Channel) ?? []
    list.push({
      id: a.id,
      version: a.version,
      styleLabel: a.styleLabel,
      content: a.content as ChannelContent,
      isRecommended: a.isRecommended,
      criticScore: a.criticScore,
      criticReasoning: a.criticReasoning,
    })
    assetsByChannel.set(a.channel as Channel, list)
  }

  const scheduleItems: ScheduleItem[] = scheduleRows.map((s) => ({
    id: s.id,
    channel: s.channel,
    scheduledAt: s.scheduledAt.toISOString(),
    notes: s.notes,
  }))

  const initialItems: DecisionItem[] = logs.map((l) => ({
    id: l.id,
    agent: l.agent as AgentName,
    step: l.step,
    inputSummary: l.inputSummary,
    outputSummary: l.outputSummary,
    reasoning: l.reasoning,
    model: l.model,
    tokensIn: l.tokensIn,
    tokensOut: l.tokensOut,
    costUsd: l.costUsd,
    durationMs: l.durationMs,
    status: l.status,
    error: l.error,
    createdAt: l.createdAt.toISOString(),
  }))

  const isTerminal = job.status === 'completed' || job.status === 'failed'

  return (
    <main className="flex min-h-screen flex-col">
      <JobHeader
        jobId={job.id}
        inputUrl={job.inputUrl}
        status={job.status as JobStatus}
        productType={job.productType}
        totalCostUsd={job.totalCostUsd}
        startedAt={job.startedAt?.toISOString() ?? null}
        completedAt={job.completedAt?.toISOString() ?? null}
      />

      <div className="container flex flex-1 flex-col gap-8 py-6">
        {/* Top Progress Bar */}
        <AgentProgress 
          jobId={job.id} 
          initialItems={initialItems} 
          isTerminal={isTerminal} 
          status={job.status} 
        />

        <div className="grid gap-8 lg:grid-cols-[1fr_400px]">
          {/* Left: Dynamic Decision Flow */}
          <div className="flex flex-col gap-4 min-w-0">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-primary animate-pulse-soft" />
              Agent Thought Stream
            </h2>
            <div className="rounded-xl border bg-muted/10 p-4">
              <TimelineLive jobId={job.id} initial={initialItems} isTerminal={isTerminal} />
            </div>
          </div>

          {/* Right: Results / Analysis */}
          <div className="flex flex-col gap-6 min-w-0">
            <aside className="space-y-3">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                Live Analysis
              </h2>
              <AnalysisPanel
                analysis={
                  analysis
                    ? {
                        features: analysis.features as AnalysisData['features'],
                        painPoints: analysis.painPoints as string[],
                        keywords: analysis.keywords as string[],
                        tone: analysis.tone as AnalysisData['tone'],
                        reviewsSummary: analysis.reviewsSummary,
                      }
                    : null
                }
              />
            </aside>
          </div>
        </div>

        {/* Results section moved below or integrated into right sidebar */}
        {(assetRows.length > 0 || scheduleItems.length > 0) && (
          <div className="mt-8 border-t pt-8">
            {assetRows.length > 0 && (
              <section className="mb-8 space-y-4">
                <h2 className="text-xl font-bold tracking-tight">
                  Launch Assets Generated
                </h2>
                <div className="grid gap-6 xl:grid-cols-2">
                  {CHANNEL_ORDER.map((channel) => {
                    const versions = assetsByChannel.get(channel)
                    if (!versions || versions.length === 0) return null
                    return <AssetCard key={channel} channel={channel} versions={versions} />
                  })}
                </div>
              </section>
            )}

            {scheduleItems.length > 0 && (
              <section className="space-y-4">
                <h2 className="text-xl font-bold tracking-tight">
                  Suggested Publish Schedule
                </h2>
                <SchedulePanel items={scheduleItems} />
              </section>
            )}
          </div>
        )}
      </div>
    </main>
  )
}

// Local type alias to avoid coupling to AnalysisPanel's internal type.
type AnalysisData = {
  features: Array<{ name: string; benefit: string; evidenceQuote?: string }>
  painPoints: string[]
  keywords: string[]
  tone: { formality: number; technicality: number; suggestedTone: string }
}

