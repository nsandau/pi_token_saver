import { strict as assert } from "node:assert";
import { mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import recoverableToolMask from "../extensions/recoverable-tool-mask.ts";

type Handler = (event: any, ctx: any) => Promise<any> | any;

function createPi() {
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, any>();
  return {
    handlers,
    commands,
    api: {
      on(name: string, handler: Handler) {
        handlers.set(name, handler);
      },
      registerCommand(name: string, command: any) {
        commands.set(name, command);
      },
    },
  };
}

function context(sessionId: string, sessionFile: string) {
  return {
    hasUI: false,
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => sessionFile,
    },
  };
}

function messages(text: string) {
  return [
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "echo test" } }],
    },
    {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "bash",
      isError: false,
      content: [{ type: "text", text }],
    },
    ...Array.from({ length: 10 }, () => ({ role: "assistant", content: [] })),
  ];
}

function batchMessages(results: Array<{ id: string; text: string }>) {
  return [
    ...results.flatMap(({ id, text }) => [
      {
        role: "assistant",
        content: [{ type: "toolCall", id, name: "bash", arguments: { command: "echo test" } }],
      },
      {
        role: "toolResult",
        toolCallId: id,
        toolName: "bash",
        isError: false,
        content: [{ type: "text", text }],
      },
    ]),
    ...Array.from({ length: 10 }, () => ({ role: "assistant", content: [] })),
  ];
}

