
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
 * Pi discovers this extension through the package.json `pi.extensions` manifest.
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
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, resolve } from "node:path";

const DEFAULT_WINDOW = 10;
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

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 20);
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

type ArchiveRecord = {
  txtPath: string;
  jsonPath: string;
  created: boolean;
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

async function ensureArchived(params: {
  archiveRoot: string;
  sessionId: string;
  message: AnyMessage;
  originalTokens: number;
  stats: MaskStats;
}): Promise<ArchiveRecord> {
  const { archiveRoot, sessionId, message, originalTokens, stats } = params;
  const sessionDir = join(archiveRoot, safeComponent(sessionId));
  await mkdir(sessionDir, { recursive: true, mode: 0o700 });

  const toolName = safeComponent(String(message.toolName ?? "tool"), 40);
  const idHash = shortHash(String(message.toolCallId));
  const base = `${toolName}-${idHash}`;
  const txtPath = join(sessionDir, `${base}.txt`);
  const jsonPath = join(sessionDir, `${base}.json`);

  const text = textForArchive(message.content);
  const txtAlreadyExists = await fileExists(txtPath);

  let created = false;
  if (!txtAlreadyExists) {
    created = await writeOnce(txtPath, text);
    if (created) stats.archiveBytesWritten += Buffer.byteLength(text, "utf8");
  }

  // Sidecar preserves the original content-block structure exactly. It is not
  // required for normal recovery; the .txt file is the model-friendly path.
  if (!(await fileExists(jsonPath))) {
    const sidecar = JSON.stringify(
      {
        version: 1,
        sessionId,
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        isError: Boolean(message.isError),
        timestamp: message.timestamp,
        originalEstimatedTokens: originalTokens,
        content: message.content,
      },
      null,
      2,
    );
    try {
      await writeOnce(jsonPath, `${sidecar}\n`);
    } catch {
      // The .txt archive is sufficient for recovery. Do not fail masking only
      // because the metadata sidecar could not be written.
    }
  }

  return { txtPath, jsonPath, created };
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
}): string {
  const { stats, enabled, window, archiveRoot, includeTools, excludeTools, minSavingsTokens } = params;
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
    `Since session start / extension reload`,
    `LLM context hooks:           ${formatInt(stats.contextCalls)}`,
    `mask applications:           ${formatInt(stats.maskApplications)}`,
    `unique masked results:       ${formatInt(stats.uniqueMaskedResults.size)}`,
    `unique archived results:     ${formatInt(stats.uniqueArchivedResults.size)}`,
    `estimated exposure avoided: ~${formatInt(stats.estimatedExposureAvoided)} tokens`,
    `archive bytes written:       ${formatInt(stats.archiveBytesWritten)}`,
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
  const minSavingsTokens = envInt(
    "PI_TOOL_MASK_MIN_SAVINGS_TOKENS",
    DEFAULT_MIN_SAVINGS_TOKENS,
    0,
  );
  const archiveRoot = archiveRootFromEnv();
  const includeTools = parseToolSet(process.env.PI_TOOL_MASK_TOOLS);
  const excludeTools = parseExcludeSet(process.env.PI_TOOL_MASK_EXCLUDE_TOOLS);

  let stats = newStats();

  pi.on("session_start", async (_event, ctx) => {
    stats = newStats(ctx.sessionManager.getSessionId());
    try {
      await mkdir(join(archiveRoot, safeComponent(stats.sessionId)), {
        recursive: true,
        mode: 0o700,
      });
    } catch (error) {
      stats.archiveFailures++;
      if (ctx.hasUI) {
        ctx.ui.notify(
          `Recoverable masking: archive directory unavailable; results will remain unmasked. ${String(error)}`,
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

    let currentOriginalToolTokens = 0;
    let currentAfterMaskToolTokens = 0;
    let currentSavedTokens = 0;
    let currentMaskedResults = 0;

    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      if (!isToolResultMessage(message)) continue;

      const originalChars = contentTextChars(message.content);
      const originalTokens = estimateTokensFromChars(originalChars);
      currentOriginalToolTokens += originalTokens;

      // Disabled mode still computes current baseline stats but does not archive
      // or modify anything.
      if (!enabled) {
        currentAfterMaskToolTokens += originalTokens;
        continue;
      }

      const toolName = String(message.toolName ?? "unknown");
      if (!shouldIncludeTool(toolName, includeTools, excludeTools)) {
        currentAfterMaskToolTokens += originalTokens;
        continue;
      }

      // Keep recent results at full fidelity. With window=10 this masks a result
      // starting on the 11th subsequent model request.
      if (callsAfter[i] < window) {
        currentAfterMaskToolTokens += originalTokens;
        continue;
      }

      if (hasImageContent(message.content)) {
        stats.skippedImageResults++;
        currentAfterMaskToolTokens += originalTokens;
        continue;
      }

      if (originalChars === 0) {
        currentAfterMaskToolTokens += originalTokens;
        continue;
      }

      const call = callMap.get(message.toolCallId);
      let pointerPath = archiveReadTarget(call, archiveRoot);

      try {
        if (!pointerPath) {
          const archived = await ensureArchived({
            archiveRoot,
            sessionId,
            message,
            originalTokens,
            stats,
          });
          pointerPath = archived.txtPath;
          stats.uniqueArchivedResults.add(`${sessionId}:${message.toolCallId}`);
        }
      } catch (error) {
        // Fail open: never remove information if we cannot prove it is archived.
        stats.archiveFailures++;
        currentAfterMaskToolTokens += originalTokens;
        continue;
      }

      const stub = makeStub(toolName, originalTokens, pointerPath);
      const stubTokens = estimateTokensFromChars(stub.length);
      const savings = originalTokens - stubTokens;

      if (savings < minSavingsTokens) {
        stats.skippedTooSmallResults++;
        currentAfterMaskToolTokens += originalTokens;
        continue;
      }

      // `event.messages` is a deep copy supplied by Pi specifically for this
      // purpose. Only the outgoing LLM context changes; persisted JSONL remains
      // untouched.
      message.content = [{ type: "text", text: stub }];

      currentAfterMaskToolTokens += stubTokens;
      currentSavedTokens += savings;
      currentMaskedResults++;

      stats.maskApplications++;
      stats.uniqueMaskedResults.add(`${sessionId}:${message.toolCallId}`);
      stats.estimatedOriginalMaskedTokens += originalTokens;
      stats.estimatedStubTokens += stubTokens;
      stats.estimatedExposureAvoided += savings;
    }

    stats.currentOriginalToolTokens = currentOriginalToolTokens;
    stats.currentAfterMaskToolTokens = currentAfterMaskToolTokens;
    stats.currentSavedTokens = currentSavedTokens;
    stats.currentMaskedResults = currentMaskedResults;

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
