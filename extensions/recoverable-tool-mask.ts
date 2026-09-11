
/**
 * Recoverable Tool-Result Masking for Pi
 *
 * Purpose
 * -------
 * Keep recent tool results verbatim, then replace older text-only tool results
 * in the outgoing LLM context with a small pointer stub. The original result is
 * archived on disk first, so the model can recover it with Pi's read tool.
 *
 * This extension is deliberately non-destructive:
 * - It only changes the deep-copied messages provided by Pi's `context` hook.
 * - It does NOT rewrite the session JSONL.
 * - If archival fails, the original result is left untouched (fail-open).
 * - Results containing images are left untouched.
 * - Tiny results are left untouched when masking would not save enough tokens.
 *
 * Install
 * -------
 *   pi install git:github.com/nsandau/pi_token_saver
 *
 * Pi discovers this extension from the package's conventional `extensions/` directory.
 *
 * Default configuration
 * ---------------------
 *   keep recent model calls: 10
 *   archive dir: ~/.pi/agent/tool-result-archive
 *   mask all text-only tools when worthwhile
 *
 * Environment variables
 * ---------------------
 *   PI_TOOL_MASK_ENABLED=1|0
 *   PI_TOOL_MASK_WINDOW=10
 *   PI_TOOL_MASK_BATCH_THRESHOLD=10000
 *   PI_TOOL_MASK_ARCHIVE_DIR=/path/to/archive
 *   PI_TOOL_MASK_MIN_SAVINGS_TOKENS=32
 *   PI_TOOL_MASK_TOOLS=all                 # or: read,bash,grep
 *   PI_TOOL_MASK_EXCLUDE_TOOLS=            # e.g.: edit,write
 *
 * Commands
 * --------
 *   /mask-stats
 *   /mask-reset-stats
 *
 * Notes
 * -----
 * Token counts are estimates (text characters / 4) used only for local
 * telemetry and the "worth masking?" check. Provider-reported usage is tracked
 * separately from finalized assistant messages.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, resolve } from "node:path";

const DEFAULT_WINDOW = 10;
const DEFAULT_BATCH_THRESHOLD_TOKENS = 10_000;
const DEFAULT_MIN_SAVINGS_TOKENS = 32;

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  return !["0", "false", "no", "off"].includes(raw.trim().toLowerCase());
}

function envInt(name: string, fallback: number, min = 0): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
}

function expandHome(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return join(homedir(), input.slice(2));
  }
  return input;
}

function archiveRootFromEnv(): string {
  const configured = process.env.PI_TOOL_MASK_ARCHIVE_DIR?.trim();
  const raw = configured || join(homedir(), ".pi", "agent", "tool-result-archive");
  return resolve(expandHome(raw));
}

function parseToolSet(raw: string | undefined): Set<string> | null {
  const value = (raw ?? "all").trim();
  if (!value || value.toLowerCase() === "all" || value === "*") return null;
  return new Set(
    value
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean),
  );
}

function parseExcludeSet(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean),
  );
}

function safeComponent(value: string, maxLen = 80): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return (cleaned || "unknown").slice(0, maxLen);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function shortHash(value: string): string {
  return sha256(value).slice(0, 20);
}

function estimateTokensFromChars(chars: number): number {
  return Math.ceil(chars / 4);
}

function formatInt(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function formatPct(numerator: number, denominator: number): string {
  if (!denominator) return "0.0%";
  return `${((100 * numerator) / denominator).toFixed(1)}%`;
}

type AnyMessage = any;
type AnyContentBlock = any;

type ToolCallInfo = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

type ArchiveManifest = {
  version: 2;
  sessionId: string;
  sessionFile: string | null;
  toolCallId: string;
  toolName: string;
  isError: boolean;
  originalEstimatedTokens: number;
  textBytes: number;
  textSha256: string;
  archivedAt: string;
};

type ArchiveRecord = {
  txtPath: string;
  manifestPath: string;
  created: boolean;
  verified: true;
};

type MaskCandidate = {
  index: number;
  message: AnyMessage;
  key: string;
  toolName: string;
  originalTokens: number;
  pointerPath: string;
  stub: string;
  stubTokens: number;
  reclaimableTokens: number;
  needsArchive: boolean;
};

class ArchiveIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchiveIntegrityError";
  }
}

type BatchCommit = {
  version: 1;
  batchId: string;
  committedAt: string;
  threshold: number;
  toolCallIds: string[];
  reclaimableTokens: number;
};

type ProviderUsageTotals = {
  calls: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  totalTokens: number;
};

type MaskStats = {
  sessionId: string;
  contextCalls: number;
  maskApplications: number;
  uniqueMaskedResults: Set<string>;
  uniqueArchivedResults: Set<string>;
  skippedImageResults: number;
  skippedTooSmallResults: number;
  archiveFailures: number;
  archiveIntegrityFailures: number;
  archiveVerifications: number;
  archiveManifestCreations: number;
  recoveryToolCalls: number;
  recoveredArchivePaths: Set<string>;
  estimatedExposureAvoided: number;
  estimatedOriginalMaskedTokens: number;
  estimatedStubTokens: number;
  archiveBytesWritten: number;
  currentOriginalToolTokens: number;
  currentAfterMaskToolTokens: number;
  currentSavedTokens: number;
  currentMaskedResults: number;
  batchEvents: number;
  batchCommittedResults: number;
  batchCommittedTokens: number;
  currentWaitingEligibleResults: number;
  currentWaitingEligibleTokens: number;
  currentCommittedMaskedResults: number;
  lastBatchResults: number;
  lastBatchTokens: number;
  providerUsage: ProviderUsageTotals;
};

function newStats(sessionId = ""): MaskStats {
  return {
    sessionId,
    contextCalls: 0,
    maskApplications: 0,
    uniqueMaskedResults: new Set(),
    uniqueArchivedResults: new Set(),
    skippedImageResults: 0,
    skippedTooSmallResults: 0,
    archiveFailures: 0,
    archiveIntegrityFailures: 0,
    archiveVerifications: 0,
    archiveManifestCreations: 0,
    recoveryToolCalls: 0,
    recoveredArchivePaths: new Set(),
    estimatedExposureAvoided: 0,
    estimatedOriginalMaskedTokens: 0,
    estimatedStubTokens: 0,
    archiveBytesWritten: 0,
    currentOriginalToolTokens: 0,
    currentAfterMaskToolTokens: 0,
    currentSavedTokens: 0,
    currentMaskedResults: 0,
    batchEvents: 0,
    batchCommittedResults: 0,
    batchCommittedTokens: 0,
    currentWaitingEligibleResults: 0,
    currentWaitingEligibleTokens: 0,
    currentCommittedMaskedResults: 0,
    lastBatchResults: 0,
    lastBatchTokens: 0,
    providerUsage: {
      calls: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      totalTokens: 0,
    },
  };
}

function isToolResultMessage(message: AnyMessage): boolean {
  return message?.role === "toolResult" && typeof message?.toolCallId === "string";
}

function hasImageContent(content: unknown): boolean {
  return Array.isArray(content) && content.some((block) => block?.type === "image");
}

function textBlocks(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const block of content) {
    if (block?.type === "text" && typeof block.text === "string") out.push(block.text);
  }
  return out;
}

function contentTextChars(content: unknown): number {
  return textBlocks(content).reduce((sum, text) => sum + text.length, 0);
}

function textForArchive(content: unknown): string {
  const blocks = textBlocks(content);
  if (blocks.length <= 1) return blocks[0] ?? "";
  return blocks
    .map((text, i) => `===== TEXT BLOCK ${i + 1}/${blocks.length} =====\n${text}`)
    .join("\n\n");
}

function buildToolCallMap(messages: AnyMessage[]): Map<string, ToolCallInfo> {
  const map = new Map<string, ToolCallInfo>();
  for (const message of messages) {
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block?.type !== "toolCall" || typeof block.id !== "string") continue;
      map.set(block.id, {
        id: block.id,
        name: typeof block.name === "string" ? block.name : "unknown",
        arguments:
          block.arguments && typeof block.arguments === "object"
            ? block.arguments
            : {},
      });
    }
  }
  return map;
}

/**
 * Number of already-completed assistant/model responses after each message.
 * With window=10, a result remains full for the next 10 model requests and is
 * first masked on the 11th subsequent request.
 */
