/**
 * attachment-download — browser half.
 *
 * Adds one Session Header action that opens a modal with everything the
 * Session can hand to the browser, each row downloading in one click:
 *
 *   * Attachments — the stored images and generic files the Session references.
 *   * Session files — the workspace files the Session produced or delivered.
 *
 * The second section is the point: `ui-deliverables` renders a `present` card
 * whose only actions are host-desktop ones, and on a headless host its whole
 * menu is disabled (`menuDisabled = … || !host.available`), leaving the user
 * with "此主机没有可用的桌面，无法打开文件或文件夹" and no way to obtain the
 * file. This modal gives that file set a browser-native path to the disk.
 *
 * This bundle is hand-written in the loader's factory form because the plugin
 * lives in the profile directory rather than in a package that runs `tsdown`.
 * It requires only modules from the shell's frozen platform seed table
 * (`react`, `react/jsx-runtime`, `@deepseek-ai/dsh-client-ui-primitives`), so it
 * declares no `dsh.client.external` edges and cannot drift from the build.
 *
 * The host half (`index.mjs`) owns the authenticated routes; this half only
 * composes URLs and hands them to the browser's own download manager, exactly
 * as `@deepseek-ai/dsh-session-log-export` does for the Session ZIP.
 */
window.__ModuleLoader__.load({
  id: "dsh-plugin-attachment-download",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var react = require("react");
    var jsxRuntime = require("react/jsx-runtime");
    var primitives = require("@deepseek-ai/dsh-client-ui-primitives");

    var h = jsxRuntime.jsx;
    var hs = jsxRuntime.jsxs;
    var useState = react.useState;
    var useEffect = react.useEffect;
    var useCallback = react.useCallback;
    var useMemo = react.useMemo;

    //#region styles
    var CSS = [
      ".adl_button{width:28px;height:28px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;border-radius:28px;flex:none;justify-content:center;align-items:center;padding:6px;display:inline-flex}",
      ".adl_button:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".adl_button:disabled{opacity:.5;cursor:default}",
      ".adl_button svg{width:15px;height:15px}",
      ".adl_body{max-height:56vh;overflow-y:auto;margin:0 -4px;padding:0 4px}",
      ".adl_list{flex-direction:column;gap:6px;margin:0;padding:0;list-style:none;display:flex}",
      ".adl_row{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l2,#0000001f);background:var(--dsw-specific-input-major,transparent);border-radius:12px;align-items:center;gap:10px;padding:8px 10px;display:flex}",
      ".adl_icon{flex:none;justify-content:center;align-items:center;width:24px;height:24px;display:inline-flex}",
      ".adl_text{flex-direction:column;flex:1;min-width:0;display:flex}",
      ".adl_name{white-space:nowrap;text-overflow:ellipsis;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:20px;overflow:hidden}",
      ".adl_meta{white-space:nowrap;text-overflow:ellipsis;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:16px;overflow:hidden}",
      ".adl_time{flex:none;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:16px;font-variant-numeric:tabular-nums;white-space:nowrap}",
      ".adl_note{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px;padding:8px 2px}",
      ".adl_error{color:var(--dsw-alias-state-error-primary);font-size:13px;line-height:20px;padding:8px 2px;word-break:break-word}",
    ].join("");

    var TAG_ID = "dsh-plugin-attachment-download/index.css";
    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(TAG_ID) + "]") === null) {
      var tag = document.createElement("style");
      tag.dataset.plugin = "dsh-plugin-attachment-download";
      tag.dataset.pluginCss = TAG_ID;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }
    //#endregion

    //#region host contract
    /** Route listing and streaming a Session's stored attachments. */
    var DOWNLOAD_PATH = "/api/attachment.download";
    /** Route listing and streaming a Session's workspace files. */
    var WORKSPACE_PATH = "/api/workspace.file";

    /**
     * Same-origin base for an API URL, with the connection carrier's
     * null-origin fallback for non-browser contexts.
     * @returns an absolute origin or the internal placeholder.
     */
    function hostBase() {
      var origin = globalThis.location && globalThis.location.origin;
      return origin !== undefined && origin !== "null" ? origin : "http://dsh.internal";
    }

    /**
     * Compose the download URL the browser opens for one attachment.
     * @param sessionId - authorizing Session identity.
     * @param attachmentId - durable attachment id.
     * @returns an absolute same-origin URL.
     */
    function attachmentUrlFor(sessionId, attachmentId) {
      var url = new URL(DOWNLOAD_PATH, hostBase());
      url.searchParams.set("sessionId", String(sessionId));
      url.searchParams.set("attachmentId", String(attachmentId));
      return url.toString();
    }

    /**
     * Compose the download URL for one workspace file. The host resolves
     * relative spellings against the Session workspace, so the already-resolved
     * absolute path is preferred when the listing supplied one: it removes any
     * dependence on the Session's working directory still being what it was.
     * @param sessionId - Session owning the workspace root.
     * @param item - a listing row.
     * @returns an absolute same-origin URL.
     */
    function workspaceUrlFor(sessionId, item) {
      var url = new URL(WORKSPACE_PATH, hostBase());
      url.searchParams.set("sessionId", String(sessionId));
      url.searchParams.set("path", String(item.absolutePath || item.path));
      return url.toString();
    }

    /**
     * Compose a listing URL for one of the two routes.
     * @param routePath - the route to read.
     * @param sessionId - Session whose files are listed.
     * @returns an absolute same-origin URL.
     */
    function listUrlFor(routePath, sessionId) {
      var url = new URL(routePath, hostBase());
      url.searchParams.set("sessionId", String(sessionId));
      url.searchParams.set("list", "1");
      return url.toString();
    }

    /**
     * Hand one Host download URL to the browser's own download manager. The
     * anchor is removed immediately; the browser keeps the navigation alive.
     * @param url - same-origin download URL.
     * @param filename - suggested filename, also supplied by Content-Disposition.
     */
    function downloadUrl(url, filename) {
      var anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      anchor.rel = "noopener";
      anchor.style.display = "none";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    }
    //#endregion

    /**
     * Sanitize one listing into display rows: drop rows the host marked
     * absent, coerce the timestamp, and re-assert newest-first order. The host
     * already filters and sorts, so this is the render-side guarantee that a
     * stale or partial payload can never paint a dead row or scramble the
     * order the user was promised.
     * @param rows - decoded listing rows.
     * @returns display-ready rows, newest first.
     */
    function clean(rows) {
      return rows
        .filter(function (row) {
          return row && row.missing !== true;
        })
        .map(function (row) {
          return Number.isFinite(row.time) ? row : { ...row, time: undefined };
        })
        .sort(function (left, right) {
          var a = left.time === undefined ? -Infinity : left.time;
          var b = right.time === undefined ? -Infinity : right.time;
          if (a !== b) return b - a;
          return String(left.name || "").localeCompare(String(right.name || ""));
        });
    }

    //#region listing hook
    /**
     * Read both listings for one Session, once per open, with cancellation.
     * Each route is read independently: one failing section never blanks the
     * other, because they carry different authority (attachments vs workspace).
     * @param sessionId - Session to list.
     * @param open - whether the modal is currently open.
     * @returns section state plus a reload action.
     */
    function useDownloadListing(sessionId, open) {
      var [state, setState] = useState({ phase: "idle", attachments: [], files: [], error: null });
      var [nonce, setNonce] = useState(0);

      useEffect(() => {
        if (!open || sessionId === undefined || sessionId === null) return undefined;
        var controller = new AbortController();
        var live = true;
        setState({ phase: "loading", attachments: [], files: [], error: null });

        /**
         * Read one listing route, degrading to an empty section on failure.
         * @param routePath - route to read.
         * @param field - response array field.
         * @returns the rows, or null when the read failed.
         */
        var read = function (routePath, field) {
          return fetch(listUrlFor(routePath, sessionId), {
            method: "GET",
            signal: controller.signal,
            credentials: "same-origin",
          })
            .then(function (response) {
              if (!response.ok) throw new Error("HTTP " + String(response.status));
              return response.json();
            })
            .then(function (body) {
              return body && Array.isArray(body[field]) ? body[field] : [];
            })
            .catch(function () {
              return null;
            });
        };

        Promise.all([read(DOWNLOAD_PATH, "attachments"), read(WORKSPACE_PATH, "files")])
          .then(function (results) {
            if (!live) return;
            var attachments = results[0];
            var files = results[1];
            if (attachments === null && files === null) {
              setState({ phase: "error", attachments: [], files: [], error: null });
              return;
            }
            setState({
              phase: "ready",
              attachments: clean(attachments ?? []),
              files: clean(files ?? []),
              error: null,
            });
          })
          .catch(function (error) {
            if (!live || controller.signal.aborted) return;
            setState({
              phase: "error",
              attachments: [],
              files: [],
              error: error instanceof Error ? error.message : String(error),
            });
          });

        return function () {
          live = false;
          controller.abort();
        };
      }, [open, sessionId, nonce]);

      var reload = useCallback(function () {
        setNonce(function (value) {
          return value + 1;
        });
      }, []);

      return { state: state, reload: reload };
    }
    //#endregion

    //#region time labels
    /**
     * Absolute creation time in the app's own locale, through the dictionary's
     * date template. `toLocaleString` would follow the browser language rather
     * than the app locale and produce mixed-language text after a switch, so
     * the template is composed by hand — the same pattern `ui-workspace` uses
     * for its hover card.
     * @param time - epoch milliseconds.
     * @param t - bound translator.
     * @returns the formatted stamp.
     */
    function absoluteLabel(time, t) {
      var d = new Date(time);
      var pad2 = function (value) {
        return String(value).padStart(2, "0");
      };
      var ymd = t("date.ymd", { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() });
      return ymd + " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
    }

    /**
     * Compact relative time ("刚刚"/"5分钟" in zh, "now"/"5min" in en), sharing
     * the bucketing every other surface uses.
     * @param time - epoch milliseconds.
     * @param t - bound translator.
     * @returns the relative label.
     */
    function relativeLabel(time, t) {
      var buckets = primitives.relativeTime(time, Date.now());
      var unit = buckets.unit;
      var n = buckets.n;
      return unit === "now" ? t("time.now") : t("time." + unit, { n: n });
    }

    /**
     * The row's timestamp cell: the exact creation time, with the relative
     * distance as its tooltip so a glance reads "when" without arithmetic.
     * @param time - epoch milliseconds, or undefined when the log never stamped it.
     * @param t - bound translator.
     * @returns the timestamp element, or null when no time is known.
     */
    function TimeLabel(props) {
      var time = props.time;
      var t = props.t;
      var stamp = useMemo(
        function () {
          return time === undefined || time === null ? null : absoluteLabel(time, t);
        },
        [time, t],
      );
      var relative = useMemo(
        function () {
          return time === undefined || time === null ? null : relativeLabel(time, t);
        },
        [time, t],
      );
      if (stamp === null) return null;
      return h("span", { className: "adl_time", title: relative, children: stamp });
    }
    //#endregion

    //#region components
    /**
     * One downloadable row: type glyph, name, metadata, timestamp, and a
     * download control.
     * @param props - row data, resolved URL, and localized copy.
     * @returns the list row.
     */
    function DownloadRow(props) {
      var item = props.item;
      var t = props.t;
      var onDownload = useCallback(function () {
        downloadUrl(props.url, item.name);
      }, [props.url, item.name]);
      var meta = [
        primitives.fileExtension(item.name).toUpperCase().slice(0, 8),
        item.bytes > 0 ? primitives.fileSizeText(item.bytes) : "",
        props.kindLabel,
      ]
        .filter(function (part) {
          return part !== "" && part !== undefined && part !== null;
        })
        .join(" · ");
      return hs("li", {
        className: "adl_row",
        children: [
          h("span", { className: "adl_icon", children: h(primitives.FileTypeIcon, { path: item.name, size: 20 }) }),
          hs("span", {
            className: "adl_text",
            children: [
              h("span", { className: "adl_name", title: props.title ?? item.name, children: item.name }),
              h("span", { className: "adl_meta", children: meta }),
            ],
          }),
          h(TimeLabel, { time: item.time, t: t }),
          h(primitives.Button, {
            variant: "outline",
            size: "sm",
            icon: h(primitives.IconDownloadOutline16, {}),
            onClick: onDownload,
            title: t("row.download"),
            "aria-label": t("row.downloadNamed", { name: item.name }),
            children: t("row.download"),
          }),
        ],
      });
    }

    /**
     * Session Header action plus its download modal.
     * @param props - Session identity and localized copy from the slot seat.
     * @returns the header button and the modal portal.
     */
    function AttachmentDownloadAction(props) {
      var sessionId = props.sessionId;
      var t = props.t;
      var [open, setOpen] = useState(false);
      var listing = useDownloadListing(sessionId, open);
      var state = listing.state;

      // Merge both sources into one time-ordered list. Each source is already
      // newest-first from the host, but the merge is redone here so the two
      // streams interleave by their own timestamps rather than by section.
      var rows = useMemo(
        function () {
          var merged = [];
          state.attachments.forEach(function (item, index) {
            merged.push({
              key: "a:" + String(item.attachmentId) + ":" + String(index),
              item: item,
              url: attachmentUrlFor(sessionId, item.attachmentId),
              title: item.name,
              kindLabel: item.kind === "image" ? t("kind.image") : t("kind.file"),
            });
          });
          state.files.forEach(function (item, index) {
            merged.push({
              key: "f:" + String(item.absolutePath || item.path) + ":" + String(index),
              item: item,
              url: workspaceUrlFor(sessionId, item),
              title: item.path,
              kindLabel: item.kind === "presented" ? t("kind.presented") : t("kind.produced"),
            });
          });
          return merged.sort(function (left, right) {
            var a = left.item.time === undefined ? -Infinity : left.item.time;
            var b = right.item.time === undefined ? -Infinity : right.item.time;
            if (a !== b) return b - a;
            return String(left.item.name || "").localeCompare(String(right.item.name || ""));
          });
        },
        [state, sessionId, t],
      );

      var body = useMemo(function () {
        if (state.phase === "loading" || state.phase === "idle") {
          return h("p", { className: "adl_note", children: t("state.loading") });
        }
        if (state.phase === "error") {
          return hs("div", {
            children: [
              h("p", { className: "adl_error", children: t("state.error") }),
              h(primitives.Button, {
                variant: "outline",
                size: "sm",
                icon: h(primitives.IconRefreshOutline14, {}),
                onClick: listing.reload,
                children: t("state.retry"),
              }),
            ],
          });
        }
        if (state.attachments.length === 0 && state.files.length === 0) {
          return h("p", { className: "adl_note", children: t("state.empty") });
        }
        // One merged list, newest first. Two labeled sections would each be
        // internally ordered but the visible order would still be section
        // order, so the oldest attachment could sit above a file written a
        // minute ago. The kind travels on the row instead, as the metadata tag.
        return h("div", {
          className: "adl_body",
          children: h("ul", {
            className: "adl_list",
            children: rows.map(function (row) {
              return h(DownloadRow, {
                key: row.key,
                item: row.item,
                url: row.url,
                title: row.title,
                kindLabel: row.kindLabel,
                t: t,
              });
            }),
          }),
        });
      }, [state, listing.reload, sessionId, t]);

      var busy = state.phase === "loading";
      return hs(react.Fragment, {
        children: [
          h("button", {
            type: "button",
            className: "adl_button",
            "aria-label": t("header.open"),
            "aria-haspopup": "dialog",
            "aria-busy": busy || undefined,
            title: t("header.open"),
            onClick: function () {
              setOpen(true);
            },
            children: h(primitives.IconDownloadOutline16, {}),
          }),
          h(primitives.Modal, {
            open: open,
            onClose: function () {
              setOpen(false);
            },
            title: t("dialog.title"),
            closeLabel: t("dialog.close"),
            description: t("dialog.description"),
            children: body,
            footer: hs(react.Fragment, {
              children: [
                h(primitives.Button, {
                  variant: "outline",
                  icon: h(primitives.IconRefreshOutline14, {}),
                  disabled: busy,
                  onClick: listing.reload,
                  children: t("dialog.refresh"),
                }),
                h(primitives.Button, {
                  variant: "primary",
                  onClick: function () {
                    setOpen(false);
                  },
                  children: t("dialog.close"),
                }),
              ],
            }),
          }),
        ],
      });
    }
    //#endregion

    //#region locale
    /** Locale namespace owned by this plugin's browser feedback. */
    var NS = "attachment-download";

    var zh = {
      "header.open": "下载文件",
      "dialog.title": "下载会话文件",
      "dialog.description": "本会话的附件与本轮产出/交付的文件，点击即可保存到本机。主机没有桌面时也能用。",
      "dialog.refresh": "刷新",
      "dialog.close": "关闭",
      "state.loading": "正在读取文件列表…",
      "state.empty": "本会话暂无可下载的文件。",
      "state.error": "读取文件列表失败。",
      "state.retry": "重试",
      "time.now": "刚刚",
      "time.minutes": "{n}分钟前",
      "time.hours": "{n}小时前",
      "time.days": "{n}天前",
      "time.months": "{n}个月前",
      "time.years": "{n}年前",
      "date.ymd": "{y}-{m}-{d}",
      "kind.image": "图片",
      "kind.file": "文件",
      "kind.presented": "已交付",
      "kind.produced": "本轮改动",
      "row.download": "下载",
      "row.downloadNamed": "下载 {name}",
    };

    var en = {
      "header.open": "Download files",
      "dialog.title": "Download session files",
      "dialog.description": "This Session's attachments plus the files it produced or delivered. Works even when the Host has no desktop.",
      "dialog.refresh": "Refresh",
      "dialog.close": "Close",
      "state.loading": "Reading the file list…",
      "state.empty": "This Session has no downloadable files yet.",
      "state.error": "Could not read the file list.",
      "state.retry": "Retry",
      "time.now": "now",
      "time.minutes": "{n}min ago",
      "time.hours": "{n}h ago",
      "time.days": "{n}d ago",
      "time.months": "{n}mo ago",
      "time.years": "{n}y ago",
      "date.ymd": "{y}-{m}-{d}",
      "kind.image": "image",
      "kind.file": "file",
      "kind.presented": "delivered",
      "kind.produced": "changed",
      "row.download": "Download",
      "row.downloadNamed": "Download {name}",
    };
    //#endregion

    //#region plugin
    /** Cordis services this browser plugin needs. */
    const inject = ["slots", "locale"];

    /**
     * Register the header action once the header declares its utilities seat.
     * `slots.inject` waits for the declaration, so activation order against
     * ui-conversation is not constrained.
     * @param ctx - browser root context carrying slots and locale.
     */
    function apply(ctx) {
      ctx.effect(
        function () {
          return ctx.locale.register(NS, { zh: zh, en: en });
        },
        "attachment-download: dictionaries",
      );
      ctx.slots.inject("conversation.session.header.utilities", function () {
        return ctx.slots.register(
          {
            name: "conversation.session.header.utilities",
            id: "attachment-download",
            order: 20,
            locale: NS,
          },
          AttachmentDownloadAction,
        );
      });
    }
    //#endregion

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
