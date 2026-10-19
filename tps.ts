#!/usr/bin/env bun
// tps            live view of every request flowing through the proxy
// tps <cli> ...  run claude | codex | opencode through the proxy; args go straight to the CLI
import { randomBytes } from "node:crypto"
import { connect } from "node:net"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import pkg from "./package.json"
import { sign, startProxy, type Req } from "./proxy"

const PORT = Number(process.env.TPS_PORT ?? 8787)
const BASE = `http://127.0.0.1:${PORT}`
const [cmd, ...args] = process.argv.slice(2)

const USAGE = `tps - live TTFT and tokens/sec for coding CLIs

usage:
  tps                        live table of every request (run it in a side pane)
  tps <cli> [cli args...]    run a CLI through the proxy, with a live status bar
                             <cli>: claude | codex | opencode
  tps --help | --version

env:
  TPS_PORT   proxy port (default 8787)
  TPS_HOME   where the request log lives (default ~/.tps)`

const REFUSED = `tps: port ${PORT} is held by something that isn't your tps proxy; refusing to send your credentials to it.
Stop it, or set TPS_PORT to a free port.`

// Plain TCP connect: true only if the OS says connection refused, i.e. nothing is listening on the port.
// (Not derived from fetch's error codes, which differ between platforms and for connections cut mid-request.)
const nobodyListening = () =>
  new Promise<boolean>((resolve) => {
    const s = connect(PORT, "127.0.0.1")
    s.setTimeout(1000, () => { s.destroy(); resolve(false) })
    s.once("connect", () => { s.destroy(); resolve(false) })
    s.once("error", (e: NodeJS.ErrnoException) => resolve(e.code === "ECONNREFUSED"))
  })

// Does whatever listens on the port prove it is *our* proxy (same per-user secret, bound to this port)?
//   "ok"      it answered correctly
//   "refused" nothing is listening, so nothing can receive the CLI's API keys
//   "foreign" anything else: wrong answer, no answer (a squatter can accept and just hang), reset, garbage. Fail closed.
async function verify(): Promise<"ok" | "refused" | "foreign"> {
  const nonce = randomBytes(16).toString("hex")
  try {
    const got = await (await fetch(`${BASE}/_tps/whoami?nonce=${nonce}`, { signal: AbortSignal.timeout(2000) })).text()
    return got === sign(`${nonce}:${PORT}`) ? "ok" : "foreign"
  } catch { return (await nobodyListening()) ? "refused" : "foreign" }
}

// NOTE: an embedded proxy dies with the CLI that started it; keep `tps` open in a side pane to host it for several sessions.
async function ensureProxy() {
  try { startProxy(PORT); return } catch {}
  if ((await verify()) !== "ok") { console.error(REFUSED); process.exit(1) }
}

// Verified once at startup is not enough: if the proxy we attached to exits, a squatter could take the port while
// the CLI keeps running. Re-check twice a second and stop the CLI as soon as a foreign listener answers.
// NOTE: this narrows the window to ~0.5s, it can't close it; loopback TCP has no stronger identity.
let blocked = false
function guard(proc: { kill(): void }) {
  setInterval(async () => { if ((await verify()) === "foreign") { blocked = true; proc.kill() } }, 500)
}

const readJson = (p: string) => existsSync(p) ? Bun.JSONC.parse(readFileSync(p, "utf8")) as any : {}

