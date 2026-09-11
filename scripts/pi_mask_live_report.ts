#!/usr/bin/env bun

/**
 * Live/historical masking report.
 *
 * Read-only analysis of:
 *   - Pi session JSONLs
 *   - mask archive manifests
 *   - persistent batch-commit ledgers, if present
 *
 * Reports:
 *   - substantive vs empty session files
 *   - OpenAI provider-reported usage
 *   - prompt-side/cache-read %
 *   - archive recovery tool calls found in persisted session history
 *   - unique recovery targets
 *   - exact recovery target rate when a batch-commit ledger exists
 *   - fallback recovery/archive rate when no ledger exists
 *
 * Run:
 *   bun pi_mask_live_report.ts
 *
 * Optional:
 *   --sessions ~/.pi/agent/sessions
 *   --archive ~/.pi/agent/tool-result-archive
 *   --providers openai
 *   --output ./mask-live-report
 */

// @ts-ignore -- Node built-in types may be supplied by Bun at runtime
import { readdir, readFile, mkdir } from "node:fs/promises";
// @ts-ignore -- Node built-in types may be supplied by Bun at runtime
import { homedir } from "node:os";
// @ts-ignore -- Node built-in types may be supplied by Bun at runtime
import { join, resolve, normalize, isAbsolute } from "node:path";

declare const Bun: any;
declare const process: any;

function parseArgs(argv: string[]) {
  const out: Record<string, string> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) continue;

    const eq = arg.indexOf("=");
    if (eq >= 0) {
      out[arg.slice(2, eq)] =
        arg.slice(eq + 1);
      continue;
    }

    const key =
      arg.slice(2);

    const next =
      argv[i + 1];

    if (
      next &&
      !next.startsWith("--")
    ) {
      out[key] = next;
      i++;
    } else {
      out[key] = "true";
    }
  }

  return out;
}

function expandHome(value: string): string {
  if (value === "~") {
    return homedir();
  }

  if (value.startsWith("~/")) {
    return join(
      homedir(),
      value.slice(2),
    );
  }

  return value;
}

async function walk(
  root: string,
  predicate:
    (path: string) => boolean =
      () => true,
): Promise<string[]> {
  const out: string[] = [];

  async function visit(dir: string) {
    let entries: any[];

    try {
      entries =
        await readdir(
          dir,
          {
            withFileTypes: true,
          },
        );
    } catch {
      return;
    }

    for (const entry of entries) {
      const full =
        join(
          dir,
          entry.name,
        );

      if (entry.isDirectory()) {
        await visit(full);
      } else if (
        entry.isFile() &&
        predicate(full)
      ) {
        out.push(full);
      }
    }
  }

  await visit(root);

  return out;
}

function parseProviderPrefixes(
  value: string,
): string[] | null {
  if (
    !value.trim() ||
    value.trim().toLowerCase() ===
      "all"
  ) {
    return null;
  }

  return value
    .split(",")
    .map(
      (x) => x.trim(),
    )
    .filter(Boolean);
}

function providerSelected(
  provider: string,
  prefixes: string[] | null,
): boolean {
  if (prefixes === null) {
    return true;
  }

  return prefixes.some(
    (prefix) =>
      provider.startsWith(prefix),
  );
}

function promptSide(
  usage: any,
): number {
  return (
    Number(usage?.input ?? 0) +
    Number(usage?.cacheRead ?? 0) +
    Number(usage?.cacheWrite ?? 0)
  );
}

function stringValues(
  value: unknown,
  out: string[] = [],
): string[] {
  if (typeof value === "string") {
    out.push(value);
    return out;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      stringValues(item, out);
    }
    return out;
  }

  if (
    value &&
    typeof value === "object"
  ) {
    for (
      const child of
      Object.values(
        value as Record<
          string,
          unknown
        >,
      )
    ) {
      stringValues(
        child,
        out,
      );
    }
  }

  return out;
}

function norm(path: string): string {
  return normalize(
    isAbsolute(path)
      ? path
      : resolve(path),
  );
}

function inside(
  candidate: string,
  root: string,
): boolean {
  const c = norm(candidate);
  const r = norm(root);

  return (
    c === r ||
    c.startsWith(
      r.endsWith("/")
        ? r
        : `${r}/`,
    )
  );
}

