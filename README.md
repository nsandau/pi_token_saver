# Pi Token Saver

A [Pi](https://github.com/badlogic/pi-mono) package that retains recent tool results in model context and commits older text-only results to short archived-output pointers in reclaimable-token batches. It changes only the outgoing context—never session JSONL—and fails open if archiving or integrity verification is unavailable.

Each archive has an authoritative `.txt` payload and a small `.manifest.json` containing the originating session/tool identity and a SHA-256 of the payload. The extension verifies both before masking; it never overwrites a conflicting archive.

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
| `PI_TOOL_MASK_WINDOW` | `10` | Number of later model calls before a result becomes eligible for masking. |
| `PI_TOOL_MASK_BATCH_THRESHOLD` | `10000` | Reclaimable tokens required to commit eligible results as one masking batch. Set to `0` for immediate compatibility masking. |
| `PI_TOOL_MASK_ARCHIVE_DIR` | `~/.pi/agent/tool-result-archive` | Directory for archived results. |
| `PI_TOOL_MASK_MIN_SAVINGS_TOKENS` | `32` | Minimum estimated token saving before a result is masked. |
| `PI_TOOL_MASK_TOOLS` | `all` | Comma-separated tool allowlist. |
| `PI_TOOL_MASK_EXCLUDE_TOOLS` | empty | Comma-separated tool denylist. |

## Commands

- `/mask-stats` — display masking and provider-usage telemetry.
- `/mask-reset-stats` — reset in-memory telemetry.
- `/mask-toggle` — enable or disable masking for the current Pi process.
