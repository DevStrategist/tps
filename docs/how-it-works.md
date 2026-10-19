# How tps works

## Overview

```
 coding CLI ──HTTP──▶  tps proxy (127.0.0.1:8787)  ──HTTPS──▶  model API
                          │  times the stream as it passes through
                          ▼
                 in-memory table + ~/.tps/requests.jsonl
                          ▲
        status bar / `tps` table poll /_tps/state
```

`tps <cli>` starts the proxy inside its own process (unless a proxy is already listening on the port), launches the
CLI with its model traffic redirected to the proxy, and renders a status bar by running the CLI inside a pseudo-terminal
one row shorter than your window. Plain `tps` starts the proxy if needed and draws the full table by polling
`/_tps/state` four times a second.

## The proxy (`proxy.ts`)

URLs have the form `/<upstream-host>/<path>`; the proxy forwards to `https://<upstream-host>/<path>`, streaming the
body back unchanged. That one rule serves every provider, so adding a CLI never needs proxy changes unless the stream
format is new.

Per request it records the model, when the request was forwarded, when the first content token arrived, when the last
one arrived, and the output token count. It understands three stream formats:

| Format | First-token event | Token usage |
|--------|-------------------|-------------|
| Anthropic Messages | `content_block_delta` | `usage.output_tokens` in `message_delta` |
| OpenAI Responses | `response.*.delta` | `response.usage.output_tokens` (+ `output_tokens_details.reasoning_tokens`) |
| OpenAI chat completions | `choices[0].delta` with content / reasoning / tool calls | `usage.completion_tokens` (+ `completion_tokens_details.reasoning_tokens`) |

Parsing happens on the bytes as they pass through, so timings reflect when data actually reached the proxy. A stream
without a `content-type` is treated as SSE (the Codex backend sends none). If the client disconnects (for example you
press Esc in the CLI), the upstream request is cancelled too instead of being read to the end.

Safety: the proxy binds to loopback, rejects requests carrying `Origin` or `Sec-Fetch-*` headers (browsers) and any
`Host` that isn't `127.0.0.1` / `localhost` (DNS rebinding). It does not hold or log credentials.

Port squatting: if the port is already taken when `tps` starts, it does not assume the listener is a tps proxy. It sends a random nonce to `/_tps/whoami` and requires the HMAC-SHA256 of that nonce under the per-user secret in `$TPS_HOME/secret` (file mode 0600, directory 0700). The answer is signed together with the proxy's own port, so a squatter can't relay the challenge to a real proxy on another port. A listener that can't answer is refused and the CLI is never launched, so API keys are not sent to it.

The check repeats twice a second while the CLI runs. If a proxy that `tps` attached to exits and something foreign takes the port, `tps` stops the CLI and exits with an error. This narrows the window to about half a second; it cannot close it, because loopback TCP has no stronger identity and these CLIs only accept an HTTP base URL (no Unix sockets).

## Metrics

- **TTFT** = first-content-token time − request-forwarded time. Measured at the proxy, so it excludes the CLI's own
  startup and prompt-building and includes network and the provider's queue, prefill and any hidden reasoning.
- **tokens/sec** = (output tokens − hidden reasoning tokens) ÷ (last token time − first token time), only when that
  window is at least 100 ms. Short single-burst replies have no measurable rate and show `-`.
- During a stream, tokens are counted from chunks (marked `~`) until the API reports real usage.

Known limits: providers that buffer hidden reasoning and flush the answer at once make tokens/sec unreliable (TTFT is
still correct). Anthropic does not break reasoning out of `output_tokens`, so replies with long hidden thinking and short
visible text read high.

## Wiring each CLI (`tps.ts`)

- **Claude Code**: `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>/api.anthropic.com`. The CLI keeps its own login.
- **Codex CLI**: a custom model provider is injected with `-c` (`model_provider="tps"`,
  `model_providers.tps={base_url=…, wire_api="responses", requires_openai_auth=true, supports_websockets=false}`).
  The upstream is `chatgpt.com/backend-api/codex` when `~/.codex/auth.json` says ChatGPT login, otherwise
  `api.openai.com/v1`. WebSockets are disabled so the stream can be timed over plain HTTP.
- **OpenCode**: `OPENCODE_CONFIG_CONTENT` overrides `provider.<id>.options.baseURL` for every provider found in your
  OpenCode config and login store, plus the selected model's provider. The real URL comes from your config, then the
  model catalog OpenCode caches, then built-in defaults for Anthropic and OpenAI. `--standalone` is added because the
  shared OpenCode background service would ignore per-process config.

## The status bar

When stdout and stdin are terminals, the CLI runs in a pseudo-terminal sized to your window minus one row. The scroll
region is limited to the top rows and the last row is redrawn about four times a second with the current numbers.
Keystrokes are forwarded to the CLI in raw mode, and window resizes are propagated. On exit the scroll region and
status row are restored. When output is piped, the CLI runs directly with no bar.

## Files

| Path | Purpose |
|------|---------|
| `~/.tps/requests.jsonl` | One JSON line per finished request (metadata only). The last 200 lines are reloaded on start. |
| `~/.tps/secret` | Per-user identity secret (mode 0600), used to prove a listener on the port is your own proxy. |
| `/_tps/state` | Local endpoint with the recent requests as JSON (used by the table and the bar). |
