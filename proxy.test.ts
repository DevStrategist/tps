import { expect, test } from "bun:test"
import { sign, startProxy } from "./proxy"

process.env.TPS_HOME ??= "/tmp/tps-test"

// Fake Anthropic upstream: 300ms before the first token, then 5 deltas 50ms apart, usage says 50 tokens.
test("measures TTFT, tokens and tps from an Anthropic-style SSE stream", async () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
  const enc = new TextEncoder()
  const upstream = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(
        new ReadableStream({
          async start(c) {
            const send = (o: object) => c.enqueue(enc.encode(`event: x\ndata: ${JSON.stringify(o)}\n\n`))
            send({ type: "message_start", message: { model: "claude-test", usage: { output_tokens: 1 } } })
            await sleep(300)
            for (let i = 0; i < 5; i++) {
              send({ type: "content_block_delta", delta: { type: "text_delta", text: "hi" } })
              await sleep(50)
            }
            send({ type: "message_delta", usage: { output_tokens: 50 } })
            c.close()
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  })

  const { server, reqs } = startProxy(0, "http")
  const res = await fetch(`http://127.0.0.1:${server.port}/127.0.0.1:${upstream.port}/v1/messages`, {
    method: "POST",
    headers: { "user-agent": "claude-cli/9.9" },
    body: JSON.stringify({ model: "claude-test" }),
  })
  expect(await res.text()).toContain("message_delta") // body passes through intact
  await sleep(50)

  const r = reqs.at(-1)!
  expect(r.cli).toBe("claude")
  expect(r.model).toBe("claude-test")
  expect(r.done).toBe(true)
  expect(r.ttft).toBeGreaterThan(280)
  expect(r.ttft).toBeLessThan(400)
  expect(r.tokens).toBe(50)
  expect(r.estimated).toBe(false)
  // 50 tokens over the ~200ms between first and last delta
  expect(r.tps).toBeGreaterThan(150)
  expect(r.tps).toBeLessThan(300)
  server.stop(true)
  upstream.stop(true)
})

test("refuses browser-originated requests", async () => {
  const { server } = startProxy(0, "http")
  const base = `http://127.0.0.1:${server.port}/example.com/`
  expect((await fetch(base, { headers: { origin: "https://evil.example" } })).status).toBe(403)
  expect((await fetch(base, { headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403)
  server.stop(true)
})

test("proves its identity to tps, and tps refuses a squatter on the port", async () => {
  const { server } = startProxy(0, "http")
  const nonce = "abc123"
  expect(await (await fetch(`http://127.0.0.1:${server.port}/_tps/whoami?nonce=${nonce}`)).text()).toBe(sign(nonce))
  server.stop(true)

  // A foreign listener that logs everything it receives and cannot sign the challenge.
  const seen: string[] = []
  const squatter = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => (seen.push(new URL(req.url).pathname), new Response("hi")) })
  const p = Bun.spawn(["bun", "tps.ts", "claude", "--version"], {
    env: { ...process.env, TPS_PORT: String(squatter.port) }, stdout: "pipe", stderr: "pipe",
  })
  expect(await p.exited).toBe(1)
  expect(await new Response(p.stderr).text()).toContain("refusing")
  expect(seen.every((x) => x.startsWith("/_tps/whoami"))).toBe(true) // only the challenge, no CLI traffic or keys
  squatter.stop(true)
})
