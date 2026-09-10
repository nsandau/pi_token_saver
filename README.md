# Pi Token Saver

A [Pi](https://github.com/badlogic/pi-mono) package that retains recent tool results in model context and replaces older text-only results with a short pointer to archived full output. It changes only the outgoing context—never session JSONL—and fails open if archiving is unavailable.

## Install

Install the published Git repository globally:

```bash
pi install git:github.com/nsandau/pi_token_saver
```

Or install it for one project:

```bash
pi install -l git:github.com/nsandau/pi_token_saver
```

Update the installed package with `pi update --extensions`.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `PI_TOOL_MASK_ENABLED` | `1` | Set to `0` to disable masking. |
| `PI_TOOL_MASK_WINDOW` | `10` | Number of later model calls that retain full tool output. |
| `PI_TOOL_MASK_ARCHIVE_DIR` | `~/.pi/agent/tool-result-archive` | Directory for archived results. |
| `PI_TOOL_MASK_MIN_SAVINGS_TOKENS` | `32` | Minimum estimated token saving before a result is masked. |
| `PI_TOOL_MASK_TOOLS` | `all` | Comma-separated tool allowlist. |
| `PI_TOOL_MASK_EXCLUDE_TOOLS` | empty | Comma-separated tool denylist. |

## Commands

- `/mask-stats` — display masking and provider-usage telemetry.
- `/mask-reset-stats` — reset in-memory telemetry.
- `/mask-toggle` — enable or disable masking for the current Pi process.
