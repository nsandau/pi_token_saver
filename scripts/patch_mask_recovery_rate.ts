#!/usr/bin/env bun

/**
 * Conservative source patcher:
 * Add two derived metrics to /mask-stats:
 *
 *   recovery target rate: X% (unique recovery targets / unique masked results)
 *   recoveries / 100 LLM calls: Y
 *
 * It makes a timestamped backup and refuses to patch if the expected source
 * pattern is absent.
 *
 * Run:
 *   bun patch_mask_recovery_rate.ts \
 *     --extension ~/.pi/agent/extensions/recoverable-tool-mask.ts
 */

// @ts-ignore -- Node built-in types may be supplied by Bun at runtime
import { readFile, writeFile, copyFile } from "node:fs/promises";
// @ts-ignore -- Node built-in types may be supplied by Bun at runtime
import { homedir } from "node:os";
// @ts-ignore -- Node built-in types may be supplied by Bun at runtime
import { join, resolve } from "node:path";

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

async function main() {
  const args =
    parseArgs(
      Bun.argv.slice(2),
    );

  const path =
    resolve(
      args.extension ??
      join(
        homedir(),
        ".pi",
        "agent",
        "extensions",
        "recoverable-tool-mask.ts",
      ),
    );

  const source =
    await readFile(
      path,
      "utf8",
    );

  if (
    source.includes(
      "recovery target rate:",
    )
  ) {
    console.log(
      "No change: recovery target rate is already present.",
    );
    return;
  }

  const lines =
    source.split("\n");

  const targetIndex =
    lines.findIndex(
      (line) =>
        line.includes(
          "`unique recovery targets:",
        ) ||
        line.includes(
          '"unique recovery targets:',
        ) ||
        line.includes(
          "'unique recovery targets:",
        ),
    );

  if (targetIndex < 0) {
    throw new Error(
      "Could not find the /mask-stats 'unique recovery targets' output line. Refusing to patch automatically.",
    );
  }

  const indent =
    lines[targetIndex]!
      .match(/^\s*/)?.[0] ??
    "";

  const inserted = [
    `${indent}\`recovery target rate:      \${formatPct(stats.recoveredArchivePaths.size, stats.uniqueMaskedResults.size)} (\${formatInt(stats.recoveredArchivePaths.size)} / \${formatInt(stats.uniqueMaskedResults.size)} masked)\`,`,
    `${indent}\`recoveries / 100 LLM calls: \${stats.providerUsage.calls ? ((100 * stats.recoveryToolCalls) / stats.providerUsage.calls).toFixed(2) : "0.00"}\`,`,
  ];

  lines.splice(
    targetIndex + 1,
    0,
    ...inserted,
  );

  const stamp =
    new Date()
      .toISOString()
      .replace(
        /[:.]/g,
        "-",
      );

  const backup =
    `${path}.bak-${stamp}`;

  await copyFile(
    path,
    backup,
  );

  await writeFile(
    path,
    lines.join("\n"),
    "utf8",
  );

  console.log(
    `Patched: ${path}`,
  );
  console.log(
    `Backup:  ${backup}`,
  );
  console.log(
    "Run /reload in Pi, then /mask-stats.",
  );
}

await main();
