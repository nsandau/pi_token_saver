#!/usr/bin/env bun

/**
 * Automated zero-model-token canary for recoverable-tool-mask.ts
 *
 * It loads the extension under a mocked Pi ExtensionAPI and verifies:
 *   - 10-call age gate
 *   - 10,000-token batch threshold
 *   - stable committed masking
 *   - archive creation / pointer recovery
 *   - recovery telemetry
 *   - resume persistence
 *   - branch-local age safety
 *   - fail-open behavior
 *
 * Usage from repo root:
 *
 *   bun tests/pi_mask_canary_test.ts
 *
 * Or explicitly:
 *
 *   bun tests/pi_mask_canary_test.ts \
 *     --extension ./src/recoverable-tool-mask.ts
 *
 * The script searches common repo/install locations when --extension is omitted.
 */

// @ts-ignore -- Bun provides Node-compatible built-ins.
import { mkdtemp, writeFile, rm, readFile, readdir, stat } from "node:fs/promises";
// @ts-ignore
import { tmpdir, homedir } from "node:os";
// @ts-ignore
import { join, resolve } from "node:path";
// @ts-ignore
import { pathToFileURL } from "node:url";

declare const Bun: any;
declare const process: any;

type Handler = (event: any, ctx: any) => any | Promise<any>;

class MockPi {
  handlers = new Map<string, Handler[]>();
  commands = new Map<string, any>();

  on(name: string, fn: Handler) {
    const list = this.handlers.get(name) ?? [];
    list.push(fn);
    this.handlers.set(name, list);
  }

  registerCommand(name: string, spec: any) {
    this.commands.set(name, spec);
  }

  registerTool(..._args: any[]) {}
  registerShortcut(..._args: any[]) {}
  registerFlag(..._args: any[]) {}
  appendEntry(..._args: any[]) {}

  events = {
    on: (..._args: any[]) => {},
    emit: (..._args: any[]) => {},
  };

  async emit(name: string, event: any, ctx: any): Promise<any> {
    let currentEvent = event;
    let lastResult: any;

    for (const fn of this.handlers.get(name) ?? []) {
      const result = await fn(currentEvent, ctx);

      if (result !== undefined) {
        lastResult = result;

        if (
          name === "context" &&
          result &&
          Array.isArray(result.messages)
        ) {
          currentEvent = {
            ...currentEvent,
            messages: result.messages,
          };
        }
      }
    }

    return lastResult;
  }
}

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

async function exists(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isFile();
  } catch {
    return false;
  }
}

async function resolveExtensionPath(explicit?: string): Promise<string> {
  const cwd = process.cwd();

  const candidates = explicit
    ? [resolve(explicit)]
    : [
        resolve(cwd, "recoverable-tool-mask.ts"),
        resolve(cwd, "src/recoverable-tool-mask.ts"),
        resolve(cwd, "src/extensions/recoverable-tool-mask.ts"),
        resolve(cwd, "extensions/recoverable-tool-mask.ts"),
        resolve(cwd, "plugin/recoverable-tool-mask.ts"),
        resolve(cwd, "plugins/recoverable-tool-mask.ts"),
        resolve(homedir(), ".pi/agent/extensions/recoverable-tool-mask.ts"),
      ];

  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }

  throw new Error(
    [
      "Could not locate recoverable-tool-mask.ts.",
      explicit
        ? `Explicit --extension path does not exist: ${resolve(explicit)}`
        : "Searched:",
      ...(!explicit ? candidates.map((p) => `  - ${p}`) : []),
      "",
      "Run with the real source path, for example:",
      "  bun tests/pi_mask_canary_test.ts --extension ./src/recoverable-tool-mask.ts",
    ].join("\n"),
  );
}

function makeCtx(params: {
  sessionId: string;
  sessionFile: string;
  notices: string[];
}) {
  return {
    hasUI: true,
    mode: "tui",
    cwd: process.cwd(),
    ui: {
      notify(message: string, _level?: string) {
        params.notices.push(String(message));
      },
    },
    sessionManager: {
      getSessionId() {
        return params.sessionId;
      },
      getSessionFile() {
        return params.sessionFile;
      },
      getLeafId() {
        return null;
      },
      getBranch() {
        return [];
      },
      getEntries() {
        return [];
      },
    },
    getContextUsage() {
      return null;
    },
    getSystemPrompt() {
      return "";
    },
    signal: new AbortController().signal,
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function user(text: string) {
  return {
    role: "user",
    content: [{ type: "text", text }],
  };
}

function assistantText(text: string) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
  };
}

function assistantToolCall(
  id: string,
  name: string,
  args: Record<string, unknown>,
) {
  return {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id,
        name,
        arguments: args,
      },
    ],
  };
}

