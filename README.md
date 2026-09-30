# attachment-download

> 给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）用的**网页面板下载插件**：把会话的附件与产出文件，直接在浏览器里存到本机。

dsh 本身已经能把字节发给浏览器，但 UI 里**没有「下载单个文件」这个动作**：

- `ui-attachment` 的文件卡是惰性的（只展示，不可点），图片灯箱走 `blob:`，
  只渲染不落盘。
- `ui-deliverables` 的交付卡只有**宿主桌面**动作（用默认应用打开 / 在文件
  管理器里显示）。无头服务器上 `/api/present.host` 返回
  `{"available":false}`，于是卡片整个「⋯」菜单被禁用
  （`menuDisabled = … || !host.available`），用户只看到
  「此主机没有可用的桌面，无法打开文件或文件夹」——**拿不到文件**。

本插件补上这个缺口：会话头右侧一个按钮，点开是**一份按时间倒序的清单**，
每行一个下载动作。

## 效果

```
对话标题栏                      [⤓ 下载文件]  ← 新增
   ↓ 点开
┌──────────────────────────────────────────────┐
│ 下载会话文件                                  │
│ 本会话的附件与本轮产出/交付的文件…            │
│                                              │
│ 📄 report.md       MD · 18KB · 已交付    15:56 │
│ 📄 deploy.sh       SH · 2.1KB · 本轮改动 15:56 │   ← 最新在上
│ 📄 config.json     JSON · 601B · 已交付  15:49 │
│ 📦 release.tar.gz  GZ · 3.4MB · 已交付   15:15 │
│ 🖼 chart.png        PNG · 40KB · 图片     08:49 │
│                                     [下载]    │
└──────────────────────────────────────────────┘
```

时间精确到分钟，悬停显示相对时间（`34min ago`）。

## 安装

```bash
# 1) 拿到插件目录，放进 profile 的 plugins/ 下
git clone https://github.com/linbeize/dsh-attachment-download \
  ~/.dsh/profiles/web/plugins/attachment-download

# 2) 在 profile 的 cordis.patch.yml 里加一行装载声明
cat >> ~/.dsh/profiles/web/cordis.patch.yml <<'YAML'

- insert:
    - id: attachment-download
      name: ./plugins/attachment-download/index.mjs
YAML

# 3) 重启一次（新增模块路径需要）
systemctl restart dsh-web
```

`patchReload: live`，之后只改已有文件的逻辑：**浏览器半边刷新页面即可**；
**宿主半边（`index.mjs`）改动必须重启**——已 import 的 ESM 模块在进程内被
缓存，改文件不会重新加载。

回退：删掉那几行，或给装载行加 `config: { enabled: false }`。

### 布局要求 — 不要移动这些文件

必须保留独立目录 + 非空 `name`/`version` 的 `package.json`。Host 的
`plugin-package-inventory-deepseek` 会在每次模型请求时解析每个 active entry
的归属 manifest；散放模块会向上落到 dsh 生成的 `profiles/web/package.json`
（没有 `version`），导致每次模型请求 `REQUEST_EXTENSION` 失败。同一份
manifest 也承载 `dsh.client` 声明，浏览器半边由它被扫描到。

## 两条路由

两者都在 Connection 的 exact Fetch 注册表上，因此**鉴权与 Host/Origin 围栏
先由 Connection 施加**——未认证请求根本到不了 handler。

### `GET|HEAD /api/attachment.download`

会话引用的**存储附件**（图片 + 普通文件）。

| 参数 | 含义 |
|---|---|
| `sessionId` | 必填，授权依据 |
| `attachmentId` | 省略 → 返回 JSON 列表 |
| `list=1` | 同上 |
| `kind` | 可选提示，永不覆盖日志记录的引用 |

### `GET|HEAD /api/workspace.file`

会话**工作区文件**（`present` 交付的 + 本轮改动过的）。

| 参数 | 含义 |
|---|---|
| `sessionId` | 必填，提供工作区根 |
| `path` | 目标路径（绝对或相对工作区根） |
| `seq` + `index` | 可选；从该 `deliverables/presented` 事件**反查**路径，忽略调用方传的 `path` |
| `inline=1` | 用 `inline` 而非 `attachment` 处置 |
| `list=1` | 返回 JSON 列表 |