function assistantCallsAfter(messages: AnyMessage[]): number[] {
  const result = new Array<number>(messages.length).fill(0);
  let completedAssistantCalls = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    result[i] = completedAssistantCalls;
    if (messages[i]?.role === "assistant") completedAssistantCalls++;
  }
  return result;
}

function shouldIncludeTool(
  toolName: string,
  includeTools: Set<string> | null,
  excludeTools: Set<string>,
): boolean {
  if (excludeTools.has(toolName)) return false;
  return includeTools == null || includeTools.has(toolName);
}

function stringValues(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) stringValues(item, out);
    return out;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) {
      stringValues(item, out);
    }
  }
  return out;
}

function normalizedAbsolute(candidate: string): string {
  return normalize(isAbsolute(candidate) ? candidate : resolve(candidate));
}

function isInsidePath(candidate: string, root: string): boolean {
  try {
    const c = normalizedAbsolute(candidate);
    const r = normalizedAbsolute(root);
    return c === r || c.startsWith(r.endsWith("/") || r.endsWith("\\") ? r : `${r}${process.platform === "win32" ? "\\" : "/"}`);
  } catch {
    return false;
  }
}

/** If this tool call is a read of an archive file, return that file directly. */
function archiveReadTarget(call: ToolCallInfo | undefined, archiveRoot: string): string | null {
  if (!call || call.name !== "read") return null;
  const p = call.arguments?.path;
  if (typeof p !== "string") return null;
  const expanded = expandHome(p);
  if (!isInsidePath(expanded, archiveRoot)) return null;
  return normalizedAbsolute(expanded);
}