function toolResult(
  id: string,
  toolName: string,
  approxTokens: number,
  sentinel: string,
) {
  const targetChars = Math.max(
    sentinel.length + 10,
    Math.floor(approxTokens * 4),
  );

  const body =
    sentinel +
    "\n" +
    "X".repeat(
      Math.max(0, targetChars - sentinel.length - 1),
    );

  return {
    role: "toolResult",
    toolCallId: id,
    toolName,
    content: [{ type: "text", text: body }],
    isError: false,
  };
}

function addOrdinaryModelCall(messages: any[], label: string) {
  messages.push(user(`user-${label}`));
  messages.push(assistantText(`assistant-${label}`));
}

function countAssistantAfter(messages: any[], toolCallId: string): number {
  const idx = messages.findIndex(
    (m) =>
      m?.role === "toolResult" &&
      m?.toolCallId === toolCallId,
  );

  if (idx < 0) return -1;

  return messages
    .slice(idx + 1)
    .filter((m) => m?.role === "assistant")
    .length;
}

function findToolResult(messages: any[], id: string): any | undefined {
  return messages.find(
    (m) =>
      m?.role === "toolResult" &&
      m?.toolCallId === id,
  );
}

function toolResultText(message: any): string {
  if (!Array.isArray(message?.content)) return "";

  return message.content
    .filter(
      (b: any) =>
        b?.type === "text" &&
        typeof b.text === "string",
    )
    .map((b: any) => b.text)
    .join("\n");
}

function isMasked(message: any): boolean {
  const text = toolResultText(message);
  return text.includes("[Archived ") && text.includes("Full output:");
}

function pointerPath(message: any): string | null {
  const text = toolResultText(message);
  const match = text.match(/Full output:\s*(.+)/);
  return match ? match[1]!.trim() : null;
}

function statNumber(text: string, label: string): number | null {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`${escaped}:\\s*~?([\\d,]+)`, "i");
  const m = text.match(re);
  return m ? Number(m[1]!.replaceAll(",", "")) : null;
}

async function runCommand(
  pi: MockPi,
  name: string,
  ctx: any,
  notices: string[],
): Promise<string> {
  const command = pi.commands.get(name);
  if (!command?.handler) return "";

  const before = notices.length;
  await command.handler("", ctx);

  return notices.slice(before).join("\n");
}

async function loadExtension(extensionPath: string): Promise<any> {
  const url = pathToFileURL(resolve(extensionPath));
  const spec = `${url.href}?mask-canary=${Date.now()}-${Math.random()}`;
  const mod = await import(spec);

  if (typeof mod.default !== "function") {
    throw new Error(
      `Extension ${extensionPath} does not export a default registration function.`,
    );
  }

  return mod.default;
}

async function instantiate(params: {
  extensionFactory: any;
  archiveRoot: string;
  sessionId: string;
  sessionFile: string;
  reason?: string;
}) {
  process.env.PI_TOOL_MASK_ENABLED = "1";
  process.env.PI_TOOL_MASK_WINDOW = "10";
  process.env.PI_TOOL_MASK_BATCH_THRESHOLD = "10000";
  process.env.PI_TOOL_MASK_MIN_SAVINGS_TOKENS = "32";
  process.env.PI_TOOL_MASK_TOOLS = "all";
  process.env.PI_TOOL_MASK_EXCLUDE_TOOLS = "";
  process.env.PI_TOOL_MASK_ARCHIVE_DIR = params.archiveRoot;

  const pi = new MockPi();
  const notices: string[] = [];
  const ctx = makeCtx({
    sessionId: params.sessionId,
    sessionFile: params.sessionFile,
    notices,
  });

  params.extensionFactory(pi as any);

  await pi.emit(
    "session_start",
    { reason: params.reason ?? "startup" },
    ctx,
  );

  return { pi, notices, ctx };
}

type Check = {
  name: string;
  pass: boolean;
  details: string;
  required?: boolean;
};

function printCheck(check: Check) {
  console.log(
    `${(check.pass ? "PASS" : "FAIL").padEnd(5)} ${check.name}\n      ${check.details}`,
  );
}

async function contextCall(
  pi: MockPi,
  ctx: any,
  messages: any[],
): Promise<any[]> {
  const copy = clone(messages);
  const result = await pi.emit(
    "context",
    { messages: copy },
    ctx,
  );

  return result && Array.isArray(result.messages)
    ? result.messages
    : copy;
}

async function listFilesRecursive(root: string): Promise<string[]> {
  const out: string[] = [];

  async function walk(dir: string) {
    let entries: any[];

    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const full = join(dir, entry.name);

      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  }

  await walk(root);
  return out;
}

