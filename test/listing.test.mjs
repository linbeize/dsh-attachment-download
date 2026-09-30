/**
 * Pure-logic tests for the two listing folds, plus a status-mapping probe for
 * both routes. No dsh process, no network: the host half's pure exports are
 * driven directly, and the route handlers are exercised through a stub context.
 *
 * Run: node test/listing.test.mjs
 */
import assert from "node:assert/strict";
import {
  ATTACHMENT_DOWNLOAD_PATH,
  WORKSPACE_FILE_PATH,
  apply,
  collectWorkspacePaths,
  listAttachments,
} from "../index.mjs";

const T = (n) => 1_700_000_000_000 + n * 60_000;
const enc = (s) => new TextEncoder().encode(s);

/** Build one successful `write` call/result pair for `path`. */
function writePair({ callId, seq, time, path }) {
  return [
    { type: "tool/call", seq, time, data: { turn: 1, step: 1, callId, name: "write", arguments: JSON.stringify({ file_path: path, content: "x" }) } },
    { type: "tool/result", seq: seq + 1, time, data: { message: { content: [{ type: "tool-result", toolCallId: callId, content: [], isError: false }], source: { kind: "tool", callId } } } },
  ];
}

/** One `present` declaration carrying `paths`. */
function presentEvent({ seq, time, paths }) {
  return { type: "deliverables/presented", seq, time, data: { turn: 1, callId: "c-present", files: paths.map((path) => ({ path })) } };
}

/** One user message attaching `refs`. */
function attachEvent({ seq, time, refs }) {
  return {
    type: "user/message",
    seq,
    time,
    data: { message: { content: refs.map((r) => ({ type: "file", attachment: r })) } },
  };
}

const fileRef = (id, name, bytes = 10) => ({ attachmentId: `sha256:${id}`, name, bytes });

let failures = 0;
/**
 * Run one check and report it. The callback may be sync or async; an async
 * one is awaited, because a route probe returns a promise and a forgotten
 * await would let a failing assertion escape as an unhandled rejection after
 * the check had already printed PASS.
 * @param label - check description.
 * @param fn - assertion body.
 * @returns completion after the check settles.
 */
async function check(label, fn) {
  try {
    await fn();
    console.log(`  PASS  ${label}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL  ${label}\n        ${error.message}`);
  }
}

// ── collectWorkspacePaths ───────────────────────────────────────────────────
console.log("collectWorkspacePaths");

await check("takes the newest stamp when a file is both produced and presented", () => {
  const events = [
    ...writePair({ callId: "c1", seq: 1, time: T(1), path: "/w/F.md" }),
    presentEvent({ seq: 3, time: T(2), paths: ["/w/F.md"] }),
  ];
  const rows = collectWorkspacePaths(events);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].time, T(2), "newest of (write T1, present T2)");
  assert.equal(rows[0].kind, "presented", "the stronger claim survives");
});

await check("keeps the write stamp when nothing re-declares the file", () => {
  const rows = collectWorkspacePaths(writePair({ callId: "c1", seq: 1, time: T(4), path: "/w/a.go" }));
  assert.equal(rows[0].time, T(4));
  assert.equal(rows[0].kind, "produced");
});

await check("a failed mutation contributes nothing", () => {
  const events = [
    { type: "tool/call", seq: 1, time: T(1), data: { callId: "c1", name: "write", arguments: JSON.stringify({ file_path: "/w/bad.md", content: "x" }) } },
    { type: "tool/result", seq: 2, time: T(1), data: { message: { content: [{ isError: true }], source: { kind: "tool", callId: "c1" } } } },
  ];
  assert.deepEqual(collectWorkspacePaths(events), []);
});

await check("a read is not a deliverable", () => {
  const events = [
    { type: "tool/call", seq: 1, time: T(1), data: { callId: "c1", name: "read", arguments: JSON.stringify({ file_path: "/etc/passwd" }) } },
    { type: "tool/result", seq: 2, time: T(1), data: { message: { content: [{ isError: false }], source: { kind: "tool", callId: "c1" } } } },
  ];
  assert.deepEqual(collectWorkspacePaths(events), []);
});

await check("malformed call arguments are ignored, not thrown", () => {
  const events = [{ type: "tool/call", seq: 1, time: T(1), data: { callId: "c1", name: "write", arguments: "{not json" } }];
  assert.deepEqual(collectWorkspacePaths(events), []);
});

await check("only mutating str_replace_editor commands count", () => {
  const events = [
    ...writePair({ callId: "c1", seq: 1, time: T(1), path: "/w/view.go" }),
    { type: "tool/call", seq: 3, time: T(2), data: { callId: "c1b", name: "str_replace_editor", arguments: JSON.stringify({ command: "view", path: "/w/view.go" }) } },
    { type: "tool/result", seq: 4, time: T(2), data: { message: { content: [{ isError: false }], source: { kind: "tool", callId: "c1b" } } } },
  ];
  // The earlier `write` still declares it; `view` does not add a second row.
  assert.equal(collectWorkspacePaths(events).length, 1);
});

await check("one path appears once however often it is touched", () => {
  const events = [
    ...writePair({ callId: "c1", seq: 1, time: T(1), path: "/w/F.md" }),
    ...writePair({ callId: "c2", seq: 3, time: T(3), path: "/w/F.md" }),
    ...writePair({ callId: "c3", seq: 5, time: T(5), path: "/w/F.md" }),
  ];
  const rows = collectWorkspacePaths(events);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].time, T(5), "newest touch wins");
});

// ── listAttachments ─────────────────────────────────────────────────────────
console.log("listAttachments");

