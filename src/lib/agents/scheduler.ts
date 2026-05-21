import { nanoid } from 'nanoid'
import { db } from '@/lib/db/client'
import { schedules } from '@/lib/db/schema'
import type { Agent, AgentContext, SchedulerOutput } from './types'

/**
 * Scheduler Agent.
 *
 * Pure code, no LLM. Picks a sensible publish time per channel within the
 * next 7 days, based on platform conventions:
 *
 *   - Product Hunt: Tuesday 12:01 AM PT (12 hours visibility on day-of-launch matters most)
 *   - Hacker News: Tuesday-Thursday, 8-10 AM PT (peak engagement)
 *   - Reddit: depends on subreddit; chrome_extensions trends weekday afternoons UTC
 *   - X / Twitter: same day as Product Hunt, 1-2 hours after PH go-live
 *   - Indie Hackers: Wednesday/Thursday, anytime
 *   - CWS Listing: deploy as soon as ready (no schedule)
 *
 * The schedule is a SUGGESTION the user can edit. We never auto-publish.
 */

const PT_OFFSET_HOURS = -7 // Pacific Daylight Time. Good enough for v1; user can edit.

export const schedulerAgent: Agent<SchedulerOutput> = {
  name: 'scheduler',

  async run(ctx: AgentContext): Promise<SchedulerOutput> {
    const startedAt = Date.now()

    await ctx.emit({
      agent: 'scheduler',
      step: 'plan',
      inputSummary: 'Building 7-day publish calendar',
    })

    const now = new Date()
    const phLaunch = nextWeekday(now, 2, 0) // Tuesday 00:01 PT
    const hnPost = addHours(phLaunch, 8) // Same day +8h (8 AM PT)
    const xLaunch = addHours(phLaunch, 9) // Same day +9h
    const redditPost = addHours(phLaunch, 24) // Wednesday
    const ihPost = addHours(phLaunch, 48) // Thursday

    const schedule: SchedulerOutput['schedule'] = [
      {
        channel: 'cws_listing',
        scheduledAt: now.toISOString(),
        notes: 'Update your Chrome Web Store listing now — no need to wait.',
      },
      {
        channel: 'product_hunt',
        scheduledAt: phLaunch.toISOString(),
        notes: 'Submit before 12:01 AM Pacific Time on launch day. Replies in the first 4 hours matter most.',
      },
      {
        channel: 'hacker_news',
        scheduledAt: hnPost.toISOString(),
        notes: 'Post Show HN Tuesday morning Pacific. Stay on the comment thread for the first hour.',
      },
      {
        channel: 'twitter',
        scheduledAt: xLaunch.toISOString(),
        notes: 'Hook tweet right after PH goes live; thread one tweet/hour for momentum.',
      },
      {
        channel: 'reddit',
        scheduledAt: redditPost.toISOString(),
        notes: 'Day after PH. Engage every comment within 6 hours.',
      },
      {
        channel: 'indie_hackers',
        scheduledAt: ihPost.toISOString(),
        notes: 'Two days after PH. Frame as a milestone with concrete numbers.',
      },
    ]

    // Persist to schedules table.
    await db.insert(schedules).values(
      schedule.map((s) => ({
        id: nanoid(),
        jobId: ctx.job.id,
        channel: s.channel,
        scheduledAt: new Date(s.scheduledAt),
        notes: s.notes,
      })),
    )

    await ctx.emit({
      agent: 'scheduler',
      step: 'plan_complete',
      outputSummary: `Scheduled ${schedule.length} channels. PH launch: ${phLaunch.toUTCString()}`,
      reasoning: 'Default cadence: PH first (Tue), HN/X same day, Reddit Wed, IH Thu. Edit any time.',
      durationMs: Date.now() - startedAt,
    })

    return { schedule }
  },
}

// ---------- Date helpers ----------

/**
 * Next occurrence of `targetDow` (0=Sun..6=Sat) in PT, at 00:01 local time.
 * If today is the target day and it's already past 00:01 PT, jump to next week.
 */
function nextWeekday(from: Date, targetDow: 0 | 1 | 2 | 3 | 4 | 5 | 6, hourPT: number): Date {
  const fromMs = from.getTime()
  // Apply PT offset to get "as if we're in PT" date components.
  const ptNow = new Date(fromMs + PT_OFFSET_HOURS * 3600_000)
  const ptDow = ptNow.getUTCDay()

  let daysAhead = (targetDow - ptDow + 7) % 7
  if (daysAhead === 0 && ptNow.getUTCHours() >= hourPT) {
    daysAhead = 7
  }

  const ptTarget = new Date(ptNow)
  ptTarget.setUTCDate(ptTarget.getUTCDate() + daysAhead)
  ptTarget.setUTCHours(hourPT, 1, 0, 0)

  // Convert PT-pretend back to real UTC.
  return new Date(ptTarget.getTime() - PT_OFFSET_HOURS * 3600_000)
}

function addHours(d: Date, hours: number): Date {
  return new Date(d.getTime() + hours * 3600_000)
}