async function main() {
  const args = parseArgs(Bun.argv.slice(2));
  const extensionPath = await resolveExtensionPath(args.extension);

  console.log(`Using extension: ${extensionPath}`);

  const temp = await mkdtemp(
    join(tmpdir(), "pi-mask-canary-"),
  );

  const archiveRoot = join(temp, "archive");
  const sessionId = "mask-canary-session";
  const sessionFile = join(temp, "mask-canary-session.jsonl");
  const checks: Check[] = [];

  try {
    const extensionFactory = await loadExtension(extensionPath);

    const first = await instantiate({
      extensionFactory,
      archiveRoot,
      sessionId,
      sessionFile,
      reason: "startup",
    });

    const A = "canary-A";
    const B = "canary-B";

    const base: any[] = [
      user("seed A"),
      assistantToolCall(A, "bash", { command: "synthetic-A" }),
      toolResult(
        A,
        "bash",
        6_000,
        "MASK_TEST_SENTINEL_A=alpha-481729",
      ),
    ];

    addOrdinaryModelCall(base, "between-A-and-B");

    base.push(user("seed B"));
    base.push(
      assistantToolCall(B, "bash", { command: "synthetic-B" }),
    );
    base.push(
      toolResult(
        B,
        "bash",
        5_200,
        "MASK_TEST_SENTINEL_B=beta-934612",
      ),
    );

    for (let i = 0; i < 8; i++) {
      addOrdinaryModelCall(base, `pre-threshold-${i}`);
    }

    const ageA1 = countAssistantAfter(base, A);
    const ageB1 = countAssistantAfter(base, B);

    const beforeThreshold = await contextCall(first.pi, first.ctx, base);

    checks.push({
      name: "10-call gate + below-10k batch stays full",
      pass:
        ageA1 >= 10 &&
        ageB1 < 10 &&
        !isMasked(findToolResult(beforeThreshold, A)) &&
        !isMasked(findToolResult(beforeThreshold, B)),
      details:
        `A age=${ageA1}, B age=${ageB1}; A alone is ~6k reclaimable and must not trigger the 10k batch.`,
      required: true,
    });

    const crossed = clone(base);

    addOrdinaryModelCall(crossed, "cross-1");
    addOrdinaryModelCall(crossed, "cross-2");

    const ageA2 = countAssistantAfter(crossed, A);
    const ageB2 = countAssistantAfter(crossed, B);

    const afterThreshold = await contextCall(first.pi, first.ctx, crossed);

    const A2 = findToolResult(afterThreshold, A);
    const B2 = findToolResult(afterThreshold, B);

    const pathA = pointerPath(A2);
    const pathB = pointerPath(B2);

    checks.push({
      name: "10k threshold commits one batch",
      pass:
        ageA2 >= 10 &&
        ageB2 >= 10 &&
        isMasked(A2) &&
        isMasked(B2) &&
        Boolean(pathA) &&
        Boolean(pathB),
      details:
        `A age=${ageA2}, B age=${ageB2}; combined reclaimable output exceeds 10k, so both should mask together.`,
      required: true,
    });

    const stable = await contextCall(first.pi, first.ctx, crossed);

    checks.push({
      name: "committed batch remains stable",
      pass:
        isMasked(findToolResult(stable, A)) &&
        isMasked(findToolResult(stable, B)),
      details:
        "Previously committed results should stay pointer-masked on the next context hook.",
      required: true,
    });

    let archiveContentOk = false;

    if (pathA) {
      try {
        const archived = await readFile(pathA, "utf8");
        archiveContentOk = archived.includes(
          "MASK_TEST_SENTINEL_A=alpha-481729",
        );
      } catch {}
    }

    checks.push({
      name: "archive preserves original sentinel",
      pass: archiveContentOk,
      details:
        pathA
          ? `Read ${pathA}; original sentinel must be present.`
          : "No recovery pointer was produced for A.",
      required: true,
    });

    if (pathA) {
      await first.pi.emit(
        "tool_call",
        {
          toolName: "read",
          toolCallId: "canary-recovery-read",
          input: { path: pathA },
        },
        first.ctx,
      );
    }

    const statsText = await runCommand(
      first.pi,
      "mask-stats",
      first.ctx,
      first.notices,
    );

    const recoveryCalls = statNumber(
      statsText,
      "recovery tool calls",
    );

    const uniqueRecovery = statNumber(
      statsText,
      "unique recovery targets",
    );

    const uniqueMasked = statNumber(
      statsText,
      "unique masked results",
    );

    checks.push({
      name: "recovery telemetry increments",
      pass:
        Boolean(pathA) &&
        recoveryCalls !== null &&
        recoveryCalls >= 1 &&
        uniqueRecovery !== null &&
        uniqueRecovery >= 1,
      details:
        `recovery calls=${recoveryCalls ?? "n/a"}, unique recovery targets=${uniqueRecovery ?? "n/a"}, unique masked=${uniqueMasked ?? "n/a"}.`,
      required: true,
    });

    if (
      uniqueMasked !== null &&
      uniqueRecovery !== null
    ) {
      const rate =
        uniqueMasked > 0
          ? (100 * uniqueRecovery) / uniqueMasked
          : 0;

      console.log(
        `Derived canary recovery target rate: ${rate.toFixed(2)}% (${uniqueRecovery}/${uniqueMasked})`,
      );
    }

    // Fresh extension instance, same session: committed state must survive resume.
    const resumed = await instantiate({
      extensionFactory,
      archiveRoot,
      sessionId,
      sessionFile,
      reason: "resume",
    });

    const oldBranch: any[] = [
      user("seed A"),
      assistantToolCall(A, "bash", { command: "synthetic-A" }),
      toolResult(
        A,
        "bash",
        6_000,
        "MASK_TEST_SENTINEL_A=alpha-481729",
      ),
    ];

    for (let i = 0; i < 10; i++) {
      addOrdinaryModelCall(oldBranch, `resume-old-${i}`);
    }

    const resumedOld = await contextCall(
      resumed.pi,
      resumed.ctx,
      oldBranch,
    );

    checks.push({
      name: "resume preserves committed batch decision",
      pass: isMasked(findToolResult(resumedOld, A)),
      details:
        "A is old enough but alone <10k. It should still mask because it was committed in the earlier A+B batch.",
      required: true,
    });

    const youngBranch: any[] = [
      user("seed A"),
      assistantToolCall(A, "bash", { command: "synthetic-A" }),
      toolResult(
        A,
        "bash",
        6_000,
        "MASK_TEST_SENTINEL_A=alpha-481729",
      ),
    ];

    for (let i = 0; i < 5; i++) {
      addOrdinaryModelCall(youngBranch, `resume-young-${i}`);
    }

    const resumedYoung = await contextCall(
      resumed.pi,
      resumed.ctx,
      youngBranch,
    );

    checks.push({
      name: "committed result still obeys branch-local age gate",
      pass: !isMasked(findToolResult(resumedYoung, A)),
      details:
        "A was committed previously, but this branch has only 5 later assistant calls; it must remain full.",
      required: true,
    });

    // Force archive failure.
    const blocker = join(temp, "archive-blocker");
    await writeFile(blocker, "not-a-directory", "utf8");

    const broken = await instantiate({
      extensionFactory,
      archiveRoot: join(blocker, "child"),
      sessionId: "mask-canary-broken",
      sessionFile: join(temp, "mask-canary-broken.jsonl"),
      reason: "new",
    });

    const brokenContext = await contextCall(
      broken.pi,
      broken.ctx,
      crossed,
    );

    checks.push({
      name: "archive failure fails open",
      pass:
        !isMasked(findToolResult(brokenContext, A)) &&
        !isMasked(findToolResult(brokenContext, B)),
      details:
        "With an invalid archive root, original tool results must remain in outgoing context.",
      required: true,
    });

    const files = await listFilesRecursive(archiveRoot);
    const manifests = files.filter((p) =>
      p.endsWith(".manifest.json")
    );
    const ledgers = files.filter((p) =>
      p.endsWith("batch-commits.jsonl")
    );

    checks.push({
      name: "integrity manifest present",
      pass: manifests.length > 0,
      details: `manifest files=${manifests.length}`,
      required: false,
    });

    checks.push({
      name: "persistent batch ledger present",
      pass: ledgers.length > 0,
      details: `batch-commits.jsonl files=${ledgers.length}`,
      required: true,
    });

    console.log("\nAUTOMATED MASK CANARY");
    console.log("=".repeat(72));

    for (const check of checks) {
      printCheck(check);
    }

    const requiredFailures = checks.filter(
      (c) => c.required !== false && !c.pass,
    );

    console.log("\nSUMMARY");
    console.log(
      `required: ${
        checks.filter((c) => c.required !== false && c.pass).length
      }/${
        checks.filter((c) => c.required !== false).length
      } passed`,
    );

    if (requiredFailures.length) {
      console.error(
        "\nThe extension does NOT yet satisfy the intended masking policy.",
      );
      process.exitCode = 1;
    } else {
      console.log(
        "\nThe extension satisfies the synthetic canary tests.",
      );
    }
  } finally {
    if (args["keep-temp"] !== "true") {
      await rm(temp, {
        recursive: true,
        force: true,
      });
    } else {
      console.log(`Kept temporary test directory: ${temp}`);
    }
  }
}

await main();