响应带 `content-type`（按记录媒体类型或扩展名）与
`content-disposition: attachment`；非 ASCII 文件名追加 RFC 5987
`filename*=UTF-8''…`，所以中文名不会乱码。

## 授权模型

这是本插件最需要说清的部分，因为它直接决定攻击面。

- **附件**：`attachmentId` 必须被**该会话自己的事件日志**引用。授权规则与上游
  在线图片路由（`referencedImage`）**逐条同构**——在本插件内本地实现，不 import
  另一个包的内部结构。未被引用的 id 返回 404，且**不区分**「存在但未被引用」与
  「不存在」。
- **工作区文件**：解析走 `ctx.workspaceFiles.stat`，也就是 `present` 打开动作
  **同一套**流程（会话 cwd / 部署工作区根为基准、常规文件门、符号链接门、
  规范化路径回环），字节来自 `ctx.fs`。
- **声明门**：`path=` 只有在该路径**被本会话日志声明过**时才放行——作为
  `present` 交付，或作为一次**成功**的 `write`/`edit`/`str_replace_editor`。
  比对在**解析后的绝对路径**上进行，所以 `out/report.html` 与它指向的绝对
  路径是同一个文件，而无关路径永不匹配。

  > 这道门是必需的：没有它，一个合法的 `sessionId` 就能读进程能打开的**任意**
  > 宿主文件（包括 `~/.dsh/.credentials.yaml` 里的密钥）——比 UI 本身授予的
  > 权限宽得多，因为交付卡只会提供会话声明过的路径。

字节读取失败时**关闭**（fail closed）：真实读错误如实报错，而不是静默截断。

## 列表口径

两路来源合并成**一份**清单，**纯按时间倒序**：

- **时间取自事件时间戳**，这是日志里唯一真实记录的时刻：
  - 「已交付」用 `deliverables/presented` 事件的时间；
  - 「本轮改动」用**成功的那次** `tool/result` 的时间（调用发起 ≠ 文件写成，
    失败调用不计入——它真的没产出文件）；
  - 一个文件两处都出现时保留 `presented` 标记，但取**最新**时间戳，所以交付后
    又编辑过不会把它挤下去。
- **已不存在的文件不显示**。判断上有个刻意的不对称：只有**明确**的「不存在」
  才丢行；探测本身失败（后端不支持 host 路径映射、瞬时 IO 错误）**保留**该行
  ——因为「探测不确定」而藏起用户自己的数据是更糟的失败，而真去下载时该失败
  仍会失败。
- **未记录时间的行排最后**，按名字定序，而不是假装它很新。

## 验证

```bash
cd ~/.dsh/profiles/web/plugins/attachment-download

# 纯逻辑 + 路由状态码（无需 dsh 进程、无需网络）
node test/listing.test.mjs
```

23 项检查：两个 fold 的时间戳提升 / 去重 / 倒序 / 脏数据容忍，以及两条路由的
状态码映射（400 / 404 / 200 / HEAD 空体）与**声明门拒绝未声明路径**。

测试本身做过变异验证：故意破坏安全门、去掉排序、把失败调用计入、把
`presented` 降级，各自都会让对应用例 FAIL；恢复后全绿。

## 兼容性

在 `dsh 0.1.5-rc.2` 上开发与验证。用到的都是公开 seam：
`ctx.connection.fetch.register`、`ctx.attachments`（`readImage` /
`readFileStream` / `imageHostPath` / `fileHostPath`）、`ctx.workspaceFiles.stat`、
`ctx.fs`、`ctx.sessionQuery`、`ctx.sessions`，以及槽位
`conversation.session.header.utilities`。上游若改动这些接口，插件需要跟进。

浏览器半边是手写的 loader factory 形式（本插件在 profile 目录里，没有
`tsdown` 构建），只依赖 shell 冻结的平台模块表：`react`、
`react/jsx-runtime`、`@deepseek-ai/dsh-client-ui-primitives`——因此不声明任何
`dsh.client.external` 边，也不会与构建产物漂移。

## License

MIT
