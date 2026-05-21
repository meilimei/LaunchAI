/**
 * Diagnose Redis connectivity step by step.
 * Run with:  pnpm diag:redis
 *
 * Prints which layer fails: DNS / TCP / TLS / Auth / PING.
 */

import dns from 'node:dns/promises'
import net from 'node:net'
import tls from 'node:tls'
import { Redis } from 'ioredis'

const url: string = process.env.REDIS_URL ?? ''
if (!url) {
  console.error('REDIS_URL is not set. Run via: pnpm diag:redis')
  process.exit(1)
}

const parsed = new URL(url)
const host = parsed.hostname
const port = Number(parsed.port || (parsed.protocol === 'rediss:' ? 6379 : 6379))
const isTls = parsed.protocol === 'rediss:'

console.log(`Diagnosing ${parsed.protocol}//${host}:${port}`)
console.log('')

async function step(name: string, fn: () => Promise<unknown>) {
  process.stdout.write(`[${name}] ... `)
  try {
    const t = Date.now()
    const out = await fn()
    console.log(`OK (${Date.now() - t}ms)`, out ?? '')
    return true
  } catch (err) {
    console.log('FAIL')
    console.error(err)
    return false
  }
}

async function main() {
  // 1. DNS
  const dnsOk = await step('DNS A/AAAA lookup', async () => {
    const a = await dns.lookup(host, { all: true })
    return a.map((x) => `${x.family === 4 ? 'A' : 'AAAA'}=${x.address}`).join(', ')
  })
  if (!dnsOk) return

  // 2. Plain TCP
  const tcpOk = await step('Plain TCP connect', async () => {
    return new Promise<string>((resolveOk, reject) => {
      const sock = net.connect({ host, port, timeout: 5000 })
      sock.once('connect', () => {
        sock.destroy()
        resolveOk('connected')
      })
      sock.once('timeout', () => {
        sock.destroy()
        reject(new Error('TCP timeout (5s)'))
      })
      sock.once('error', reject)
    })
  })
  if (!tcpOk) return

  // 3. TLS handshake (if rediss://)
  if (isTls) {
    await step('TLS handshake', async () => {
      return new Promise<string>((resolveOk, reject) => {
        const sock = tls.connect({
          host,
          port,
          servername: host,
          timeout: 8000,
        })
        sock.once('secureConnect', () => {
          const proto = sock.getProtocol()
          sock.destroy()
          resolveOk(`${proto}, authorized=${sock.authorized}`)
        })
        sock.once('timeout', () => {
          sock.destroy()
          reject(new Error('TLS timeout (8s)'))
        })
        sock.once('error', reject)
      })
    })
  }

  // 4. ioredis PING
  await step('ioredis PING', async () => {
    const r = new Redis(url, {
      maxRetriesPerRequest: 1,
      enableReadyCheck: false,
      lazyConnect: false,
      family: 0,
      ...(isTls && { tls: { servername: host } }),
    })
    try {
      const pong = await r.ping()
      return pong
    } finally {
      r.disconnect()
    }
  })
}

main().catch(console.error)
