# tps

**Live time-to-first-token (TTFT) and tokens-per-second for the coding CLIs you already use.**

`tps` runs Claude Code, Codex or OpenCode through a tiny local proxy that times the *real* streaming response, so you
get exact TTFT and tokens/sec per request, per model, as you work. No scraping, no estimates from transcripts, no
changes to your prompts.

```
tps │ deepseek-ai/DeepSeek-V4.1-Flash │ TTFT 429ms │ 449.2 tok/s │ 134 tok │ median 312.0 tok/s over 6 req
```

- Works with **Claude Code**, **Codex CLI** and **OpenCode**, with any model they can talk to.
- A live **status bar** on the bottom row of your terminal while the CLI runs, or a full **table** in a side pane.
- Compare models and providers over time: every request is appended to a local JSONL log.
- Zero dependencies, two source files.

## Install

You need [Bun](https://bun.sh) (`curl -fsSL https://bun.sh/install | bash` if you don't have it). Then:

```sh
bun install -g github:DevStrategist/tps
```

Check it worked:

```sh
tps --version
```

Want to try it without installing? `bunx github:DevStrategist/tps claude`.

To update, run the install command again. To remove: `bun remove -g tps`.

## Use

Put `tps` in front of the CLI you normally run. Everything after the CLI name goes straight to that CLI, so you pick
models with the CLI's own flags.

```sh
tps claude                       # Claude Code
tps claude --model opus

tps codex                        # Codex CLI
tps codex -m gpt-6.1-sol

tps opencode                     # OpenCode
tps opencode -m anthropic/claude-sonnet-5-5
```

While the CLI runs, the bottom row of your terminal shows the current request: model, TTFT, tokens/sec, tokens so far,
and the median tokens/sec over the session. When the CLI exits, the bar disappears.

### Side pane: the full table

Run plain `tps` in a second terminal pane to see every request from every session that goes through the proxy,
plus a per-model summary (example output):

```
CLI      MODEL                                            N  TTFT med  TPS med
claude   claude-sonnet-5-5                                9     1.02s     84.1
opencode deepseek-ai/DeepSeek-V4.1-Flash-1017-Fast        4      364ms    141.7

TIME      CLI      MODEL                               TTFT     TPS   TOKENS    TOTAL  STATUS
15:02:30  opencode deepseek-ai/DeepSeek-V4.1-Flash-    660ms   141.7      880    1.93s  200
15:02:41  claude   claude-sonnet-5-5                   1.17s    84.2     ~320        …  streaming
```

Start `tps` first if you want to run several sessions at once. Otherwise the proxy lives only as long as the CLI that
started it.

## What the numbers mean

| Metric | Definition |
|--------|------------|
| **TTFT** | Time from the request being forwarded to the first *visible* content token arriving. Hidden reasoning counts as waiting. |
| **tokens/sec** | Output tokens ÷ time between the first and last token. Output tokens come from the API's own usage field, minus hidden reasoning tokens when the API reports them. |
| `~` prefix | The count is an estimate from stream chunks because the API hasn't reported usage yet (live rows). |
| `-` | Not measurable: the reply arrived in a single burst (less than 100 ms between first and last token), or the request wasn't a stream. |

Honest limits: some providers buffer hidden thinking and then flush the answer in one go. In that case TTFT is
correct (it really took that long to see output) but tokens/sec is unreliable, because the hidden tokens are counted
without their generation time. Treat tokens/sec as unreliable whenever TTFT is almost the whole request time.

## Supported CLIs

| CLI | How `tps` connects it | Notes |
|-----|-----------------------|-------|
| Claude Code (`claude`) | Sets `ANTHROPIC_BASE_URL` for the process. | Works with the CLI's normal login. |
| Codex CLI (`codex`) | Adds a `-c` model-provider override pointing at the proxy. | Uses your existing ChatGPT or API-key login. Forces plain HTTP streaming instead of WebSocket so the stream can be timed. |
| OpenCode (`opencode`) | Injects `OPENCODE_CONFIG_CONTENT` rewriting the base URL of every provider you have set up, and passes `--standalone`. | Switching models inside the UI stays measured. Providers with no discoverable API URL are not measured. |

Details and how to add another CLI: [docs/how-it-works.md](docs/how-it-works.md) and [CONTRIBUTING.md](CONTRIBUTING.md).

## Data and privacy

- The proxy listens on `127.0.0.1` only and refuses requests that come from a browser.
- Before sending your CLI to an already-running proxy, `tps` checks that it is *your* proxy (it must answer a challenge using a per-user secret in `~/.tps/secret`, mode 0600). If another program is squatting the port, `tps` refuses to start rather than hand it your API keys, and it keeps re-checking while the CLI runs.
- Your CLI's credentials pass through to the real API untouched. `tps` never stores or logs them.
- The log (`~/.tps/requests.jsonl`) holds **only metadata**: timestamp, CLI, API host, model, TTFT, token count,
  tokens/sec, duration, HTTP status. No prompts, no responses, no headers.
- Nothing is sent anywhere except to the API your CLI was already using.

## Requirements

- [Bun](https://bun.sh) 1.3 or newer (developed and tested on 1.3.14).
- macOS is tested. Linux should work. Windows is not supported (the status bar needs a pseudo-terminal).
- The CLI you want to measure, already installed and logged in.

## Configuration

| Variable | Default | Meaning |
|----------|---------|---------|
| `TPS_PORT` | `8787` | Port the proxy listens on. |
| `TPS_HOME` | `~/.tps` | Directory for the request log. |

## Troubleshooting

**`tps: command not found`** — Bun's bin directory isn't on your `PATH`. Add `export PATH="$HOME/.bun/bin:$PATH"` to
your shell profile and open a new terminal.

**`error: The current working directory was deleted`** — your terminal is sitting in a folder that no longer exists.
`cd ~` (or into a real project) and try again.

**The bar says "waiting for … requests"** — nothing has gone through the proxy yet. Send a prompt. If it stays that way,
the CLI is bypassing the proxy: for OpenCode check the provider is in your config or logged in; open an issue with the
CLI and version.

**Port already in use** — another `tps` (or something else) holds the port. Stop it, or set `TPS_PORT`.

**Codex or Claude Code asks for something odd after launching via `tps`** — run the CLI directly once to confirm it works
on its own, then compare. `tps` only changes where model traffic is sent.

## Development

```sh
git clone https://github.com/DevStrategist/tps.git && cd tps
bun test
bun tps.ts --help
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
