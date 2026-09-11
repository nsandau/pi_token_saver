#!/usr/bin/env bun

/**
 * Audit recoverable-tool-mask archive integrity.
 *
 * Checks:
 *   - .txt archives
 *   - .manifest.json manifests
 *   - SHA-256 and UTF-8 byte length when manifest fields are present
 *   - missing/orphan files
 *   - legacy full-content .json sidecars
 *   - duplicate session/tool identities
 *
 * This is read-only.
 *
 * Run:
 *   bun pi_mask_archive_audit.ts
 *
 * Or:
 *   bun pi_mask_archive_audit.ts \
 *     --archive ~/.pi/agent/tool-result-archive \
 *     --output ./mask-audit-output
 */

// @ts-ignore -- Node built-in types may be supplied by Bun at runtime
import { createHash } from "node:crypto";
// @ts-ignore -- Node built-in types may be supplied by Bun at runtime
import { readdir, readFile, mkdir } from "node:fs/promises";
// @ts-ignore -- Node built-in types may be supplied by Bun at runtime
import { homedir } from "node:os";
// @ts-ignore -- Node built-in types may be supplied by Bun at runtime
import { join, resolve, dirname, basename } from "node:path";

declare const Bun: any;
declare const process: any;

function parseArgs(argv: string[]) {
  const out: Record<string, string> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) continue;

    const eq = arg.indexOf("=");
    if (eq >= 0) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }

    const key = arg.slice(2);
    const next = argv[i + 1];

    if (next && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else {
      out[key] = "true";
    }
  }

  return out;
}

function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) {
    return join(
      homedir(),
      value.slice(2),
    );
  }
  return value;
}