test("archives, verifies, and fails open on corruption", async () => {
  const archiveRoot = await mkdtemp(join(tmpdir(), "pi-token-saver-"));
  const oldRoot = process.env.PI_TOOL_MASK_ARCHIVE_DIR;
  const oldThreshold = process.env.PI_TOOL_MASK_BATCH_THRESHOLD;
  process.env.PI_TOOL_MASK_ARCHIVE_DIR = archiveRoot;
  process.env.PI_TOOL_MASK_BATCH_THRESHOLD = "0";

  try {
    const pi = createPi();
    recoverableToolMask(pi.api as any);
    const session = context("reused-session", "/tmp/first.jsonl");
    await pi.handlers.get("session_start")!({}, session);

    const original = "result ".repeat(200);
    const first = messages(original);
    await pi.handlers.get("context")!({ messages: first }, session);
    const stub = first[1].content[0].text as string;
    const txtPath = stub.match(/Full output: (.+)\n/)?.[1];
    assert.ok(txtPath);
    const manifestPath = txtPath!.replace(/\.txt$/, ".manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.equal(manifest.version, 2);
    assert.equal(manifest.sessionId, "reused-session");
    assert.equal(manifest.sessionFile, "/tmp/first.jsonl");
    assert.equal(manifest.textBytes, Buffer.byteLength(original));
    assert.equal(await readFile(txtPath!, "utf8"), original);

    const second = messages(original);
    await pi.handlers.get("context")!({ messages: second }, session);
    assert.match(second[1].content[0].text, /^\[Archived bash result/);

    await writeFile(txtPath!, "corrupt", "utf8");
    const corrupted = messages(original);
    await pi.handlers.get("context")!({ messages: corrupted }, session);
    assert.equal(corrupted[1].content[0].text, original);

    await writeFile(txtPath!, original, "utf8");
    await unlink(manifestPath);
    const recoveredManifest = messages(original);
    await pi.handlers.get("context")!({ messages: recoveredManifest }, session);
    assert.match(recoveredManifest[1].content[0].text, /^\[Archived bash result/);
    assert.equal(JSON.parse(await readFile(manifestPath, "utf8")).version, 2);

    const secondSession = context("reused-session", "/tmp/second.jsonl");
    await pi.handlers.get("session_start")!({}, secondSession);
    const secondSessionMessages = messages(original);
    await pi.handlers.get("context")!({ messages: secondSessionMessages }, secondSession);
    assert.equal((await readdir(archiveRoot)).length, 2);
  } finally {
    if (oldRoot === undefined) delete process.env.PI_TOOL_MASK_ARCHIVE_DIR;
    else process.env.PI_TOOL_MASK_ARCHIVE_DIR = oldRoot;
    if (oldThreshold === undefined) delete process.env.PI_TOOL_MASK_BATCH_THRESHOLD;
    else process.env.PI_TOOL_MASK_BATCH_THRESHOLD = oldThreshold;
    await rm(archiveRoot, { recursive: true, force: true });
  }
});

test("commits eligible results only when their reclaimable batch threshold is reached", async () => {
  const archiveRoot = await mkdtemp(join(tmpdir(), "pi-token-saver-batch-"));
  const oldRoot = process.env.PI_TOOL_MASK_ARCHIVE_DIR;
  const oldThreshold = process.env.PI_TOOL_MASK_BATCH_THRESHOLD;
  process.env.PI_TOOL_MASK_ARCHIVE_DIR = archiveRoot;
  process.env.PI_TOOL_MASK_BATCH_THRESHOLD = "1000";

  try {
    const pi = createPi();
    recoverableToolMask(pi.api as any);
    const session = context("batched-session", "/tmp/batched.jsonl");
    await pi.handlers.get("session_start")!({}, session);

    const firstResults = [
      { id: "call-a", text: "a".repeat(1_600) },
      { id: "call-b", text: "b".repeat(1_600) },
    ];
    const belowThreshold = batchMessages(firstResults);
    await pi.handlers.get("context")!({ messages: belowThreshold }, session);
    assert.equal(belowThreshold[1].content[0].text, firstResults[0].text);
    assert.equal(belowThreshold[3].content[0].text, firstResults[1].text);

    const allResults = [...firstResults, { id: "call-c", text: "c".repeat(1_600) }];
    const crossing = batchMessages(allResults);
    await pi.handlers.get("context")!({ messages: crossing }, session);
    for (const index of [1, 3, 5]) {
      assert.match(crossing[index].content[0].text, /^\[Archived bash result/);
    }

    const next = batchMessages([...allResults, { id: "call-d", text: "d".repeat(1_600) }]);
    await pi.handlers.get("context")!({ messages: next }, session);
    for (const index of [1, 3, 5]) {
      assert.match(next[index].content[0].text, /^\[Archived bash result/);
    }
    assert.equal(next[7].content[0].text, "d".repeat(1_600));
  } finally {
    if (oldRoot === undefined) delete process.env.PI_TOOL_MASK_ARCHIVE_DIR;
    else process.env.PI_TOOL_MASK_ARCHIVE_DIR = oldRoot;
    if (oldThreshold === undefined) delete process.env.PI_TOOL_MASK_BATCH_THRESHOLD;
    else process.env.PI_TOOL_MASK_BATCH_THRESHOLD = oldThreshold;
    await rm(archiveRoot, { recursive: true, force: true });
  }
});

test("reloads committed batches and preserves the age window on older branches", async () => {
  const archiveRoot = await mkdtemp(join(tmpdir(), "pi-token-saver-ledger-"));
  const oldRoot = process.env.PI_TOOL_MASK_ARCHIVE_DIR;
  const oldThreshold = process.env.PI_TOOL_MASK_BATCH_THRESHOLD;
  process.env.PI_TOOL_MASK_ARCHIVE_DIR = archiveRoot;
  process.env.PI_TOOL_MASK_BATCH_THRESHOLD = "0";

  try {
    const session = context("persisted-session", "/tmp/persisted.jsonl");
    const original = "result ".repeat(200);
    const firstPi = createPi();
    recoverableToolMask(firstPi.api as any);
    await firstPi.handlers.get("session_start")!({}, session);
    const committed = messages(original);
    await firstPi.handlers.get("context")!({ messages: committed }, session);
    assert.match(committed[1].content[0].text, /^\[Archived bash result/);

    const reloadedPi = createPi();
    recoverableToolMask(reloadedPi.api as any);
    await reloadedPi.handlers.get("session_start")!({ reason: "reload" }, session);

    const olderBranch = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "echo test" } }],
      },
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "bash",
        isError: false,
        content: [{ type: "text", text: original }],
      },
      ...Array.from({ length: 3 }, () => ({ role: "assistant", content: [] })),
    ];
    await reloadedPi.handlers.get("context")!({ messages: olderBranch }, session);
    assert.equal(olderBranch[1].content[0].text, original);

    const currentBranch = messages(original);
    await reloadedPi.handlers.get("context")!({ messages: currentBranch }, session);
    assert.match(currentBranch[1].content[0].text, /^\[Archived bash result/);
  } finally {
    if (oldRoot === undefined) delete process.env.PI_TOOL_MASK_ARCHIVE_DIR;
    else process.env.PI_TOOL_MASK_ARCHIVE_DIR = oldRoot;
    if (oldThreshold === undefined) delete process.env.PI_TOOL_MASK_BATCH_THRESHOLD;
    else process.env.PI_TOOL_MASK_BATCH_THRESHOLD = oldThreshold;
    await rm(archiveRoot, { recursive: true, force: true });
  }
});