// How each CLI gets pointed at the proxy: [argv, extra env].
const launchers: Record<string, (a: string[]) => [string[], Record<string, string>]> = {
  claude: (a) => [a, { ANTHROPIC_BASE_URL: `${BASE}/api.anthropic.com` }],

  // Custom provider so Codex talks plain HTTP SSE to us (no websocket), keeping the user's own login.
  codex: (a) => {
    const chatgpt = readJson(`${homedir()}/.codex/auth.json`).auth_mode === "chatgpt"
    const up = chatgpt ? "chatgpt.com/backend-api/codex" : "api.openai.com/v1"
    const p = `{name="tps",base_url="${BASE}/${up}",wire_api="responses",requires_openai_auth=true,supports_websockets=false}`
    return [["-c", 'model_provider="tps"', "-c", `model_providers.tps=${p}`, ...a], {}]
  },

  // OpenCode lets you switch models inside the TUI, so rewrite the baseURL of every provider you have set up
  // (config + logged-in), not just the default model's.
  opencode: (a) => {
    const cfgDir = `${homedir()}/.config/opencode`
    const cfg = { ...readJson(`${cfgDir}/opencode.json`), ...readJson(`${cfgDir}/opencode.jsonc`) }
    const i = a.findIndex((x) => x === "-m" || x === "--model")
    const model: string | undefined = (i >= 0 ? a[i + 1] : a.find((x) => x.startsWith("--model="))?.slice(8)) ?? cfg.model
    const catalog = readJson(`${homedir()}/.cache/opencode/models.json`)
    const known: Record<string, string> = { anthropic: "https://api.anthropic.com/v1", openai: "https://api.openai.com/v1" }
    const ids = new Set([
      ...Object.keys(cfg.provider ?? {}),
      ...Object.keys(readJson(`${homedir()}/.local/share/opencode/auth.json`)),
      ...(model ? [model.split("/")[0]] : []),
    ])
    const provider: Record<string, unknown> = {}
    for (const id of ids) {
      const real: string | undefined = cfg.provider?.[id]?.options?.baseURL ?? catalog[id]?.api ?? known[id]
      if (!real) continue // NOTE: providers with no discoverable URL (e.g. bundled gateways) stay unmeasured
      const u = new URL(real)
      provider[id] = { options: { baseURL: `${BASE}/${u.host}${u.pathname.replace(/\/$/, "")}` } }
    }
    if (!Object.keys(provider).length) throw new Error("opencode: no providers found to measure")
    // --standalone: the shared background service would ignore our config/env.
    const withFlag = a[0] === "run" ? ["run", "--standalone", ...a.slice(1)] : ["--standalone", ...a]
    return [withFlag, { OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider }) }]
  },
}

async function run(cli: string) {
  const [argv, env] = launchers[cli](args)
  await ensureProxy()
  const full = { ...process.env, ...env }
  const out = process.stdout
  if (!out.isTTY || !process.stdin.isTTY) { // piped / scripted: no status bar
    process.on("SIGINT", () => {}) // the CLI gets the same signal and decides what to do
    const child = Bun.spawn([cli, ...argv], { env: full, stdio: ["inherit", "inherit", "inherit"] })
    guard(child)
    const status = await child.exited
    if (blocked) { console.error(REFUSED); process.exit(1) }
    process.exit(status)
  }

  // Run the CLI in a pseudo-terminal one row short and keep a live status bar on the last row.
  const since = Date.now()
  let text = `tps · waiting for ${cli} requests`
  const region = () => out.write(`\x1b[${out.rows - 1};1H\x1b[1;${out.rows - 1}r\x1b[${out.rows - 1};1H`)
  const bar = () => out.write(`\x1b7\x1b[${out.rows};1H\x1b[2K\x1b[7m${text.slice(0, out.columns).padEnd(out.columns)}\x1b[0m\x1b8`)
  const proc = Bun.spawn([cli, ...argv], {
    env: full,
    terminal: { cols: out.columns, rows: out.rows - 1, data: (_t, d) => out.write(d) },
  })
  region()
  guard(proc)
  process.stdin.setRawMode(true)
  process.stdin.on("data", (d) => proc.terminal!.write(d)) // ctrl-c etc. reach the CLI as plain keystrokes
  out.on("resize", () => { proc.terminal!.resize(out.columns, out.rows - 1); region(); bar() })
  const tick = setInterval(async () => {
    try { text = statusText((await (await fetch(`${BASE}/_tps/state`)).json()) as Req[], cli, since) } catch {}
    bar()
  }, 250)

  const code = await proc.exited
  clearInterval(tick)
  process.stdin.setRawMode(false)
  out.write(`\x1b7\x1b[r\x1b[${out.rows};1H\x1b[2K\x1b8`) // drop scroll region + status row
  if (blocked) { console.error(REFUSED); process.exit(1) }
  process.exit(code)
}

// NOTE: shows every session of this CLI through the proxy since launch, not just this one
function statusText(all: Req[], cli: string, since: number) {
  const mine = all.filter((r) => r.cli === cli && r.startedAt >= since && (r.ttft !== null || !r.done))
  const cur = mine.findLast((r) => !r.done) ?? mine.at(-1)
  if (!cur) return `tps · waiting for ${cli} requests`
  const rate = median(mine.flatMap((r) => (r.done && r.tps !== null ? [r.tps] : [])))
  const tps = cur.tps === null ? "-" : (cur.done ? "" : "~") + cur.tps.toFixed(1)
  return `tps │ ${cur.model} │ TTFT ${dur(cur.ttft)} │ ${tps} tok/s │ ${cur.estimated && cur.tokens ? "~" : ""}${cur.tokens} tok │ median ${rate === null ? "-" : rate.toFixed(1)} tok/s over ${mine.filter((r) => r.done).length} req`
}

