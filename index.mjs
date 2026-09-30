/**
 * attachment-download — host half.
 *
 * Registers two authenticated Fetch routes on the Connection API channel:
 *
 *   /api/attachment.download   list + stream a Session's stored *attachments*
 *   /api/workspace.file        list + stream a Session's *workspace files*
 *
 * Why this plugin exists
 * ----------------------
 * dsh 0.1.5-rc.2 already stores every uploaded file under
 * `$DSH_HOME/attachments/v1` and already ships byte-serving routes:
 *
 *   GET /api/file?path=<absolute host path>   (dsh-api-session-controller)
 *   GET /api/session.export?sessionId=…       (dsh-session-log-export, ZIP)
 *
 * but the browser UI has no *download* affordance for an individual file:
 *
 *   * `ui-attachment` renders a file card in the composer and in history, yet
 *     the card is inert, and `HistoricalImageCache` turns a durable image
 *     reference into a `blob:` object URL the lightbox displays rather than
 *     saves.
 *   * `ui-deliverables` renders a `present`/changed-file card whose only
 *     actions are host-desktop ones ("Open in default app", "Show in File
 *     Explorer"). On a headless host `/api/present.host` reports
 *     `{ available: false }`, the card's whole action menu is disabled
 *     (`menuDisabled = … || !host.available`), and the user sees
 *     "此主机没有可用的桌面，无法打开文件或文件夹" with no way to obtain the
 *     file at all.
 *
 * These routes close that gap without widening any existing authority:
 *
 *   * Authentication and the Host/Origin fence are applied by Connection
 *     before these handlers run: the routes register on `ctx.connection`'s
 *     exact Fetch registry, which only sees authenticated requests.
 *   * Attachments: the attachment id must be referenced by the addressed
 *     Session's own log — the rule the live image route already uses
 *     (`referencedImage` in dsh-api-session-controller, mirrored here so this
 *     plugin imports no other package's internals). Otherwise 404, never the
 *     bytes.
 *   * Workspace files: the path is resolved through `ctx.workspaceFiles.stat`,
 *     the *same* resolution plus regular-file/symlink gates the `present` open
 *     route uses (Session cwd / deployment workspace root), and bytes come
 *     from `ctx.fs`. A path failing that resolution is refused, so this route
 *     reaches exactly the file set the deliverable card already offers.
 *   * Bytes come from `ctx.attachments` / `ctx.fs`, so images are
 *     integrity-verified and verbatim files are digest-verified while
 *     streaming, exactly like every other read path.
 *
 * Routes
 * ------
 *   GET|HEAD /api/attachment.download
 *     ?sessionId=<session id>          required; authorizes every read
 *     [&attachmentId=<attachment id>]  omitted -> JSON listing
 *     [&kind=file|image]               optional hint, never trusted over the
 *                                      recorded reference
 *
 *   GET|HEAD /api/workspace.file
 *     ?sessionId=<session id>          required; supplies the workspace root
 *     &path=<path>                     required; absolute or workspace-relative
 *     [&seq=<seq>&index=<n>]           optional; re-derives the path from that
 *                                      `deliverables/presented` event instead
 *                                      of trusting the caller's `path`
 *     [&inline=1]                      inline disposition instead of attachment
 *
 * With bytes the response carries a `content-type` derived from the recorded
 * media type (attachments) or the path's extension (workspace files), and
 * `content-disposition: attachment` with an RFC 5987 `filename*` fallback for
 * non-ASCII names. Without a target (or with `list=1`) the response is
 * `application/json`. HEAD answers headers only for every form.
 *
 * Layout requirement — do not move this file
 * ------------------------------------------
 * Like `web-proxy-trust`, this plugin lives in its own package directory
 * beside a `package.json` carrying a non-empty `name` and `version`. The
 * Host's `plugin-package-inventory-deepseek` resolves the owning manifest of
 * every active loader entry on each model request; a loose module placed
 * directly in the profile directory walks up to the dsh-generated
 * `$DSH_HOME/profiles/web/package.json` (which has no `version`) and fails
 * every model request with REQUEST_EXTENSION. The same manifest is what
 * carries this plugin's `dsh.client` declaration for the browser half.
 *
 * Reversal
 * --------
 * Remove the `attachment-download` row from the profile's `cordis.patch.yml`
 * (or set `config: { enabled: false }`); the profile patch watcher applies the
 * loader change live. Host module *edits* need a `dsh web` restart, because an
 * already-imported ESM module is cached for the process lifetime.
 */

import { extname } from "node:path";

/** Stable route path; the browser half composes this exact path. */
export const ATTACHMENT_DOWNLOAD_PATH = "/api/attachment.download";

