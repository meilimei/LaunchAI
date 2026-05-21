import { redis, jobEventsChannel } from '@/lib/queue/connection'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/launch/[id]/events
 * Server-Sent Events stream of decision events for the given job.
 *
 * Architecture:
 *   - Each connection opens its own Redis subscriber (cheap; pubsub fan-out).
 *   - Subscriber listens to channel `launchai:job:<id>:events`.
 *   - Each Redis message → one SSE `data:` frame.
 *   - On client disconnect (controller.cancel), we unsubscribe + quit the subscriber.
 *
 * The SSE payload mirrors the DecisionEvent shape minus rawInput/rawOutput
 * (those live in the DB only — fetch the full record via /api/launch/[id]).
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const channel = jobEventsChannel(id)

  const subscriber = redis.duplicate({ lazyConnect: false })

  const encoder = new TextEncoder()

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // Send a comment frame immediately to flush headers.
      controller.enqueue(encoder.encode(': connected\n\n'))

      subscriber.on('message', (_chan, message) => {
        try {
          // Forward verbatim — Redis already has the JSON-serialized event.
          controller.enqueue(encoder.encode(`data: ${message}\n\n`))
        } catch {
          // Stream closed; ignore.
        }
      })

      try {
        await subscriber.subscribe(channel)
      } catch (err) {
        controller.enqueue(
          encoder.encode(
            `event: error\ndata: ${JSON.stringify({ message: String(err) })}\n\n`,
          ),
        )
        controller.close()
        return
      }

      // Heartbeat every 25s to keep proxies happy.
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': ping\n\n'))
        } catch {
          clearInterval(heartbeat)
        }
      }, 25_000)

      // Tear down on client disconnect.
      const abort = () => {
        clearInterval(heartbeat)
        subscriber.unsubscribe(channel).catch(() => {})
        subscriber.quit().catch(() => {})
        try {
          controller.close()
        } catch {
          // already closed
        }
      }

      req.signal.addEventListener('abort', abort)
    },
    cancel() {
      subscriber.unsubscribe(channel).catch(() => {})
      subscriber.quit().catch(() => {})
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}