async function walk(root: string): Promise<string[]> {
  const out: string[] = [];

  async function visit(dir: string) {
    let entries: any[];

    try {
      entries = await readdir(
        dir,
        { withFileTypes: true },
      );
    } catch {
      return;
    }

    for (const entry of entries) {
      const full = join(
        dir,
        entry.name,
      );

      if (entry.isDirectory()) {
        await visit(full);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  }

  await visit(root);
  return out;
}

function sha256(buf: Uint8Array): string {
  return createHash("sha256")
    .update(buf)
    .digest("hex");
}

function csvEscape(value: unknown): string {
  if (
    value === null ||
    value === undefined
  ) {
    return "";
  }

  const s = String(value);

  if (!/[",\n\r]/.test(s)) {
    return s;
  }

  return `"${s.replaceAll(
    '"',
    '""',
  )}"`;
}

function toCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return "";

  const headers =
    Object.keys(rows[0]!);

  return [
    headers
      .map(csvEscape)
      .join(","),
    ...rows.map((row) =>
      headers
        .map((h) =>
          csvEscape(row[h])
        )
        .join(",")
    ),
  ].join("\n") + "\n";
}

async function main() {
  const args = parseArgs(
    Bun.argv.slice(2),
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
      "./mask-archive-audit-output",
    );

  await mkdir(
    outputDir,
    { recursive: true },
  );

  const files =
    await walk(
      archiveRoot,
    );

  const txtFiles =
    files.filter(
      (p) => p.endsWith(".txt"),
    );

  const manifests =
    files.filter(
      (p) =>
        p.endsWith(
          ".manifest.json",
        ),
    );

  const legacyJson =
    files.filter(
      (p) =>
        p.endsWith(".json") &&
        !p.endsWith(
          ".manifest.json",
        ),
    );

  const txtSet =
    new Set(
      txtFiles.map((file) => resolve(file)),
    );

  const manifestSet =
    new Set(
      manifests.map((file) => resolve(file)),
    );

  const rows:
    Record<string, unknown>[] = [];

  const identityMap =
    new Map<string, string[]>();

  let valid = 0;
  let badHash = 0;
  let badBytes = 0;
  let missingTxt = 0;
  let malformedManifest = 0;
  let identityMismatches = 0;

  for (const manifestPath of manifests) {
    let manifest: any;

    try {
      manifest = JSON.parse(
        await readFile(
          manifestPath,
          "utf8",
        ),
      );
    } catch (error) {
      malformedManifest++;

      rows.push({
        status:
          "malformed_manifest",
        manifest:
          manifestPath,
        txt:
          "",
        session_id:
          "",
        tool_call_id:
          "",
        tool:
          "",
        expected_bytes:
          "",
        actual_bytes:
          "",
        expected_sha256:
          "",
        actual_sha256:
          "",
        note:
          String(error),
      });

      continue;
    }

    const txtPath =
      resolve(
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

    const identity =
      `${sessionId}\u0000${toolCallId}`;

    if (
      sessionId &&
      toolCallId
    ) {
      const list =
        identityMap.get(identity) ?? [];

      list.push(manifestPath);

      identityMap.set(
        identity,
        list,
      );
    }

    if (!txtSet.has(txtPath)) {
      missingTxt++;

      rows.push({
        status:
          "missing_txt",
        manifest:
          manifestPath,
        txt:
          txtPath,
        session_id:
          sessionId,
        tool_call_id:
          toolCallId,
        tool:
          toolName,
        expected_bytes:
          manifest.textBytes ?? "",
        actual_bytes:
          "",
        expected_sha256:
          manifest.textSha256 ?? "",
        actual_sha256:
          "",
        note:
          "manifest exists but .txt is missing",
      });

      continue;
    }

    const buf =
      await readFile(
        txtPath,
      );

    const actualBytes =
      buf.byteLength;

    const actualHash =
      sha256(buf);

    const expectedBytes =
      Number.isFinite(
        Number(
          manifest.textBytes,
        ),
      )
        ? Number(
            manifest.textBytes,
          )
        : null;

    const expectedHash =
      typeof manifest.textSha256 ===
        "string"
        ? manifest.textSha256
        : null;

    const bytesOk =
      expectedBytes === null ||
      expectedBytes ===
        actualBytes;

    const hashOk =
      expectedHash === null ||
      expectedHash ===
        actualHash;

    const identityOk =
      Boolean(
        sessionId &&
        toolCallId,
      );

    if (!bytesOk) badBytes++;
    if (!hashOk) badHash++;
    if (!identityOk) {
      identityMismatches++;
    }

    const status =
      bytesOk &&
      hashOk &&
      identityOk
        ? "valid"
        : "invalid";

    if (status === "valid") {
      valid++;
    }

    rows.push({
      status,
      manifest:
        manifestPath,
      txt:
        txtPath,
      session_id:
        sessionId,
      session_file:
        manifest.sessionFile ??
        "",
      tool_call_id:
        toolCallId,
      tool:
        toolName,
      manifest_version:
        manifest.version ?? "",
      expected_bytes:
        expectedBytes ?? "",
      actual_bytes:
        actualBytes,
      expected_sha256:
        expectedHash ?? "",
      actual_sha256:
        actualHash,
      note:
        [
          !bytesOk
            ? "byte length mismatch"
            : "",
          !hashOk
            ? "sha256 mismatch"
            : "",
          !identityOk
            ? "missing session/tool identity"
            : "",
        ]
          .filter(Boolean)
          .join("; "),
    });
  }

  const manifestTxtPaths =
    new Set(
      manifests.map(
        (p) =>
          resolve(
            p.replace(
              /\.manifest\.json$/,
              ".txt",
            ),
          ),
      ),
    );

  const orphanTxt =
    txtFiles.filter(
      (p) =>
        !manifestTxtPaths.has(
          resolve(p),
        ),
    );

  const duplicateIdentities =
    [...identityMap.entries()]
      .filter(
        ([, paths]) =>
          paths.length > 1,
      );

  const sessionDirs =
    new Set(
      txtFiles.map(
        (p) => dirname(p),
      ),
    );

  const summary = {
    archive_root:
      archiveRoot,
    files_total:
      files.length,
    session_directories:
      sessionDirs.size,
    txt_archives:
      txtFiles.length,
    manifests:
      manifests.length,
    valid_manifests:
      valid,
    malformed_manifests:
      malformedManifest,
    missing_txt_for_manifest:
      missingTxt,
    orphan_txt_without_manifest:
      orphanTxt.length,
    bad_sha256:
      badHash,
    bad_byte_length:
      badBytes,
    missing_identity_fields:
      identityMismatches,
    duplicate_session_tool_identities:
      duplicateIdentities.length,
    legacy_json_sidecars:
      legacyJson.length,
  };

  await Bun.write(
    join(
      outputDir,
      "archive_integrity_summary.json",
    ),
    JSON.stringify(
      {
        summary,
        orphan_txt:
          orphanTxt,
        duplicate_identities:
          duplicateIdentities.map(
            ([identity, paths]) => ({
              identity,
              paths,
            }),
          ),
      },
      null,
      2,
    ),
  );

  await Bun.write(
    join(
      outputDir,
      "archive_integrity_details.csv",
    ),
    toCsv(rows),
  );

  console.log(
    "\nMASK ARCHIVE INTEGRITY AUDIT",
  );
  console.log(
    "=".repeat(58),
  );

  for (
    const [key, value] of
    Object.entries(summary)
  ) {
    console.log(
      `${key.padEnd(36)} ${value}`,
    );
  }

  const hardProblems =
    malformedManifest +
    missingTxt +
    badHash +
    badBytes +
    identityMismatches +
    duplicateIdentities.length;

  console.log();

  if (hardProblems === 0) {
    console.log(
      "PASS: no archive-integrity failures detected.",
    );
  } else {
    console.log(
      `FAIL: ${hardProblems} integrity problem(s) detected. Inspect archive_integrity_details.csv.`,
    );
    process.exitCode = 1;
  }

  if (
    orphanTxt.length > 0
  ) {
    console.log(
      `NOTE: ${orphanTxt.length} .txt archive(s) have no new manifest. These may be legacy/pre-manifest archives.`,
    );
  }

  if (
    legacyJson.length > 0
  ) {
    console.log(
      `NOTE: ${legacyJson.length} legacy .json sidecar(s) detected.`,
    );
  }

  console.log(
    `\nWrote ${join(outputDir, "archive_integrity_summary.json")}`,
  );
  console.log(
    `Wrote ${join(outputDir, "archive_integrity_details.csv")}`,
  );
}

await main();
