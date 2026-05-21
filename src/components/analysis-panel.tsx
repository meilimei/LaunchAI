import { Sparkles, Hash, AlertCircle, Volume2 } from 'lucide-react'

interface AnalysisData {
  features: Array<{ name: string; benefit: string; evidenceQuote?: string }>
  painPoints: string[]
  keywords: string[]
  tone: { formality: number; technicality: number; suggestedTone: string }
  reviewsSummary?: string | null
}

export function AnalysisPanel({ analysis }: { analysis: AnalysisData | null }) {
  if (!analysis) {
    return (
      <div className="rounded-lg border border-dashed bg-muted/20 p-6 text-center text-sm text-muted-foreground">
        Analyst output appears here once extraction is complete.
      </div>
    )
  }

  return (
    <div className="space-y-6 rounded-lg border bg-card p-6">
      <div>
        <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold">
          <Sparkles className="h-4 w-4 text-purple-500" />
          Features
        </h3>
        <ul className="space-y-3">
          {analysis.features.map((f, i) => (
            <li key={i} className="space-y-1 border-l-2 border-purple-200 pl-3 dark:border-purple-900">
              <div className="text-sm font-medium">{f.name}</div>
              <div className="text-sm text-muted-foreground">{f.benefit}</div>
              {f.evidenceQuote && (
                <div className="text-xs italic text-muted-foreground/80">
                  &ldquo;{f.evidenceQuote}&rdquo;
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>

      {analysis.painPoints.length > 0 && (
        <div>
          <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold">
            <AlertCircle className="h-4 w-4 text-amber-500" />
            Pain points (from reviews)
          </h3>
          <ul className="list-disc space-y-1.5 pl-5 text-sm text-muted-foreground">
            {analysis.painPoints.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold">
          <Hash className="h-4 w-4 text-blue-500" />
          Keywords
        </h3>
        <div className="flex flex-wrap gap-1.5">
          {analysis.keywords.map((k, i) => (
            <span
              key={i}
              className="rounded-full border bg-secondary/40 px-2 py-0.5 text-xs"
            >
              {k}
            </span>
          ))}
        </div>
      </div>

      <div>
        <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold">
          <Volume2 className="h-4 w-4 text-emerald-500" />
          Tone
        </h3>
        <div className="space-y-2">
          <ToneBar label="Formality" value={analysis.tone.formality} hint="1=casual, 5=formal" />
          <ToneBar label="Technicality" value={analysis.tone.technicality} hint="1=non-technical, 5=deep technical" />
          <p className="pt-1 text-sm text-muted-foreground">
            <span className="font-medium text-foreground">Suggested:</span>{' '}
            {analysis.tone.suggestedTone}
          </p>
        </div>
      </div>

      {analysis.reviewsSummary && (
        <div>
          <h3 className="mb-2 text-sm font-semibold">Reviews summary</h3>
          <p className="text-sm text-muted-foreground">{analysis.reviewsSummary}</p>
        </div>
      )}
    </div>
  )
}

function ToneBar({ label, value, hint }: { label: string; value: number; hint: string }) {
  const pct = ((value - 1) / 4) * 100
  return (
    <div className="space-y-0.5">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono">{value}/5</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-emerald-500/70"
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="text-[10px] text-muted-foreground/80">{hint}</div>
    </div>
  )
}