/** Stable route path for workspace-file downloads. */
export const WORKSPACE_FILE_PATH = "/api/workspace.file";

/** Upper bound on one listing response, keeping a pathological log bounded. */
const MAX_LISTED_ATTACHMENTS = 500;

/**
 * Sanitize an untrusted display name into a header-safe leaf name. Both
 * separator styles are neutralized (a POSIX host treats `\` as an ordinary
 * character, so a Windows client path would otherwise survive), control
 * characters are stripped, and the result can never be a dot segment.
 * @param value - caller-declared display name.
 * @param fallback - name used when nothing safe remains.
 * @returns a non-empty, header-safe leaf name.
 */
function safeFilename(value, fallback) {
  const leaf = String(value ?? "")
    .replace(/[\\/]/gu, "_")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/gu, "_")
    .replace(/^\.+$/u, "_")
    .trim();
  return leaf === "" ? fallback : leaf.slice(0, 200);
}

/**
 * Build one `content-disposition` value carrying both the ASCII fallback and
 * the RFC 5987 extended form, so a UTF-8 name survives every browser.
 * @param filename - already sanitized leaf name.
 * @returns the header value.
 */
function contentDisposition(filename) {
  const ascii = filename.replace(/[^\u0020-\u007e]/gu, "_").replace(/["\\]/gu, "_");
  const quoted = `filename="${ascii}"`;
  if (ascii === filename) return `attachment; ${quoted}`;
  return `attachment; ${quoted}; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/** Extension for each accepted raster media type, used when no name is recorded. */
const MEDIA_EXTENSIONS = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

/**
 * Collect attachment references from one content array, descending into
 * nested content the way the live attachment route does.
 * @param content - event content array, or nested tool-result content.
 * @param collect - sink receiving every reference found.
 */
function collectFromContent(content, collect) {
  if (!Array.isArray(content)) return;
  const pending = [...content];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const block = value;
    const attachment = block.attachment;
    if (
      (block.type === "image" || block.type === "file") &&
      typeof attachment === "object" &&
      attachment !== null &&
      typeof attachment.attachmentId === "string"
    ) {
      collect(attachment);
    }
    if (Array.isArray(block.content)) pending.push(...block.content);
  }
}

/**
 * Collect every attachment reference one Session event carries, across the
 * same carriers the live attachment route scans: direct content, message
 * content, inserted inbox messages, and completed blocks in an embedded
 * assistant stream.
 * @param event - one session event.
 * @param collect - sink receiving every reference found.
 */
function collectFromEvent(event, collect) {
  const data = event?.data;
  if (typeof data !== "object" || data === null) return;
  collectFromContent(data.content, collect);
  if (data.message !== undefined) collectFromContent(data.message.content, collect);
  if (Array.isArray(data.inserted)) {
    for (const message of data.inserted) collectFromContent(message?.content, collect);
  }
  if (Array.isArray(data.stream)) {
    for (const record of data.stream) {
      if (record?.type !== "chunk" || record.chunk?.type !== "block-end") continue;
      collectFromContent([record.chunk.block], collect);
    }
  }
}

/**
 * Determine whether a resolved reference is an image (it carries a media
 * type) or a verbatim file (it carries a name and byte count only).
 * @param ref - durable reference from the session log.
 * @returns the kind.
 */
function refKind(ref) {
  return typeof ref?.mediaType === "string" ? "image" : "file";
}

/**
 * Human-facing name for one reference: the recorded name when present,
 * otherwise a deterministic name built from the id and media type.
 * @param ref - durable reference.
 * @returns a sanitized leaf name.
 */
function displayName(ref) {
  const kind = refKind(ref);
  if (typeof ref.name === "string" && ref.name !== "") {
    return safeFilename(ref.name, kind === "image" ? "image" : "file");
  }
  if (kind === "image") {
    const extension = MEDIA_EXTENSIONS[ref.mediaType] ?? "bin";
    return `image-${String(ref.attachmentId).replace(/[^A-Za-z0-9_-]/gu, "")}.${extension}`;
  }
  return "file.bin";
}

/**
 * Resolve one attachment id against a Session's own event log. Both the
 * opaque image id and the `sha256:<hex>` file id are compared as strings, so
 * one lookup serves either kind.
 * @param events - the Session's complete event list.
 * @param attachmentId - the requested id.
 * @returns the durable reference recorded by the log, or undefined.
 */
export function referencedAttachment(events, attachmentId) {
  const wanted = String(attachmentId);
  let found;
  for (const event of events) {
    collectFromEvent(event, (ref) => {
      if (found === undefined && String(ref.attachmentId) === wanted) found = ref;
    });
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * List every distinct attachment one Session references, newest first.
 * The dedupe key pairs the id with the display name so two names for one
 * digest both surface, matching how the ZIP export addresses stored files;
 * a reference seen more than once keeps the newest event time.
 * @param events - the Session's complete event list.
 * @returns one listing row per distinct attachment.
 */
export function listAttachments(events) {
  const seen = new Map();
  for (const event of events) {
    const time = Number.isFinite(event?.time) ? event.time : undefined;
    collectFromEvent(event, (ref) => {
      if (seen.size >= MAX_LISTED_ATTACHMENTS) return;
      const kind = refKind(ref);
      const name = displayName(ref);
      const key = `${String(ref.attachmentId)}\u0000${kind}\u0000${name}`;
      const existing = seen.get(key);
      if (existing !== undefined) {
        if (time !== undefined && (existing.time === undefined || time > existing.time)) existing.time = time;
        return;
      }
      seen.set(key, {
        attachmentId: String(ref.attachmentId),
        kind,
        name,
        bytes: Number.isFinite(ref.bytes) ? ref.bytes : 0,
        ...(kind === "image" ? { mediaType: ref.mediaType } : {}),
        ...(time === undefined ? {} : { time }),
      });
    });
  }
  return sortNewestFirst([...seen.values()]);
}

/**
 * Order listing rows newest first, then by name. A row the Session log never
 * stamped sorts last rather than pretending to be new; this is the one
 * ordering the tabs share, so both sections read the same way.
 * @param rows - listing rows carrying an optional `time`.
 * @returns a new array in the display order.
 */
function sortNewestFirst(rows) {
  return [...rows].sort((left, right) => {
    const a = left.time ?? -Infinity;
    const b = right.time ?? -Infinity;
    if (a !== b) return b - a;
    return String(left.name ?? "").localeCompare(String(right.name ?? ""));
  });
}

/**
 * Read the addressed Session's event log without activating an Agent,
 * preferring a live session over its persisted copy.
 * @param ctx - host context carrying `sessions` and `sessionQuery`.
 * @param sessionId - addressed session.
 * @param signal - request cancellation.
 * @returns the events, or undefined when no such session exists.
 */
async function readSessionEvents(ctx, sessionId, signal) {
  const live = ctx.get("sessions")?.get(sessionId);
  if (live !== undefined) return [...live.snapshotEvents()];
  const sessionQuery = ctx.get("sessionQuery");
  if (sessionQuery === undefined) return undefined;
  let observation;
  try {
    observation = await sessionQuery.observeSession(sessionId, {
      projectionMode: "none",
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    // A cold id with no stored log is a missing Session, not a server fault.
    // `session-query` signals that with a stable code; discriminate on the
    // code rather than the class, which lives in a package this plugin does
    // not import.
    if (error?.code === "SESSION_QUERY_SESSION_NOT_FOUND") return undefined;
    throw error;
  }
  try {
    return [...observation.events];
  } finally {
    // The lease is disposable; release it on every path.
    observation?.[Symbol.dispose]?.();
  }
}

/** JSON response helper shared by the listing and every failure path. */
function json(body, status, extraHeaders) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      ...extraHeaders,
    },
  });
}

/**
 * Test whether one referenced attachment's stored object is still present.
 *
 * The store exposes the object's host path, and the composed filesystem owns
 * the read policy for the execution world, so one `stat` answers existence
 * without reading bytes.
 *
 * Failure handling is deliberately asymmetric. A *definitive* "no such entry"
 * drops the row, because that is a real answer about the user's data. Any
 * other failure (an unmapped host path, a backend that cannot resolve it, a
 * capability that is absent) keeps the row: hiding a file because a probe was
 * inconclusive would lose the user's own data, and the download itself still
 * fails closed on a real read error.
 *
 * @param ctx - host context carrying `attachments` and `fs`.
 * @param ref - durable reference from the session log.
 * @param signal - request cancellation.
 * @returns whether the object appears to exist.
 */
async function attachmentObjectExists(ctx, ref, signal) {
  const attachments = ctx.get("attachments");
  const fs = ctx.get("fs");
  if (attachments === undefined || fs === undefined) return true;
  let hostPath;
  try {
    hostPath = refKind(ref) === "image" ? attachments.imageHostPath(ref) : attachments.fileHostPath(ref);
  } catch {
    // An invalid reference cannot back a readable object; the download route
    // reports the same condition, so the row is not a loss.
    return false;
  }
  if (typeof hostPath !== "string" || hostPath === "") return true;
  try {
    const info = await fs.stat(await fs.resolve(hostPath, { signal }), signal);
    return info !== undefined;
  } catch (error) {
    signal?.throwIfAborted();
    const code = error?.code;
    if (code === "FS_NOT_FOUND" || code === "FS_NOT_REGULAR_FILE" || code === "ENOENT" || code === "ENOTDIR") {
      return false;
    }
    return true;
  }
}

/**
 * Build the streaming response for one authenticated download request.
 * @param ctx - host context carrying attachments and session services.
 * @param request - authenticated Fetch request on the Connection channel.
 * @returns the byte response, or a JSON failure with its status.
 */
async function attachmentDownloadResponse(ctx, request) {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get("sessionId");
  if (sessionId === null || sessionId === "") return json({ error: "sessionId is required" }, 400);
  const attachments = ctx.get("attachments");
  if (attachments === undefined) {
    return json({ error: "attachment download is unavailable: no attachment store is mounted" }, 500);
  }

  let events;
  try {
    events = await readSessionEvents(ctx, sessionId, request.signal);
  } catch {
    request.signal.throwIfAborted();
    return json({ error: "unable to read the addressed session" }, 500);
  }
  if (events === undefined) return json({ error: "session not found" }, 404);

  const attachmentId = url.searchParams.get("attachmentId");
  const wantsListing = attachmentId === null || attachmentId === "" || url.searchParams.get("list") === "1";
  if (wantsListing) {
    // A stored object can be gone (manual cleanup, a partial restore). Such a
    // row is dropped rather than shown disabled: the list exists to hand the
    // user files they can actually take.
    let rows = listAttachments(events);
    const checked = [];
    for (const row of rows) {
      request.signal.throwIfAborted();
      const ref = referencedAttachment(events, row.attachmentId);
      if (ref !== undefined && (await attachmentObjectExists(ctx, ref, request.signal))) checked.push(row);
    }
    rows = checked;
    const listing = { attachments: rows };
    if (request.method === "HEAD") {
      return new Response(null, {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "private, no-store" },
      });
    }
    return json(listing, 200);
  }

  const ref = referencedAttachment(events, attachmentId);
  if (ref === undefined) {
    // Never distinguish "exists but unreferenced" from "absent": the Session
    // log is the entire authorization surface and is silent on both.
    return json({ error: "attachment is not referenced by this session" }, 404);
  }

  const kind = refKind(ref);
  const filename = displayName(ref);
  const headers = {
    "content-type": kind === "image" ? ref.mediaType : "application/octet-stream",
    "content-disposition": contentDisposition(filename),
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
    // Force a save rather than an in-origin render for HTML/SVG payloads.
    "content-security-policy": "sandbox; default-src 'none'",
  };
  if (Number.isFinite(ref.bytes)) headers["content-length"] = String(ref.bytes);

  if (request.method === "HEAD") return new Response(null, { status: 200, headers });

  // Images are size-capped by the deployment policy, so read and verify them
  // before committing to a 200: a corrupt or missing object answers cleanly
  // instead of breaking mid-download. Verbatim files have no size limit and
  // stream with backpressure and digest verification from the store's own
  // bounded reader — the same trade-off the Session-log ZIP export makes.
  if (kind === "image") {
    let stored;
    try {
      stored = await attachments.readImage(ref, request.signal);
    } catch (error) {
      return json(
        { error: `unable to read the stored image: ${error instanceof Error ? error.message : String(error)}` },
        500,
      );
    }
    return new Response(stored.data, { status: 200, headers });
  }

  return new Response(attachments.readFileStream(ref, request.signal), { status: 200, headers });
}

/** The host plugin name, matching the loader row id. */
export const name = "attachment-download-host";

/**
 * Only `connection` is *injected*: it owns the authenticated exact-Fetch
 * registry, so the routes cannot exist before it does. Every other service is
 * read lazily through `ctx.get` inside a handler, because (a) this plugin must
 * keep working when a deployment omits one of them — answering a clean 500
 * instead of failing to load — and (b) requiring `fs`/`workspaceFiles`/
 * `sessionQuery` up front would make the process fail at boot on a minimal
 * composition that never uses this feature.
 */
export const inject = ["connection"];

/** Media type for path extensions the deployment never renders in-origin. */
const EXTENSION_MEDIA_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".zip": "application/zip",
  ".tar": "application/x-tar",
  ".gz": "application/gzip",
  ".7z": "application/x-7z-compressed",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

/**
 * Best-effort media type for one workspace path. Unknown extensions fall back
 * to the octet-stream every browser saves verbatim.
 * @param path - resolved or requested file path.
 * @returns a media type.
 */
function mediaTypeForPath(path) {
  return EXTENSION_MEDIA_TYPES[extname(String(path)).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Build the boolean/content headers shared by both byte routes. The CSP
 * sandbox plus `nosniff` keep an HTML/SVG payload from rendering on the
 * authenticated API origin even when the disposition is inline.
 * @param mediaType - response content type.
 * @param filename - already sanitized leaf name.
 * @param inline - whether the browser may render the response in place.
 * @returns the header table.
 */
function byteHeaders(mediaType, filename, inline) {
  const disposition = inline ? "inline" : "attachment";
  return {
    "content-type": mediaType,
    "content-disposition": contentDisposition(filename).replace(/^attachment/u, disposition),
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": "sandbox; default-src 'none'",
  };
}

/**
 * Resolve one Session's workspace scope the way the `present` open route does:
 * the Session's own `cwd` when it has one, otherwise the deployment root.
 * @param ctx - host context carrying `sessions`, `sessionQuery`, `sandboxPolicy`.
 * @param sessionId - addressed session.
 * @param signal - request cancellation.
 * @returns the workspace root and owning cwd, or undefined when absent.
 */
async function workspaceScopeOf(ctx, sessionId, signal) {
  const defaultRoot = ctx.get("sandboxPolicy")?.workspaceRoot;
  const live = ctx.get("sessions")?.get(sessionId);
  if (live !== undefined) {
    const cwd = live.header?.cwd;
    return { cwd, root: cwd ?? defaultRoot };
  }
  const sessionQuery = ctx.get("sessionQuery");
  if (sessionQuery === undefined) return undefined;
  let observation;
  try {
    observation = await sessionQuery.observeSession(sessionId, {
      projectionMode: "none",
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    if (error?.code === "SESSION_QUERY_SESSION_NOT_FOUND") return undefined;
    throw error;
  }
  try {
    const cwd = observation.header?.cwd;
    return { cwd, root: cwd ?? defaultRoot };
  } finally {
    observation?.[Symbol.dispose]?.();
  }
}

/**
 * Re-derive one declared path from its own `deliverables/presented` event, so
 * a caller cannot name an arbitrary path by lying about `path` while quoting
 * real event coordinates. Falls back to the requested path only when no
 * coordinates were supplied.
 * @param ctx - host context carrying `sessionQuery`.
 * @param sessionId - addressed session.
 * @param seq - event sequence, when supplied.
 * @param index - index inside that event's `files` array.
 * @param signal - request cancellation.
 * @returns the declared path, or undefined when the coordinates do not resolve.
 */
async function declaredPathFromEvent(ctx, sessionId, seq, index, signal) {
  const sessionQuery = ctx.get("sessionQuery");
  if (sessionQuery === undefined) return undefined;
  const window = await sessionQuery.readEvent(
    { sessionId, seq, before: 0, after: 0 },
    signal === undefined ? undefined : signal,
  );
  const target = window?.target;
  if (target?.type !== "deliverables/presented") return undefined;
  const files = target.data?.files;
  if (!Array.isArray(files)) return undefined;
  const file = files[index];
  if (typeof file !== "object" || file === null) return undefined;
  return typeof file.path === "string" && file.path.trim() !== "" ? file.path : undefined;
}

/** Non-blank path string, or undefined. */
function pathOf(value) {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/**
 * Extract the file path a mutating tool call names, using the same tool
 * vocabulary `ui-deliverables` folds its "files changed" row from: `write`,
 * `edit`, and the mutating `str_replace_editor` commands. Reads and
 * non-mutating commands contribute nothing.
 * @param name - tool name.
 * @param argumentsRaw - the call's raw JSON argument text.
 * @returns the named path, or undefined.
 */
function mutationPathOf(name, argumentsRaw) {
  let args;
  try {
    args = JSON.parse(argumentsRaw);
  } catch {
    return undefined;
  }
  if (typeof args !== "object" || args === null || Array.isArray(args)) return undefined;
  switch (name) {
    case "write":
      return typeof args.content === "string" ? pathOf(args.file_path) : undefined;
    case "edit":
      return pathOf(args.file_path);
    case "str_replace_editor": {
      const path = pathOf(args.path);
      if (path === undefined) return undefined;
      if (args.command === "create") return typeof args.file_text === "string" ? path : undefined;
      if (args.command === "str_replace") return typeof args.old_str === "string" ? path : undefined;
      if (args.command === "insert") return typeof args.insert_new_str === "string" || typeof args.new_str === "string" ? path : undefined;
      return undefined;
    }
    default:
      return undefined;
  }
}

/**
 * Collect every downloadable workspace path one Session's log names, keeping
 * the latest moment the Session touched each file: explicitly
 * `present`-declared deliveries, then files whose mutating tool call
 * succeeded. A path that is both delivered and produced stays "presented"
 * (the stronger claim) but still takes the newest timestamp, so an edit made
 * after delivery does not push the file down the list.
 * @param events - the Session's complete event list.
 * @returns `{ path, kind, time }` rows, where `time` is epoch milliseconds.
 */
export function collectWorkspacePaths(events) {
  const rows = new Map();
  const add = (path, kind, time) => {
    const existing = rows.get(path);
    const stamp = Number.isFinite(time) ? time : undefined;
    if (existing === undefined) {
      rows.set(path, { path, kind, ...(stamp === undefined ? {} : { time: stamp }) });
      return;
    }
    if (stamp !== undefined && (existing.time === undefined || stamp > existing.time)) existing.time = stamp;
  };

  for (const event of events) {
    if (event?.type !== "deliverables/presented") continue;
    const files = event.data?.files;
    if (!Array.isArray(files)) continue;
    for (const file of files) {
      const path = pathOf(file?.path);
      if (path !== undefined) add(path, "presented", event.time);
    }
  }

  // A mutation counts only once its own tool result succeeded; the result for a
  // call always follows it, so this needs the call table first. The result's
  // own time is the moment the file reached its content, which is the honest
  // "created at" for a produced file.
  const calls = new Map();
  const succeeded = new Map();
  for (const event of events) {
    if (event?.type === "tool/call") {
      const path = mutationPathOf(event.data?.name, event.data?.arguments);
      if (path !== undefined) calls.set(String(event.data?.callId), path);
      continue;
    }
    if (event?.type !== "tool/result") continue;
    const source = event.data?.message?.source;
    if (source?.kind !== "tool") continue;
    const failed = event.data?.message?.content?.[0]?.isError === true || event.data?.error !== undefined;
    if (!failed) succeeded.set(String(source.callId), event.time);
  }
  for (const [callId, path] of calls) {
    if (succeeded.has(callId)) add(path, "produced", succeeded.get(callId));
  }

  return [...rows.values()];
}

/**
 * Resolve every path one Session's log declared to its absolute execution-world
 * form, so a caller-supplied path can be compared against the declarations
 * regardless of whether the Session spelled it absolutely or relatively.
 * Paths that no longer resolve are skipped: the byte branch re-stats the
 * requested path anyway, so an unresolvable declaration can never authorize a
 * read.
 * @param ctx - host context carrying session services.
 * @param workspaceFiles - the workspace-files service.
 * @param sessionId - addressed session.
 * @param root - workspace root used as the relative base.
 * @param signal - request cancellation.
 * @returns the absolute paths, or undefined when the Session does not exist.
 */
async function declaredAbsolutePaths(ctx, workspaceFiles, sessionId, root, signal) {
  const events = await readSessionEvents(ctx, sessionId, signal);
  if (events === undefined) return undefined;
  const resolved = new Set();
  for (const row of collectWorkspacePaths(events)) {
    signal?.throwIfAborted();
    try {
      const stat = await workspaceFiles.stat({ sessionId, workspaceRoot: root }, row.path, signal);
      resolved.add(stat.absolutePath);
    } catch {
      signal?.throwIfAborted();
      // A declaration that no longer resolves simply does not authorize
      // anything; the caller's own stat reports the precise failure.
    }
  }
  return resolved;
}

/**
 * Build the JSON listing of one Session's downloadable workspace files,
 * resolving each path through the same gate the single-file download uses so
 * the listing never advertises a file the byte route would refuse.
 *
 * A declared path that no longer resolves is dropped rather than shown
 * disabled: the list exists to hand the user files they can actually take, and
 * a row whose only affordance is greyed out is noise.
 *
 * @param ctx - host context carrying fs, workspaceFiles, and session services.
 * @param sessionId - addressed session.
 * @param signal - request cancellation.
 * @returns the listing rows, newest first.
 */
async function listWorkspaceFiles(ctx, sessionId, signal) {
  const workspaceFiles = ctx.get("workspaceFiles");
  if (workspaceFiles === undefined) return [];
  let events;
  try {
    events = await readSessionEvents(ctx, sessionId, signal);
  } catch {
    return [];
  }
  if (events === undefined) return [];
  const scope = await workspaceScopeOf(ctx, sessionId, signal);
  if (scope === undefined || scope.root === undefined) return [];

  const rows = collectWorkspacePaths(events);
  const out = [];
  for (const row of rows) {
    signal?.throwIfAborted();
    try {
      const stat = await workspaceFiles.stat({ sessionId, workspaceRoot: scope.root }, row.path, signal);
      const absolutePath = stat.absolutePath;
      out.push({
        path: row.path,
        absolutePath,
        kind: row.kind,
        name: safeFilename(absolutePath.split(/[/\\]/u).pop(), "file.bin"),
        bytes: Number.isFinite(stat.bytes) ? stat.bytes : 0,
        ...(row.time === undefined ? {} : { time: row.time }),
      });
    } catch {
      signal?.throwIfAborted();
      // Dropped on purpose: see the doc comment above.
    }
  }

  // Newest first, through the same ordering the attachment section uses.
  return sortNewestFirst(out);
}

/**
 * Build the streaming response for one authenticated workspace-file download.
 * @param ctx - host context carrying fs, workspaceFiles, and session services.
 * @param request - authenticated Fetch request on the Connection channel.
 * @returns the byte response, or a JSON failure with its status.
 */
async function workspaceFileResponse(ctx, request) {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get("sessionId");
  if (sessionId === null || sessionId === "") return json({ error: "sessionId is required" }, 400);

  const workspaceFiles = ctx.get("workspaceFiles");
  const fs = ctx.get("fs");
  if (workspaceFiles === undefined || fs === undefined) {
    return json({ error: "workspace file download is unavailable: fs or workspaceFiles is not mounted" }, 500);
  }

  let scope;
  try {
    scope = await workspaceScopeOf(ctx, sessionId, request.signal);
  } catch {
    request.signal.throwIfAborted();
    return json({ error: "unable to read the addressed session" }, 500);
  }
  if (scope === undefined || scope.root === undefined) return json({ error: "session not found" }, 404);

  // A `path` request is only honoured for a file *this Session itself named*
  // — as a `present` declaration or as a successful mutating tool call. That
  // is the whole authorization surface, and it deliberately mirrors the
  // `present` open route: the deliverable card only ever offers declared
  // paths, so this route must not reach further than the card does. Without
  // this gate a valid Session id would read any host file the process can
  // open (credentials included), which is strictly more than the UI grants.
  const seqRaw = url.searchParams.get("seq");
  const indexRaw = url.searchParams.get("index");
  const pathRaw = url.searchParams.get("path");
  let requestedPath = pathRaw;

  if (seqRaw !== null || indexRaw !== null) {
    // Event coordinates are the strongest form: the path is re-derived from
    // the referenced event, so the caller's `path` is ignored entirely.
    if (!/^\d+$/u.test(seqRaw ?? "") || !/^\d+$/u.test(indexRaw ?? "")) {
      return json({ error: "seq and index must both be non-negative integers" }, 400);
    }
    let declared;
    try {
      declared = await declaredPathFromEvent(
        ctx,
        sessionId,
        Number(seqRaw),
        Number(indexRaw),
        request.signal,
      );
    } catch {
      request.signal.throwIfAborted();
      return json({ error: "unable to read the declared file coordinates" }, 500);
    }
    if (declared === undefined) return json({ error: "presented file not found in this session" }, 404);
    requestedPath = declared;
  }

  // No target named: answer the listing every workspace path this Session's log
  // offers, so a browser with no way to open the host desktop can still save
  // them. The listing is resolved per path, so it never advertises a file the
  // byte branch below would refuse.
  if (requestedPath === null || requestedPath === "" || url.searchParams.get("list") === "1") {
    let files;
    try {
      files = await listWorkspaceFiles(ctx, sessionId, request.signal);
    } catch {
      request.signal.throwIfAborted();
      return json({ error: "unable to list the session workspace files" }, 500);
    }
    if (request.method === "HEAD") {
      return new Response(null, {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "private, no-store" },
      });
    }
    return json({ files }, 200);
  }

  // The declared-path gate. A caller-supplied `path` is accepted only when the
  // Session's own log named that file; otherwise 404. Comparison happens on the
  // resolved absolute path, so a relative spelling the Session used
  // ("out/report.html") and the absolute form it means are one file, while an
  // unrelated path never matches.
  let declared;
  try {
    declared = await declaredAbsolutePaths(ctx, workspaceFiles, sessionId, scope.root, request.signal);
  } catch {
    request.signal.throwIfAborted();
    return json({ error: "unable to read the session file declarations" }, 500);
  }
  if (declared === undefined) return json({ error: "session not found" }, 404);

  // The same resolution the `present` open route performs: Session cwd as the
  // relative base, regular-file and symlink gates, then a canonical-path
  // round-trip so only a verified host path is served.
  let stat;
  try {
    stat = await workspaceFiles.stat(
      { sessionId, workspaceRoot: scope.root },
      requestedPath,
      request.signal,
    );
  } catch (error) {
    request.signal.throwIfAborted();
    const code = error?.code;
    const missing =
      code === "session/not-found" ||
      code === "workspace-file/not-found" ||
      code === "workspace-file/not-regular-file" ||
      code === "SESSION_QUERY_SESSION_NOT_FOUND" ||
      code === "SESSION_QUERY_EVENT_NOT_FOUND" ||
      code === "ENOENT" ||
      code === "ENOTDIR";
    if (missing) return json({ error: "file not found in this session workspace" }, 404);
    return json(
      { error: `unable to resolve the requested file: ${error instanceof Error ? error.message : String(error)}` },
      500,
    );
  }

  if (!declared.has(stat.absolutePath)) {
    return json({ error: "file is not declared by this session" }, 404);
  }

  const absolutePath = stat.absolutePath;
  const filename = safeFilename(absolutePath.split(/[/\\]/u).pop(), "file.bin");
  const mediaType = mediaTypeForPath(absolutePath);
  const inline = url.searchParams.get("inline") === "1";
  const headers = byteHeaders(mediaType, filename, inline);
  if (Number.isFinite(stat.bytes)) headers["content-length"] = String(stat.bytes);

  if (request.method === "HEAD") return new Response(null, { status: 200, headers });

  // Bytes come from the composed filesystem, which owns the access policy for
  // the execution world. The file is streamed as bounded windows rather than
  // read whole, so a large deliverable never has to fit in memory: each pull
  // reads one window, and the loop stops at the size the stat reported.
  let target;
  try {
    target = await fs.resolve(absolutePath, { signal: request.signal });
    const info = await fs.stat(target, request.signal);
    if (info === undefined) return json({ error: "file not found in this session workspace" }, 404);
    if (info.type !== "file") return json({ error: "not a regular file" }, 403);
  } catch (error) {
    request.signal.throwIfAborted();
    const code = error?.code;
    if (code === "FS_NOT_FOUND" || code === "FS_NOT_REGULAR_FILE") {
      return json({ error: "file not found in this session workspace" }, 404);
    }
    if (code === "FS_PERMISSION_DENIED" || code === "FS_SANDBOX_DENIED") {
      return json({ error: "file access denied" }, 403);
    }
    return json(
      { error: `unable to read the file: ${error instanceof Error ? error.message : String(error)}` },
      500,
    );
  }

  return new Response(windowStream(fs, target, stat.bytes, request.signal), { status: 200, headers });
}

/** Largest window one stream pull reads; well under the deployment window cap. */
const WINDOW_BYTES = 256 * 1024;

/**
 * Stream one resolved file as ordered byte windows, bounded by the size the
 * resolution reported. Each window is read on demand, so memory stays bounded
 * by {@link WINDOW_BYTES} whatever the file size, and the declared
 * `content-length` still holds when a writer appends concurrently.
 * @param fs - the composed filesystem.
 * @param target - already resolved and verified regular-file target.
 * @param size - byte size from the resolution, or undefined when unknown.
 * @param signal - request cancellation.
 * @returns the byte stream.
 */
async function* windowStream(fs, target, size, signal) {
  let offset = 0;
  let remaining = Number.isFinite(size) ? size : Infinity;
  while (remaining > 0) {
    signal?.throwIfAborted();
    const length = Math.min(WINDOW_BYTES, remaining);
    const bytes = await fs.readByteRange(target, { offset, length }, signal);
    if (bytes.byteLength === 0) return;
    yield bytes;
    offset += bytes.byteLength;
    remaining -= bytes.byteLength;
    if (bytes.byteLength < length) return;
  }
}

/**
 * Register the download routes for this plugin's lifetime. `register` already
 * scopes each route to the calling fiber, so both disappear with the plugin.
 * @param ctx - web profile host context.
 * @param config - optional `{ enabled?: boolean }` from the loader row.
 */
export function apply(ctx, config) {
  if (config?.enabled === false) return;
  ctx.connection.fetch.register({
    path: ATTACHMENT_DOWNLOAD_PATH,
    methods: ["GET", "HEAD"],
    requestBody: "buffered",
    fetch: (request) => attachmentDownloadResponse(ctx, request),
  });
  ctx.connection.fetch.register({
    path: WORKSPACE_FILE_PATH,
    methods: ["GET", "HEAD"],
    requestBody: "buffered",
    fetch: (request) => workspaceFileResponse(ctx, request),
  });
}
