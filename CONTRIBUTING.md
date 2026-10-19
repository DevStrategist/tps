# Contributing

Thanks for helping. The project is deliberately small: two source files and one test file.

```sh
git clone https://github.com/DevStrategist/tps.git
cd tps
bun test                 # runs the proxy against a fake streaming upstream
bun tps.ts --help        # run from source, no install needed
bun link                 # optional: point the global `tps` command at your checkout
```

## Layout

| File | What it does |
|------|--------------|
| `proxy.ts` | The local proxy: forwards requests, parses the streaming response, records TTFT / tokens / tokens-per-sec. |
| `tps.ts` | The command: per-CLI launch setup, the live table (`tps`), the status bar (`tps <cli>`). |
| `proxy.test.ts` | Measurement test against a fake upstream with known delays. |
| `docs/how-it-works.md` | Design notes: how each CLI is wired in, what is measured, known limits. |

## Adding a CLI

1. Add an entry to `launchers` in `tps.ts`. It receives the user's args and returns `[argv, extraEnv]`. The job is to
   make the CLI send its model traffic to `http://127.0.0.1:<port>/<upstream-host>/<path>` (the proxy forwards to
   `https://<upstream-host>/<path>`).
2. If the CLI's stream is not one of the formats the proxy already understands (Anthropic Messages, OpenAI Responses,
   OpenAI chat completions), extend `onData` in `proxy.ts`.
3. Add the CLI to the table in `README.md` and the wiring notes in `docs/how-it-works.md`.
4. Run the real CLI through it and check the numbers against what you expect.

## Guidelines

- Keep it dependency-free and small. Prefer deleting code to adding it.
- Anything touching the proxy's trust boundary (who may connect, what is logged) needs a test.
- The request log must never contain prompts, responses, headers or keys.
- Say what you tested: CLI, version, OS.

## Reporting a bug

Open an issue with: OS, Bun version (`bun --version`), CLI and version, the exact `tps` command, and what you saw
versus expected. If a number looks wrong, include the matching line from `~/.tps/requests.jsonl`.
