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

test("archives, verifies, and fails open on corruption", async () => {
  const archiveRoot = await mkdtemp(join(tmpdir(), "pi-token-saver-"));
  const oldRoot = process.env.PI_TOOL_MASK_ARCHIVE_DIR;
  process.env.PI_TOOL_MASK_ARCHIVE_DIR = archiveRoot;

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
    await rm(archiveRoot, { recursive: true, force: true });
  }
});