function containsArchiveReference(input: unknown, archiveRoot: string): string | null {
  const rootNorm = normalizedAbsolute(archiveRoot);
  for (const value of stringValues(input)) {
    const expanded = expandHome(value);
    // Direct path argument.
    if (isAbsolute(expanded) && isInsidePath(expanded, archiveRoot)) {
      return normalizedAbsolute(expanded);
    }
    // Bash commands and other composite string arguments may contain the path.
    if (value.includes(archiveRoot) || value.includes(rootNorm) || value.includes("tool-result-archive")) {
      return value;
    }
  }
  return null;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function writeOnce(path: string, data: string): Promise<boolean> {
  try {
    await writeFile(path, data, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return true;
  } catch (error: any) {
    if (error?.code === "EEXIST") return false;
    throw error;
  }
}

function getSessionArchiveDir(
  archiveRoot: string,
  sessionId: string,
  sessionFile: string | null,
): string {
  const fingerprint = shortHash(`${sessionId}\n${sessionFile ?? ""}`);
  return join(archiveRoot, `${safeComponent(sessionId, 40)}-${fingerprint}`);
}

function archivePaths(params: {
  archiveRoot: string;
  sessionId: string;
  sessionFile: string | null;
  message: AnyMessage;
}): { sessionDir: string; txtPath: string; manifestPath: string } {
  const { archiveRoot, sessionId, sessionFile, message } = params;
  const sessionDir = getSessionArchiveDir(archiveRoot, sessionId, sessionFile);
  const toolName = safeComponent(String(message.toolName ?? "tool"), 40);
  const base = `${toolName}-${shortHash(String(message.toolCallId))}`;
  return {
    sessionDir,
    txtPath: join(sessionDir, `${base}.txt`),
    manifestPath: join(sessionDir, `${base}.manifest.json`),
  };
}

function maskKey(sessionId: string, toolCallId: string): string {
  return `${sessionId}:${toolCallId}`;
}

function batchCommitPath(sessionDir: string): string {
  return join(sessionDir, "batch-commits.jsonl");
}

function isBatchCommit(value: unknown): value is BatchCommit {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<BatchCommit>;
  return (
    record.version === 1 &&
    typeof record.batchId === "string" &&
    typeof record.committedAt === "string" &&
    typeof record.threshold === "number" &&
    Array.isArray(record.toolCallIds) &&
    record.toolCallIds.every((id) => typeof id === "string") &&
    typeof record.reclaimableTokens === "number"
  );
}

async function loadCommittedMaskKeys(params: {
  sessionDir: string;
  sessionId: string;
}): Promise<Set<string>> {
  const { sessionDir, sessionId } = params;
  let contents: string;
  try {
    contents = await readFile(batchCommitPath(sessionDir), "utf8");
  } catch (error: any) {
    if (error?.code === "ENOENT") return new Set();
    throw error;
  }

  const keys = new Set<string>();
  for (const [lineNumber, line] of contents.split("\n").entries()) {
    if (!line.trim()) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      throw new ArchiveIntegrityError(`Invalid batch commit record at line ${lineNumber + 1}`);
    }
    if (!isBatchCommit(record)) {
      throw new ArchiveIntegrityError(`Invalid batch commit schema at line ${lineNumber + 1}`);
    }
    for (const toolCallId of record.toolCallIds) keys.add(maskKey(sessionId, toolCallId));
  }
  return keys;
}

async function appendBatchCommit(params: {
  sessionDir: string;
  threshold: number;
  candidates: MaskCandidate[];
  reclaimableTokens: number;
}): Promise<void> {
  const { sessionDir, threshold, candidates, reclaimableTokens } = params;
  const commit: BatchCommit = {
    version: 1,
    batchId: randomUUID(),
    committedAt: new Date().toISOString(),
    threshold,
    toolCallIds: candidates.map((candidate) => String(candidate.message.toolCallId)),
    reclaimableTokens,
  };
  await appendFile(batchCommitPath(sessionDir), `${JSON.stringify(commit)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function buildArchiveManifest(params: {
  sessionId: string;
  sessionFile: string | null;
  message: AnyMessage;
  originalTokens: number;
  text: Buffer;
}): ArchiveManifest {
  const { sessionId, sessionFile, message, originalTokens, text } = params;
  return {
    version: 2,
    sessionId,
    sessionFile,
    toolCallId: String(message.toolCallId),
    toolName: String(message.toolName ?? "unknown"),
    isError: Boolean(message.isError),
    originalEstimatedTokens: originalTokens,
    textBytes: text.byteLength,
    textSha256: sha256(text),
    archivedAt: new Date().toISOString(),
  };
}

function hasMatchingIdentity(
  manifest: ArchiveManifest,
  expected: ArchiveManifest,
): boolean {
  return (
    manifest.version === 2 &&
    manifest.sessionId === expected.sessionId &&
    manifest.sessionFile === expected.sessionFile &&
    manifest.toolCallId === expected.toolCallId &&
    manifest.toolName === expected.toolName &&
    manifest.isError === expected.isError &&
    manifest.originalEstimatedTokens === expected.originalEstimatedTokens &&
    typeof manifest.archivedAt === "string"
  );
}

async function readManifest(path: string): Promise<ArchiveManifest> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new ArchiveIntegrityError(`Cannot read archive manifest: ${String(error)}`);
  }

  if (!parsed || typeof parsed !== "object") {
    throw new ArchiveIntegrityError("Archive manifest is not an object");
  }
  return parsed as ArchiveManifest;
}

async function verifyArchive(params: {
  txtPath: string;
  manifestPath: string;
  expected: ArchiveManifest;
  stats: MaskStats;
}): Promise<void> {
  const { txtPath, manifestPath, expected, stats } = params;
  stats.archiveVerifications++;

  const manifest = await readManifest(manifestPath);
  if (!hasMatchingIdentity(manifest, expected)) {
    throw new ArchiveIntegrityError("Archive manifest identity does not match the tool result");
  }

  let archivedText: Buffer;
  try {
    archivedText = await readFile(txtPath);
  } catch (error) {
    throw new ArchiveIntegrityError(`Cannot read archived result: ${String(error)}`);
  }

  const archivedHash = sha256(archivedText);
  if (
    manifest.textBytes !== archivedText.byteLength ||
    manifest.textSha256 !== archivedHash ||
    archivedText.byteLength !== expected.textBytes ||
    archivedHash !== expected.textSha256
  ) {
    throw new ArchiveIntegrityError("Archived result hash does not match its manifest or tool result");
  }
}

async function ensureArchived(params: {
  archiveRoot: string;
  sessionId: string;
  sessionFile: string | null;
  message: AnyMessage;
  originalTokens: number;
  stats: MaskStats;
}): Promise<ArchiveRecord> {
  const { archiveRoot, sessionId, sessionFile, message, originalTokens, stats } = params;
  const { sessionDir, txtPath, manifestPath } = archivePaths({
    archiveRoot,
    sessionId,
    sessionFile,
    message,
  });
  await mkdir(sessionDir, { recursive: true, mode: 0o700 });
  const text = Buffer.from(textForArchive(message.content), "utf8");
  const expected = buildArchiveManifest({
    sessionId,
    sessionFile,
    message,
    originalTokens,
    text,
  });

  const txtExists = await fileExists(txtPath);
  const manifestExists = await fileExists(manifestPath);
  let created = false;

  if (!txtExists && manifestExists) {
    throw new ArchiveIntegrityError("Archive manifest exists without its result file");
  }

  if (!txtExists) {
    const wroteText = await writeOnce(txtPath, text.toString("utf8"));
    if (wroteText) {
      created = true;
      stats.archiveBytesWritten += text.byteLength;
    }
  }

  // An existing .txt (including a version-1 archive) is trusted only after it
  // matches the current tool result. The legacy .json sidecar is left intact.
  const manifestJson = `${JSON.stringify(expected, null, 2)}\n`;
  if (!(await fileExists(manifestPath))) {
    const currentText = await readFile(txtPath);
    if (currentText.byteLength !== expected.textBytes || sha256(currentText) !== expected.textSha256) {
      throw new ArchiveIntegrityError("Existing archived result does not match the tool result");
    }
    const wroteManifest = await writeOnce(manifestPath, manifestJson);
    if (wroteManifest) {
      created = true;
      stats.archiveManifestCreations++;
    }
  }

  await verifyArchive({ txtPath, manifestPath, expected, stats });
  return { txtPath, manifestPath, created, verified: true };
}

function makeStub(toolName: string, originalTokens: number, fullPath: string): string {
  return [
    `[Archived ${toolName} result (~${formatInt(originalTokens)} tokens).`,
    `Full output: ${fullPath}`,
    `Use read on that file if the original output is needed.]`,
  ].join("\n");
}

function notifyOrLog(ctx: any, message: string): void {
  if (ctx?.hasUI) ctx.ui.notify(message, "info");
  else console.log(message);
}

function statsText(params: {
  stats: MaskStats;
  enabled: boolean;
  window: number;
  archiveRoot: string;
  includeTools: Set<string> | null;
  excludeTools: Set<string>;
  minSavingsTokens: number;
  batchThresholdTokens: number;
}): string {
  const {
    stats,
    enabled,
    window,
    archiveRoot,
    includeTools,
    excludeTools,
    minSavingsTokens,
    batchThresholdTokens,
  } = params;
  const u = stats.providerUsage;
  const providerPrompt = u.input + u.cacheRead + u.cacheWrite;

  return [
    `Recoverable tool masking`,
    `enabled: ${enabled}`,
    `window: ${window} model calls`,
    `tools: ${includeTools ? [...includeTools].join(",") : "all"}`,
    `excluded: ${excludeTools.size ? [...excludeTools].join(",") : "none"}`,
    `minimum estimated saving: ${minSavingsTokens} tokens`,
    `archive: ${archiveRoot}`,
    ``,
    `Current outgoing context`,
    `tool-result tokens before: ~${formatInt(stats.currentOriginalToolTokens)}`,
    `tool-result tokens after:  ~${formatInt(stats.currentAfterMaskToolTokens)}`,
    `estimated saved:           ~${formatInt(stats.currentSavedTokens)} (${formatPct(stats.currentSavedTokens, stats.currentOriginalToolTokens)})`,
    `masked results:             ${formatInt(stats.currentMaskedResults)}`,
    ``,
    `Batching`,
    `batch threshold:             ~${formatInt(batchThresholdTokens)} reclaimable tokens`,
    `waiting eligible results:    ${formatInt(stats.currentWaitingEligibleResults)}`,
    `waiting reclaimable tokens: ~${formatInt(stats.currentWaitingEligibleTokens)}`,
    `committed masked results:    ${formatInt(stats.currentCommittedMaskedResults)}`,
    ``,
    `Since session start / extension reload`,
    `batch events:                ${formatInt(stats.batchEvents)}`,
    `results committed in batches:${formatInt(stats.batchCommittedResults)}`,
    `reclaimable tokens committed: ~${formatInt(stats.batchCommittedTokens)}`,
    `last batch results:          ${formatInt(stats.lastBatchResults)}`,
    `last batch tokens:           ~${formatInt(stats.lastBatchTokens)}`,
    `LLM context hooks:           ${formatInt(stats.contextCalls)}`,
    `mask applications:           ${formatInt(stats.maskApplications)}`,
    `unique masked results:       ${formatInt(stats.uniqueMaskedResults.size)}`,
    `unique archived results:     ${formatInt(stats.uniqueArchivedResults.size)}`,
    `estimated exposure avoided: ~${formatInt(stats.estimatedExposureAvoided)} tokens`,
    `archive bytes written:       ${formatInt(stats.archiveBytesWritten)}`,
    `archive verifications:       ${formatInt(stats.archiveVerifications)}`,
    `archive manifests created:   ${formatInt(stats.archiveManifestCreations)}`,
    `archive integrity failures:  ${formatInt(stats.archiveIntegrityFailures)}`,
    `recovery tool calls:         ${formatInt(stats.recoveryToolCalls)}`,
    `unique recovery targets:     ${formatInt(stats.recoveredArchivePaths.size)}`,
    `skipped image results:       ${formatInt(stats.skippedImageResults)}`,
    `skipped too-small results:   ${formatInt(stats.skippedTooSmallResults)}`,
    `archive failures:            ${formatInt(stats.archiveFailures)}`,
    ``,
    `Provider-reported usage since load`,
    `assistant calls: ${formatInt(u.calls)}`,
    `input:           ${formatInt(u.input)}`,
    `cacheRead:       ${formatInt(u.cacheRead)}`,
    `cacheWrite:      ${formatInt(u.cacheWrite)}`,
    `output:          ${formatInt(u.output)}`,
    `reasoning:       ${formatInt(u.reasoning)}`,
    `prompt-side:     ${formatInt(providerPrompt)}`,
    `cache-read pct:  ${formatPct(u.cacheRead, providerPrompt)}`,
  ].join("\n");
}

export default function recoverableToolMask(pi: ExtensionAPI) {
  let enabled = envBool("PI_TOOL_MASK_ENABLED", true);
  const window = envInt("PI_TOOL_MASK_WINDOW", DEFAULT_WINDOW, 1);
  const batchThresholdTokens = envInt(
    "PI_TOOL_MASK_BATCH_THRESHOLD",
    DEFAULT_BATCH_THRESHOLD_TOKENS,
    0,
  );
  const minSavingsTokens = envInt(
    "PI_TOOL_MASK_MIN_SAVINGS_TOKENS",
    DEFAULT_MIN_SAVINGS_TOKENS,
    0,
  );
  const archiveRoot = archiveRootFromEnv();
  const includeTools = parseToolSet(process.env.PI_TOOL_MASK_TOOLS);
  const excludeTools = parseExcludeSet(process.env.PI_TOOL_MASK_EXCLUDE_TOOLS);

  let stats = newStats();
  const committedMaskedResults = new Set<string>();

  pi.on("session_start", async (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const sessionFile = ctx.sessionManager.getSessionFile() ?? null;
    const sessionDir = getSessionArchiveDir(archiveRoot, sessionId, sessionFile);
    stats = newStats(sessionId);
    committedMaskedResults.clear();
    try {
      await mkdir(sessionDir, { recursive: true, mode: 0o700 });
      for (const key of await loadCommittedMaskKeys({ sessionDir, sessionId })) {
        committedMaskedResults.add(key);
      }
      stats.currentCommittedMaskedResults = committedMaskedResults.size;
    } catch (error) {
      stats.archiveFailures++;
      if (ctx.hasUI) {
        ctx.ui.notify(
          `Recoverable masking: batch ledger unavailable; results will remain unmasked. ${String(error)}`,
          "warning",
        );
      }
    }
  });

  // Count actual attempts to recover archived results. This is telemetry only;
  // the built-in read/bash/etc. tools execute normally.
  pi.on("tool_call", async (event, _ctx) => {
    const ref = containsArchiveReference(event.input, archiveRoot);
    if (ref) {
      stats.recoveryToolCalls++;
      stats.recoveredArchivePaths.add(ref);
    }
  });

  // Capture provider-reported usage after the masked context has actually been
  // sent. This is the number to compare with your pre-extension baseline.
  pi.on("message_end", async (event, _ctx) => {
    const message: any = event.message;
    if (message?.role !== "assistant" || !message.usage) return;
    const u = message.usage;
    stats.providerUsage.calls++;
    stats.providerUsage.input += u.input ?? 0;
    stats.providerUsage.output += u.output ?? 0;
    stats.providerUsage.cacheRead += u.cacheRead ?? 0;
    stats.providerUsage.cacheWrite += u.cacheWrite ?? 0;
    stats.providerUsage.reasoning += u.reasoning ?? 0;
    stats.providerUsage.totalTokens += u.totalTokens ?? 0;
  });

  pi.on("context", async (event, ctx) => {
    stats.contextCalls++;

    const messages: AnyMessage[] = event.messages;
    const callMap = buildToolCallMap(messages);
    const callsAfter = assistantCallsAfter(messages);
    const sessionId = ctx.sessionManager.getSessionId() || stats.sessionId || "ephemeral";
    const sessionFile = ctx.sessionManager.getSessionFile() ?? null;
    const candidates: MaskCandidate[] = [];

    let currentOriginalToolTokens = 0;

    // Inspect the fresh outgoing context. Only uncommitted, eligible results
    // participate in the next threshold calculation.
    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      if (!isToolResultMessage(message)) continue;

      const key = maskKey(sessionId, message.toolCallId);
      const originalChars = contentTextChars(message.content);
      const originalTokens = estimateTokensFromChars(originalChars);
      currentOriginalToolTokens += originalTokens;

      if (!enabled || !shouldIncludeTool(String(message.toolName ?? "unknown"), includeTools, excludeTools)) {
        continue;
      }
      if (hasImageContent(message.content)) {
        stats.skippedImageResults++;
        continue;
      }
      if (originalChars === 0 || committedMaskedResults.has(key) || callsAfter[i] < window) {
        continue;
      }

      const toolName = String(message.toolName ?? "unknown");
      const call = callMap.get(message.toolCallId);
      // Recovery reads must remain verbatim: a source archive belongs to the
      // original call, not the read that recovered it.
      if (archiveReadTarget(call, archiveRoot)) continue;

      const paths = archivePaths({ archiveRoot, sessionId, sessionFile, message });
      const stub = makeStub(toolName, originalTokens, paths.txtPath);
      const stubTokens = estimateTokensFromChars(stub.length);
      const reclaimableTokens = originalTokens - stubTokens;
      if (reclaimableTokens < minSavingsTokens) {
        stats.skippedTooSmallResults++;
        continue;
      }

      candidates.push({
        index: i,
        message,
        key,
        toolName,
        originalTokens,
        pointerPath: paths.txtPath,
        stub,
        stubTokens,
        reclaimableTokens,
        needsArchive: true,
      });
    }

    const waitingReclaimableTokens = candidates.reduce(
      (sum, candidate) => sum + candidate.reclaimableTokens,
      0,
    );
    stats.currentWaitingEligibleResults = candidates.length;
    stats.currentWaitingEligibleTokens = waitingReclaimableTokens;

    const shouldCommitBatch =
      candidates.length > 0 &&
      (batchThresholdTokens === 0 || waitingReclaimableTokens >= batchThresholdTokens);
    const successfullyPrepared: MaskCandidate[] = [];

    if (shouldCommitBatch) {
      for (const candidate of candidates) {
        try {
          if (candidate.needsArchive) {
            await ensureArchived({
              archiveRoot,
              sessionId,
              sessionFile,
              message: candidate.message,
              originalTokens: candidate.originalTokens,
              stats,
            });
            stats.uniqueArchivedResults.add(candidate.key);
          }
          successfullyPrepared.push(candidate);
        } catch (error) {
          stats.archiveFailures++;
          if (error instanceof ArchiveIntegrityError) stats.archiveIntegrityFailures++;
        }
      }
    }

    const preparedReclaimableTokens = successfullyPrepared.reduce(
      (sum, candidate) => sum + candidate.reclaimableTokens,
      0,
    );
    const commitPreparedBatch =
      successfullyPrepared.length > 0 &&
      (batchThresholdTokens === 0 || preparedReclaimableTokens >= batchThresholdTokens);

    if (commitPreparedBatch) {
      try {
        const sessionDir = getSessionArchiveDir(archiveRoot, sessionId, sessionFile);
        // The durable decision precedes in-memory commitment and outgoing masking.
        await appendBatchCommit({
          sessionDir,
          threshold: batchThresholdTokens,
          candidates: successfullyPrepared,
          reclaimableTokens: preparedReclaimableTokens,
        });
        for (const candidate of successfullyPrepared) committedMaskedResults.add(candidate.key);
        stats.batchEvents++;
        stats.batchCommittedResults += successfullyPrepared.length;
        stats.batchCommittedTokens += preparedReclaimableTokens;
        stats.lastBatchResults = successfullyPrepared.length;
        stats.lastBatchTokens = preparedReclaimableTokens;
      } catch (error) {
        // Archives without a durable batch decision are intentionally left full.
        stats.archiveFailures++;
        if (error instanceof ArchiveIntegrityError) stats.archiveIntegrityFailures++;
      }
    }

    let currentAfterMaskToolTokens = 0;
    let currentSavedTokens = 0;
    let currentMaskedResults = 0;

    // Re-verify every committed result before masking it. A later archive
    // corruption therefore fails open even though its batch was committed.
    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      if (!isToolResultMessage(message)) continue;
      const originalTokens = estimateTokensFromChars(contentTextChars(message.content));
      const toolName = String(message.toolName ?? "unknown");
      const key = maskKey(sessionId, message.toolCallId);

      if (
        !enabled ||
        !committedMaskedResults.has(key) ||
        callsAfter[i] < window ||
        !shouldIncludeTool(toolName, includeTools, excludeTools) ||
        hasImageContent(message.content)
      ) {
        currentAfterMaskToolTokens += originalTokens;
        continue;
      }

      try {
        const archived = await ensureArchived({
          archiveRoot,
          sessionId,
          sessionFile,
          message,
          originalTokens,
          stats,
        });
        const stub = makeStub(toolName, originalTokens, archived.txtPath);
        const stubTokens = estimateTokensFromChars(stub.length);
        message.content = [{ type: "text", text: stub }];
        currentAfterMaskToolTokens += stubTokens;
        currentSavedTokens += originalTokens - stubTokens;
        currentMaskedResults++;
        stats.maskApplications++;
        stats.uniqueMaskedResults.add(key);
        stats.estimatedOriginalMaskedTokens += originalTokens;
        stats.estimatedStubTokens += stubTokens;
        stats.estimatedExposureAvoided += originalTokens - stubTokens;
      } catch (error) {
        stats.archiveFailures++;
        if (error instanceof ArchiveIntegrityError) stats.archiveIntegrityFailures++;
        currentAfterMaskToolTokens += originalTokens;
      }
    }

    stats.currentOriginalToolTokens = currentOriginalToolTokens;
    stats.currentAfterMaskToolTokens = currentAfterMaskToolTokens;
    stats.currentSavedTokens = currentSavedTokens;
    stats.currentMaskedResults = currentMaskedResults;
    stats.currentCommittedMaskedResults = committedMaskedResults.size;

    return { messages };
  });

  pi.registerCommand("mask-stats", {
    description: "Show recoverable tool-result masking and provider-usage statistics",
    handler: async (_args, ctx) => {
      notifyOrLog(
        ctx,
        statsText({
          stats,
          enabled,
          window,
          archiveRoot,
          includeTools,
          excludeTools,
          minSavingsTokens,
          batchThresholdTokens,
        }),
      );
    },
  });

  pi.registerCommand("mask-reset-stats", {
    description: "Reset in-memory recoverable masking statistics",
    handler: async (_args, ctx) => {
      const sessionId = ctx.sessionManager.getSessionId();
      stats = newStats(sessionId);
      notifyOrLog(ctx, "Recoverable masking statistics reset.");
    },
  });

  // Runtime kill switch. This intentionally does not delete archives.
  pi.registerCommand("mask-toggle", {
    description: "Enable/disable recoverable masking for the current Pi process",
    handler: async (_args, ctx) => {
      enabled = !enabled;
      notifyOrLog(ctx, `Recoverable tool masking ${enabled ? "enabled" : "disabled"}.`);
    },
  });
}