await check("orders newest first", () => {
  const rows = listAttachments([
    attachEvent({ seq: 1, time: T(1), refs: [fileRef("a".repeat(64), "old.txt")] }),
    attachEvent({ seq: 2, time: T(9), refs: [fileRef("b".repeat(64), "new.txt")] }),
  ]);
  assert.deepEqual(rows.map((r) => r.name), ["new.txt", "old.txt"]);
});

await check("dedupe keeps the newest stamp and first-seen order for equals", () => {
  const id = "c".repeat(64);
  const rows = listAttachments([
    attachEvent({ seq: 1, time: T(1), refs: [fileRef(id, "same.txt")] }),
    attachEvent({ seq: 2, time: T(7), refs: [fileRef(id, "same.txt")] }),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].time, T(7));
});

await check("untimed rows sort last, by name", () => {
  const rows = listAttachments([
    attachEvent({ seq: 1, refs: [fileRef("d".repeat(64), "zz.txt"), fileRef("e".repeat(64), "aa.txt")] }),
    attachEvent({ seq: 2, time: T(3), refs: [fileRef("f".repeat(64), "timed.txt")] }),
  ]);
  assert.deepEqual(rows.map((r) => r.name), ["timed.txt", "aa.txt", "zz.txt"]);
});

await check("carries media type for images only", () => {
  const rows = listAttachments([
    { type: "user/message", seq: 1, time: T(1), data: { message: { content: [
      { type: "image", attachment: { attachmentId: "img-1", mediaType: "image/png", bytes: 5, width: 1, height: 1, name: "p.png" } },
      { type: "file", attachment: fileRef("9".repeat(64), "d.bin") },
    ] } } },
  ]);
  const image = rows.find((r) => r.name === "p.png");
  const file = rows.find((r) => r.name === "d.bin");
  assert.equal(image.mediaType, "image/png");
  assert.equal(file.mediaType, undefined);
});

// ── route status mapping ────────────────────────────────────────────────────
console.log("routes");

/** Register the plugin against a stub context and return both handlers. */
function mount(overrides = {}) {
  const registered = [];
  const events = overrides.events ?? [];
  const ctx = {
    get(name) {
      if (overrides.get) {
        const value = overrides.get(name);
        if (value !== undefined) return value;
      }
      if (name === "fs") return { async resolve(p) { return { targetKey: p, displayPath: p }; }, async stat() { return { version: "v", type: "file", size: 3 }; } };
      if (name === "sessions") return { get: () => ({ header: { cwd: "/w" }, snapshotEvents: () => events }) };
      if (name === "sandboxPolicy") return { workspaceRoot: "/w" };
      if (name === "sessionQuery") return { async observeSession() { throw new Error("unused"); }, async readEvent() { return { target: undefined }; } };
      if (name === "attachments") return { imageHostPath: () => undefined, fileHostPath: () => undefined };
      if (name === "workspaceFiles") return { stat: async (scope, p) => ({ absolutePath: p, version: "v", bytes: 5 }) };
      return undefined;
    },
    connection: { fetch: { register(route) { registered.push(route); } } },
  };
  apply(ctx);
  return {
    attachments: registered.find((r) => r.path === ATTACHMENT_DOWNLOAD_PATH),
    workspace: registered.find((r) => r.path === WORKSPACE_FILE_PATH),
  };
}

const call = (route, qs, method = "GET") => route.fetch(new Request("http://x" + route.path + qs, { method }));

await (async () => {
  const { attachments, workspace } = mount();
  await check("both routes register GET+HEAD", () => {
    assert.deepEqual(attachments.methods, ["GET", "HEAD"]);
    assert.deepEqual(workspace.methods, ["GET", "HEAD"]);
  });

  await check("workspace: missing sessionId is 400", async () => {
    assert.equal((await call(workspace, "?path=/w/a")).status, 400);
  });
  await check("workspace: missing path answers the listing", async () => {
    assert.equal((await call(workspace, "?sessionId=s1")).status, 200);
  });
  await check("workspace: non-numeric seq is 400", async () => {
    assert.equal((await call(workspace, "?sessionId=s1&seq=abc&index=0")).status, 400);
  });
  await check("workspace: unreferenced coordinates are 404", async () => {
    assert.equal((await call(workspace, "?sessionId=s1&seq=1&index=0")).status, 404);
  });
  await check("workspace: an undeclared path is refused", async () => {
    const response = await call(workspace, "?sessionId=s1&path=/etc/hostname");
    assert.equal(response.status, 404);
    assert.match(await response.text(), /not declared/u);
  });
  await check("workspace: a declared path downloads", async () => {
    const { workspace: ws } = mount({
      events: writePair({ callId: "c1", seq: 1, time: T(1), path: "/w/live.md" }),
      get: (name) => (name === "workspaceFiles" ? { stat: async (scope, p) => ({ absolutePath: p, version: "v", bytes: 5 }) } : undefined),
    });
    const response = await call(ws, "?sessionId=s1&path=/w/live.md");
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-disposition") ?? "", /^attachment; filename="live\.md"/u);
  });

  await check("attachment: listing answers JSON", async () => {
    const response = await call(attachments, "?sessionId=s1&list=1");
    assert.equal(response.status, 200);
    assert.ok(Array.isArray((await response.json()).attachments));
  });
  await check("attachment: an unreferenced id is 404", async () => {
    assert.equal((await call(attachments, `?sessionId=s1&attachmentId=sha256:${"a".repeat(64)}`)).status, 404);
  });
  await check("attachment: missing sessionId is 400", async () => {
    assert.equal((await call(attachments, "?list=1")).status, 400);
  });
  await check("HEAD answers without a body", async () => {
    const response = await call(workspace, "?sessionId=s1", "HEAD");
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "");
  });

  console.log("");
  if (failures > 0) {
    console.log(`${failures} check(s) FAILED`);
    process.exitCode = 1;
  } else {
    console.log("all checks passed");
  }
})();
