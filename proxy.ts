// Local pass-through proxy: /<upstream-host>/<path> -> https://<upstream-host>/<path>.
// Times the streaming response (TTFT, tokens/sec) and keeps every request in memory + a JSONL log.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export type Req = {
  id: number
  cli: string
  host: string
  model: string
  startedAt: number // epoch ms
  ttft: number | null // ms, request forwarded -> first content token
  tokens: number
  estimated: boolean // true = counted stream chunks, false = API-reported usage
  tps: number | null // tokens / (last token - first token)
  ms: number | null // total request time
  status: number // 0 while pending
  done: boolean
}

const dir = process.env.TPS_HOME ?? join(homedir(), ".tps")
const LOG = join(dir, "requests.jsonl")
const MAX = 500

const cliOf = (ua: string, host: string) => ua.match(/opencode|codex|claude/i)?.[0].toLowerCase() ?? host

function loadLog(): Req[] {
  if (!existsSync(LOG)) return []
  return readFileSync(LOG, "utf8").trim().split("\n").slice(-200).flatMap((l) => {
    try { return [JSON.parse(l) as Req] } catch { return [] }
  })
}

// Throws if the port is taken (caller treats that as "a proxy is already running").
export function startProxy(port: number, scheme = "https") {
  mkdirSync(dir, { recursive: true })
  const reqs = loadLog()
  let nextId = Math.max(0, ...reqs.map((r) => r.id)) + 1

  const server = Bun.serve({
    hostname: "127.0.0.1", // loopback only: this is an open relay to any upstream host
    port,
    idleTimeout: 0, // streams can be long
    async fetch(req) {
      // Only local CLIs may use this relay: refuse browsers (Origin / Sec-Fetch-*) and DNS-rebinding (foreign Host).
      if (req.headers.has("origin") || req.headers.has("sec-fetch-site") || !/^(127\.0\.0\.1|localhost):\d+$/.test(req.headers.get("host") ?? ""))
        return new Response("forbidden", { status: 403 })
      const url = new URL(req.url)
      if (url.pathname === "/_tps/state") return Response.json(reqs.slice(-200))
      const [, host, ...rest] = url.pathname.split("/")
      if (!host) return new Response("tps proxy", { status: 404 })

      const body = req.body ? await req.arrayBuffer() : undefined
      const headers = new Headers(req.headers)
      for (const h of ["host", "accept-encoding", "content-length"]) headers.delete(h)

      let model = "?"
      try { model = JSON.parse(new TextDecoder().decode(body)).model ?? "?" } catch {}
      const r: Req = {
        id: nextId++, cli: cliOf(req.headers.get("user-agent") ?? "", host), host, model,
        startedAt: Date.now(), ttft: null, tokens: 0, estimated: true, tps: null, ms: null, status: 0, done: false,
      }
      reqs.push(r)
      if (reqs.length > MAX) reqs.shift()

      const t0 = performance.now()
      let tFirst = 0, tLast = 0, ticks = 0, usage: number | null = null, hidden = 0
      const finish = (status: number) => {
        if (r.done) return
        r.done = true
        r.status ||= status
        r.ms = performance.now() - t0
        appendFileSync(LOG, JSON.stringify(r) + "\n")
      }

      let up: Response
      try {
        up = await fetch(`${scheme}://${host}/${rest.join("/")}${url.search}`, {
          method: req.method, headers, body, redirect: "manual",
        })
      } catch (e) {
        finish(502)
        return new Response(String(e), { status: 502 })
      }
      r.status = up.status
      const out = new Headers(up.headers)
      out.delete("content-encoding") // fetch already decoded the body
      out.delete("content-length")
      if (!up.body) { finish(up.status); return new Response(null, { status: up.status, headers: out }) }

      // Codex (ChatGPT backend) streams SSE with no content-type at all, so "missing" counts as SSE too.
      const ct = up.headers.get("content-type")
      const sse = !ct || ct.includes("text/event-stream")
      const dec = new TextDecoder()
      let buf = ""

      // One parsed SSE `data:` payload. Covers Anthropic Messages, OpenAI Responses, OpenAI chat completions.
      const onData = (s: string) => {
        let j: any
        try { j = JSON.parse(s) } catch { return }
        const now = performance.now()
        const t: string = j.type ?? ""
        const d = j.choices?.[0]?.delta
        if (t === "content_block_delta" || /^response\..*\.delta$/.test(t) || d?.content || d?.reasoning_content || d?.reasoning || d?.tool_calls) {
          ticks++
          tFirst ||= now
          tLast = now
        }
        const u = j.usage ?? j.message?.usage ?? j.response?.usage
        const n = u?.output_tokens ?? u?.completion_tokens
        if (typeof n === "number") usage = n
        // Hidden reasoning is generated before the first visible token, so keep it out of the visible-window rate.
        hidden = u?.output_tokens_details?.reasoning_tokens ?? u?.completion_tokens_details?.reasoning_tokens ?? hidden
        const m = j.message?.model ?? j.response?.model ?? j.model
        if (typeof m === "string") r.model = m
        r.tokens = usage ?? ticks
        r.estimated = usage === null
        if (tFirst) {
          r.ttft = tFirst - t0
          // NOTE: a reply that lands in one burst has no measurable rate; 100ms floor, tune if needed
          r.tps = r.tokens - hidden > 1 && tLast - tFirst >= 100 ? (r.tokens - hidden) / ((tLast - tFirst) / 1000) : null
        }
      }

      const reader = up.body.getReader()
      const stream = new ReadableStream({
        async pull(ctrl) {
          try {
            const { done, value } = await reader.read()
            if (done) { finish(up.status); ctrl.close(); return }
            if (sse) {
              buf += dec.decode(value, { stream: true })
              let i
              while ((i = buf.indexOf("\n")) >= 0) {
                const line = buf.slice(0, i).trim()
                buf = buf.slice(i + 1)
                if (line.startsWith("data:")) onData(line.slice(5).trim())
              }
            }
            ctrl.enqueue(value)
          } catch (e) { finish(up.status); ctrl.error(e) }
        },
        // Client aborted (e.g. Esc in the CLI): stop pulling from upstream too.
        cancel(reason) { finish(up.status); return reader.cancel(reason) },
      })
      return new Response(stream, { status: up.status, headers: out })
    },
  })
  return { server, reqs }
}