function exactArchivePaths(
  input: unknown,
  archiveRoot: string,
): string[] {
  const out =
    new Set<string>();

  for (
    const value of
    stringValues(input)
  ) {
    const expanded =
      expandHome(value);

    if (
      isAbsolute(expanded) &&
      inside(
        expanded,
        archiveRoot,
      )
    ) {
      out.add(
        norm(expanded),
      );
    }
  }

  return [...out];
}

function referencesArchive(
  input: unknown,
  archiveRoot: string,
): boolean {
  const root =
    norm(archiveRoot);

  return stringValues(input)
    .some((value) => {
      const expanded =
        expandHome(value);

      if (
        isAbsolute(expanded) &&
        inside(
          expanded,
          archiveRoot,
        )
      ) {
        return true;
      }

      return (
        value.includes(
          archiveRoot,
        ) ||
        value.includes(root) ||
        value.includes(
          "tool-result-archive",
        )
      );
    });
}

async function main() {
  const args =
    parseArgs(
      Bun.argv.slice(2),
    );

  const sessionsRoot =
    resolve(
      expandHome(
        args.sessions ??
        join(
          homedir(),
          ".pi",
          "agent",
          "sessions",
        ),
      ),
    );

  const archiveRoot =
    resolve(
      expandHome(
        args.archive ??
        join(
          homedir(),
          ".pi",
          "agent",
          "tool-result-archive",
        ),
      ),
    );

  const outputDir =
    resolve(
      args.output ??
      "./mask-live-report",
    );

  const providers =
    parseProviderPrefixes(
      args.providers ??
      "openai",
    );

  await mkdir(
    outputDir,
    { recursive: true },
  );

  const manifests =
    await walk(
      archiveRoot,
      (p) =>
        p.endsWith(
          ".manifest.json",
        ),
    );

  const txtFiles =
    await walk(
      archiveRoot,
      (p) =>
        p.endsWith(".txt"),
    );

  const ledgers =
    await walk(
      archiveRoot,
      (p) =>
        p.endsWith(
          "batch-commits.jsonl",
        ),
    );

  const pathToIdentity =
    new Map<
      string,
      {
        sessionId: string;
        toolCallId: string;
        toolName: string;
      }
    >();

  const archivedIdentities =
    new Set<string>();

  for (
    const manifestPath of
    manifests
  ) {
    try {
      const manifest =
        JSON.parse(
          await readFile(
            manifestPath,
            "utf8",
          ),
        );

      const txtPath =
        norm(
          manifestPath.replace(
            /\.manifest\.json$/,
            ".txt",
          ),
        );

      const sessionId =
        String(
          manifest.sessionId ?? "",
        );

      const toolCallId =
        String(
          manifest.toolCallId ?? "",
        );

      const toolName =
        String(
          manifest.toolName ??
          manifest.tool ??
          "",
        );

      if (
        sessionId &&
        toolCallId
      ) {
        const identity =
          `${sessionId}\u0000${toolCallId}`;

        archivedIdentities.add(
          identity,
        );

        pathToIdentity.set(
          txtPath,
          {
            sessionId,
            toolCallId,
            toolName,
          },
        );
      }
    } catch {
      // Archive-integrity script reports malformed manifests in detail.
    }
  }

  const committedIdentities =
    new Set<string>();

  for (
    const ledgerPath of ledgers
  ) {
    let text = "";

    try {
      text =
        await readFile(
          ledgerPath,
          "utf8",
        );
    } catch {
      continue;
    }

    const sessionDir =
      norm(
        resolve(
          ledgerPath,
          "..",
        ),
      );

    // Try to discover sessionId from any manifest in the same directory.
    let sessionId = "";

    for (
      const identity of
      pathToIdentity.values()
    ) {
      // Cheap fallback: session ids are only needed to namespace toolCallId.
      if (identity.sessionId) {
        // We refine below when a manifest path matches this directory.
      }
    }

    for (
      const manifestPath of manifests
    ) {
      if (
        norm(
          resolve(
            manifestPath,
            "..",
          ),
        ) !== sessionDir
      ) {
        continue;
      }

      try {
        const manifest =
          JSON.parse(
            await readFile(
              manifestPath,
              "utf8",
            ),
          );

        if (
          manifest.sessionId
        ) {
          sessionId =
            String(
              manifest.sessionId,
            );
          break;
        }
      } catch {}
    }

    for (
      const line of
      text.split(/\r?\n/)
    ) {
      if (!line.trim()) continue;

      try {
        const row =
          JSON.parse(line);

        const ids =
          Array.isArray(
            row.toolCallIds,
          )
            ? row.toolCallIds
            : Array.isArray(
                row.tool_call_ids,
              )
              ? row.tool_call_ids
              : [];

        for (const id of ids) {
          if (
            typeof id !==
            "string"
          ) {
            continue;
          }

          committedIdentities.add(
            `${sessionId || sessionDir}\u0000${id}`,
          );
        }
      } catch {
        // Ignore malformed lines here; archive audit can be extended for ledger
        // validation if needed.
      }
    }
  }

  const sessionFiles =
    await walk(
      sessionsRoot,
      (p) =>
        p.endsWith(".jsonl"),
    );

  let parsedSessions = 0;
  let substantiveSessions = 0;
  let selectedAssistantCalls = 0;

  const usage = {
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    reasoning: 0,
  };

  let recoveryToolCalls = 0;

  const uniqueRecoveryPaths =
    new Set<string>();

  const recoveredIdentities =
    new Set<string>();

  const recoveryCalls:
    Record<string, unknown>[] = [];

  for (
    const sessionFile of
    sessionFiles
  ) {
    let text: string;

    try {
      text =
        await readFile(
          sessionFile,
          "utf8",
        );
    } catch {
      continue;
    }

    let rows: any[];

    try {
      rows =
        text
          .split(/\r?\n/)
          .filter(
            (line) =>
              line.trim(),
          )
          .map(
            (line) =>
              JSON.parse(line),
          );
    } catch {
      continue;
    }

    parsedSessions++;

    const assistants =
      rows.filter(
        (row) =>
          row?.type ===
            "message" &&
          row?.message?.role ===
            "assistant",
      );

    if (assistants.length) {
      substantiveSessions++;
    }

    for (const row of assistants) {
      const message =
        row.message;

      const provider =
        String(
          message?.provider ??
          "unknown",
        );

      if (
        providerSelected(
          provider,
          providers,
        ) &&
        message?.usage
      ) {
        selectedAssistantCalls++;

        usage.input +=
          Number(
            message.usage.input ??
            0,
          );

        usage.cacheRead +=
          Number(
            message.usage.cacheRead ??
            0,
          );

        usage.cacheWrite +=
          Number(
            message.usage.cacheWrite ??
            0,
          );

        usage.output +=
          Number(
            message.usage.output ??
            0,
          );

        usage.reasoning +=
          Number(
            message.usage.reasoning ??
            0,
          );
      }

      if (
        !Array.isArray(
          message?.content,
        )
      ) {
        continue;
      }

      for (
        const block of
        message.content
      ) {
        if (
          block?.type !==
            "toolCall"
        ) {
          continue;
        }

        const argsObj =
          block.arguments ??
          {};

        if (
          !referencesArchive(
            argsObj,
            archiveRoot,
          )
        ) {
          continue;
        }

        recoveryToolCalls++;

        const exactPaths =
          exactArchivePaths(
            argsObj,
            archiveRoot,
          );

        for (
          const p of
          exactPaths
        ) {
          uniqueRecoveryPaths.add(
            p,
          );

          const identity =
            pathToIdentity.get(p);

          if (identity) {
            recoveredIdentities.add(
              `${identity.sessionId}\u0000${identity.toolCallId}`,
            );
          }
        }

        recoveryCalls.push({
          session_file:
            sessionFile,
          assistant_entry_id:
            row.id ?? "",
          tool_call_id:
            block.id ?? "",
          tool_name:
            block.name ?? "",
          exact_archive_paths:
            exactPaths.join(
              " | ",
            ),
        });
      }
    }
  }

  const promptSide =
    usage.input +
    usage.cacheRead +
    usage.cacheWrite;

  let exactCommittedRecovered = 0;

  if (
    committedIdentities.size > 0
  ) {
    // Ledgers may namespace with the session directory if sessionId couldn't be
    // resolved. For exact rate, count direct identity intersections only.
    for (
      const id of
      recoveredIdentities
    ) {
      if (
        committedIdentities.has(
          id,
        )
      ) {
        exactCommittedRecovered++;
      }
    }
  }

  const recoveryTargetRate =
    committedIdentities.size > 0
      ? (
          100 *
          exactCommittedRecovered /
          committedIdentities.size
        )
      : null;

  const archiveRecoveryRate =
    archivedIdentities.size > 0
      ? (
          100 *
          recoveredIdentities.size /
          archivedIdentities.size
        )
      : 0;

  const summary = {
    sessions_root:
      sessionsRoot,
    archive_root:
      archiveRoot,

    session_files_discovered:
      sessionFiles.length,
    sessions_parsed:
      parsedSessions,
    substantive_sessions:
      substantiveSessions,
    zero_assistant_session_files:
      parsedSessions -
      substantiveSessions,

    selected_provider_prefixes:
      providers ??
      ["all"],
    selected_assistant_calls:
      selectedAssistantCalls,

    input:
      usage.input,
    cache_read:
      usage.cacheRead,
    cache_write:
      usage.cacheWrite,
    output:
      usage.output,
    reasoning:
      usage.reasoning,
    prompt_side:
      promptSide,
    cache_read_pct:
      promptSide > 0
        ? (
            100 *
            usage.cacheRead /
            promptSide
          )
        : 0,

    txt_archives:
      txtFiles.length,
    manifests:
      manifests.length,
    archived_identity_count:
      archivedIdentities.size,

    batch_commit_ledgers:
      ledgers.length,
    committed_masked_identity_count:
      committedIdentities.size,

    recovery_tool_calls:
      recoveryToolCalls,
    unique_exact_recovery_paths:
      uniqueRecoveryPaths.size,
    unique_recovered_archived_results:
      recoveredIdentities.size,

    recovery_target_rate_pct:
      recoveryTargetRate,

    recovery_target_rate_note:
      committedIdentities.size > 0
        ? "Exact denominator uses persistent batch-commit ledger identities when session IDs could be resolved."
        : "Unavailable because no batch-commit ledger was found.",

    recovery_archive_rate_pct:
      archiveRecoveryRate,

    recovery_archive_rate_note:
      "Fallback only: unique recovered archived results / unique archived manifest identities. Archived can exceed actually masked, so this is NOT the preferred masking recovery rate.",

    recoveries_per_100_llm_calls:
      selectedAssistantCalls > 0
        ? (
            100 *
            recoveryToolCalls /
            selectedAssistantCalls
          )
        : 0,
  };

  await Bun.write(
    join(
      outputDir,
      "mask_live_summary.json",
    ),
    JSON.stringify(
      summary,
      null,
      2,
    ),
  );

  const csv = [
    [
      "session_file",
      "assistant_entry_id",
      "tool_call_id",
      "tool_name",
      "exact_archive_paths",
    ].join(","),
    ...recoveryCalls.map(
      (row) =>
        Object.values(row)
          .map((value) => {
            const s =
              String(
                value ?? "",
              );
            return /[",\n\r]/.test(s)
              ? `"${s.replaceAll('"', '""')}"`
              : s;
          })
          .join(","),
    ),
  ].join("\n") + "\n";

  await Bun.write(
    join(
      outputDir,
      "mask_recovery_calls.csv",
    ),
    csv,
  );

  console.log(
    "\nMASK LIVE / HISTORICAL REPORT",
  );
  console.log(
    "=".repeat(66),
  );

  console.log(
    `substantive sessions:         ${substantiveSessions}/${parsedSessions}`,
  );
  console.log(
    `selected assistant calls:     ${selectedAssistantCalls}`,
  );
  console.log(
    `prompt-side tokens:           ${promptSide.toLocaleString("en-US")}`,
  );
  console.log(
    `cache-read pct:               ${summary.cache_read_pct.toFixed(1)}%`,
  );
  console.log(
    `archived identities:          ${archivedIdentities.size}`,
  );
  console.log(
    `committed masked identities:  ${committedIdentities.size || "n/a"}`,
  );
  console.log(
    `recovery tool calls:          ${recoveryToolCalls}`,
  );
  console.log(
    `unique recovered results:     ${recoveredIdentities.size}`,
  );

  if (
    recoveryTargetRate !== null
  ) {
    console.log(
      `recovery target rate:        ${recoveryTargetRate.toFixed(2)}%`,
    );
  } else {
    console.log(
      `recovery target rate:        n/a (no batch-commit ledger)`,
    );
  }

  console.log(
    `fallback recovery/archive:    ${archiveRecoveryRate.toFixed(2)}%`,
  );
  console.log(
    `recoveries / 100 LLM calls:   ${summary.recoveries_per_100_llm_calls.toFixed(2)}`,
  );

  console.log(
    `\nWrote ${join(outputDir, "mask_live_summary.json")}`,
  );
  console.log(
    `Wrote ${join(outputDir, "mask_recovery_calls.csv")}`,
  );
}

await main();