// ---- live view ----
const median = (xs: number[]) => (xs.length ? xs.toSorted((a, b) => a - b)[xs.length >> 1] : null)
const dur = (ms: number | null) => (ms == null ? "-" : ms < 1000 ? `${ms.toFixed(0)}ms` : `${(ms / 1000).toFixed(2)}s`)
const pad = (s: string | number, n: number) => String(s).slice(0, n).padEnd(n)
const padL = (s: string | number, n: number) => String(s).slice(0, n).padStart(n)
const BOLD = "\x1b[1m", DIM = "\x1b[2m", RESET = "\x1b[0m", GREEN = "\x1b[32m", RED = "\x1b[31m"

function draw(all: Req[]) {
  // NOTE: non-streaming calls (count_tokens, telemetry) are noise; show streams, in-flight and errors only
  const reqs = all.filter((r) => !r.done || r.ttft !== null || r.status >= 400)
  const rows = process.stdout.rows ?? 30
  const out: string[] = [`${BOLD}tps${RESET} ${DIM}proxy ${BASE} · ctrl-c to quit${RESET}`, ""]

  const groups = new Map<string, Req[]>()
  for (const r of reqs) if (r.done && r.ttft !== null) groups.set(`${r.cli}\0${r.model}`, [...(groups.get(`${r.cli}\0${r.model}`) ?? []), r])
  out.push(`${BOLD}${pad("CLI", 9)}${pad("MODEL", 46)}${padL("N", 5)}${padL("TTFT med", 10)}${padL("TPS med", 9)}${RESET}`)
  for (const [k, rs] of groups) {
    const [cli, model] = k.split("\0")
    const tps = median(rs.flatMap((r) => (r.tps === null ? [] : [r.tps])))
    out.push(`${pad(cli, 9)}${pad(model, 46)}${padL(rs.length, 5)}${padL(dur(median(rs.map((r) => r.ttft!))), 10)}${padL(tps === null ? "-" : tps.toFixed(1), 9)}`)
  }

  out.push("", `${BOLD}${pad("TIME", 10)}${pad("CLI", 9)}${pad("MODEL", 46)}${padL("TTFT", 9)}${padL("TPS", 8)}${padL("TOKENS", 9)}${padL("TOTAL", 9)}  STATUS${RESET}`)
  for (const r of reqs.slice(-Math.max(3, rows - out.length - 2)).reverse()) {
    const live = !r.done
    const status = live ? `${GREEN}streaming${RESET}` : r.status >= 400 ? `${RED}${r.status}${RESET}` : `${r.status}`
    out.push(
      pad(new Date(r.startedAt).toLocaleTimeString("en-GB"), 10) + pad(r.cli, 9) + pad(r.model, 46) +
        padL(dur(r.ttft), 9) + padL(r.tps === null ? "-" : r.tps.toFixed(1), 8) +
        padL((r.estimated && r.tokens ? "~" : "") + r.tokens, 9) + padL(live ? "…" : dur(r.ms), 9) + "  " + status,
    )
  }
  process.stdout.write("\x1b[H\x1b[2J" + out.join("\n") + "\n")
}

async function view() {
  await ensureProxy()
  process.stdout.write("\x1b[?1049h\x1b[?25l") // alt screen, hide cursor
  const quit = () => { process.stdout.write("\x1b[?25h\x1b[?1049l"); process.exit(0) }
  process.on("SIGINT", quit)
  for (;;) {
    try { draw((await (await fetch(`${BASE}/_tps/state`)).json()) as Req[]) } catch {}
    await Bun.sleep(250)
  }
}

if (cmd === "-h" || cmd === "--help" || cmd === "help") console.log(USAGE)
else if (cmd === "-v" || cmd === "--version") console.log(pkg.version)
else if (!cmd) await view()
else if (Object.hasOwn(launchers, cmd)) await run(cmd)
else { console.error(USAGE); process.exit(2) }
