# 配置文件夹云备份（Dropbox）· obsidian-config-sync

一个 **Obsidian 桌面端插件**：把当前 vault 的 `.obsidian` 配置文件夹（配置、主题、CSS 片段、插件本体）**镜像同步**到 Dropbox，并按需生成**带时间戳的 zip 快照**；附带一个只写不删的**防呆还原**。

想解决的事：换机器 / 重装 Obsidian 之后不用手动重建那一堆配置；以及「昨天还好好的，今天全炸了」的时候能回滚。

> **只支持桌面端**（`isDesktopOnly: true`）。它需要读写磁盘上的 `.obsidian` 目录，移动端做不到。

---

## 目录

- [0. 先读这个：现实约束](#0-先读这个现实约束)
- [1. 它到底备份什么](#1-它到底备份什么)
- [2. 安装](#2-安装)
- [3. 在 Dropbox App Console 建 App（精确步骤）](#3-在-dropbox-app-console-建-app精确步骤)
- [4. 授权连接](#4-授权连接)
- [5. 设置项一览](#5-设置项一览)
- [6. 日常使用](#6-日常使用)
- [7. 还原（防呆版）](#7-还原防呆版)
- [8. 排除规则的写法](#8-排除规则的写法)
- [9. 故障排查](#9-故障排查)
- [10. 数据都在哪](#10-数据都在哪)
- [11. 与 obsidian-git 共存](#11-与-obsidian-git-共存)
- [12. 已知限制与风险（如实写，不美化）](#12-已知限制与风险如实写不美化)
- [13. 开发：构建与测试](#13-开发构建与测试)
- [14. 当前实现状态](#14-当前实现状态)

---

## 0. 先读这个：现实约束

| 约束 | 事实 |
|---|---|
| 云盘 | **只有 Dropbox**。插件通过 Dropbox HTTP API v2 写入，**不需要 Dropbox 桌面客户端**（这台机器本来也没装）。 |
| 授权方式 | **OAuth 2.0 + PKCE（公开客户端）**。**必须你自己去 Dropbox 后台建一个 App**，把它的 **App key** 填进插件设置；插件不需要 App secret。 |
| 账号配额 | Dropbox 账号 `Test User`：总额 **18 GiB**、已用 **6.39 GiB**、可用 **11.61 GiB**（2026-10-16 实测）。 |
| 单次载荷 | 目标配置载荷实测约 **344 MB**（plugins 234M + snippets 90M + themes 9M + 配置 json 0.2M）。 |
| 与 git 备份的关系 | **与已有的 obsidian-git 共存，互不干涉**：插件不读也不改 obsidian-git 的设置或仓库；反过来 obsidian-git 也不知道这个插件的存在。`.git/` 被排除在同步范围外。 |
| 还原功能 | **只提供防呆版**：先预览差异 → 确认弹窗 → 还原前自动留底 zip → 才开始写。默认**只写不删**。 |
| 加密 | **没有端到端加密**。上传到 Dropbox 的就是你的明文配置（含含 API key 的 `data.json`，见第 12 节）。 |

---

## 1. 它到底备份什么

同步**整个 `.obsidian` 目录**，再减去排除规则。默认规则是按实测体积定的：

**同步（白名单角度：默认全部纳入）**

| 内容 | 体积（实测） |
|---|---|
| `plugins/**` 插件本体与设置（不含下面被排除的） | 234 MB |
| `snippets/**` CSS 片段 | 90 MB |
| `themes/**` 主题 | 9 MB |
| `*.json` 配置（`app.json` / `appearance.json` / `core-plugins.json` / `community-plugins.json` / `hotkeys.json` …） | 0.2 MB |

**默认排除**（`DEFAULT_EXCLUDES`，每条都有理由）

| 规则 | 体积 | 为什么排除 |
|---|---|---|
| `.git/` | 214 MB | obsidian-git 的仓库，不属于「配置」；且它自己会备份 |
| `icons/` | 91 MB | 图标缓存/资源，可重新生成 |
| `plugins/插件备份*/`、`plugins/*/插件备份*/` | 144 MB | 用户自己做的旧备份，同步它纯属浪费配额 |
| `workspace.json`、`workspace*.json`、`workspace-mobile.json` | 小 | 会话态，每次开窗都在变，纳入只会制造噪声 |
| `graph.json` | 小 | 同上（图形视图状态） |
| `plugins/focus-time/data/`、`*-time/data.json`、`plugins/update-time-on-edit/data.json`、`plugins/obsidian-git/*.json` | 小 | 高频变动的插件运行时数据，沿用 vault 根 `.gitignore` 的既有约定 |
| `**/.DS_Store`、`**/Thumbs.db`、`**/*.tmp`、`**/*.crswap` | 小 | 系统垃圾文件 |
| `**/.obsidian-safety-snapshots/` | 可变 | 还原前的留底目录（保险起见排掉） |

**插件自己额外排掉**（不写进设置，硬编码在匹配器里）：`sync-index.json`（同步索引，恢复它会造成「索引说已同步、其实没传」的假象）和本插件目录下的 `*.tmp`。

> 想改范围：设置面板里改「包含规则 / 排除规则」两个列表，语法见第 8 节。

---

## 2. 安装

### 2.1 从源码构建（当前唯一方式，插件还没上架社区市场）

```bash
cd "D:/projects/obsidian-config-sync"
npm install          # 只装 devDependencies（typescript / esbuild / obsidian 类型）
npm run build        # tsc --noEmit + esbuild 打包成 main.js
npm run deploy       # 把 main.js / manifest.json / styles.css 拷进插件目录
```

`npm run deploy` 的目标目录（Windows 本机）：

```
C:\Users\User-ZWW\Downloads\MyVault\.obsidian\plugins\obsidian-config-sync\
```

部署目录里只放 `main.js` / `manifest.json` / `styles.css` 三个文件（`npm run deploy` 会替你放好）。

### 2.2 在 Obsidian 里启用

1. Obsidian → 设置 → 第三方插件 → **关闭「受限模式」**（如果还没关）
2. 在「已安装插件」里找到 **配置文件夹云备份 (Dropbox)** → 打开开关
3. 要求 Obsidian **≥ 1.5.0**（`manifest.json` 的 `minAppVersion`）
4. 命令面板（`Ctrl+P`）里应出现这些命令：
   - 立即备份 .obsidian 到 Dropbox
   - 预览差异（不写入任何东西）
   - 立即生成快照 zip
   - 连接 Dropbox（授权） / 断开 Dropbox
   - 还原：预览云端与本地差异 / 还原：从云端拉回 .obsidian（防呆）
   - 打开设置

（侧边栏还有一个云朵图标 = 立即备份。）

---

## 3. 在 Dropbox App Console 建 App（精确步骤）

这是唯一需要你手动做的事，全程约 3 分钟。**顺序别跳**，尤其是第 8 步的 Submit。

1. 用你要备份进去的那个 Dropbox 账号登录 → 打开 **https://www.dropbox.com/developers/apps**
2. 点 **Create app**
3. **Choose an API** → 选 **Scoped access**（不要选 Dropbox Business API）
4. **Choose the type of access you need** → 选 **Full Dropbox**
   - 为什么：插件默认要写 `/Obsidian-Config-Backup/`，这是账号根目录下的自定义目录。
   - 如果你选 **App folder**：Dropbox 只允许该 App 访问 `/Apps/<你的App名称>/`，你必须把插件设置里的 **远端根目录** 改成 `/Apps/<你的App名称>`，否则所有请求都会 409 报错。
5. **Name your app** → 起个全局唯一的名字（例如 `user-zww-obsidian-config-sync`），勾选同意条款
6. 点 **Create app**
7. 进 **Permissions** 标签页，**勾选这 4 个**（少一个就会在运行时报 `does not have the required scope`）：

   | 权限 | 谁需要它 |
   |---|---|
   | `files.metadata.read` | 递归列目录（`files/list_folder` + `/continue`）—— 没有它连远端有什么都不知道 |
   | `files.content.read` | 下载文件（`files/download`）：快照拉取、还原 |
   | `files.content.write` | 上传与覆盖（`files/upload`、`upload_session/*`）、建目录（`create_folder_v2`）、删除（`delete_v2`） |
   | `account_info.read` | `users/get_current_account`、`users/get_space_usage`：设置面板里的「测试连接」与配额显示 |

8. **拉到 Permissions 页面最底部，点 `Submit`** —— 不点 Submit，勾选不生效（这是最常见的坑）。
9. 切回 **Settings** 标签页，复制 **App key**（一串字母数字，例如 `abcd1234efgh5678`）。
   - **App secret 不需要**：插件走 PKCE 公开客户端流程，只带 `client_id` + `code_verifier`，不带 secret。
   - 例外：如果 Dropbox 返回 `missing client_secret`，把 App secret 一并填进插件设置里的「App secret（可选）」即可，插件会带上它。
10. **Redirect URIs（可选，按你选的授权模式二选一）**，在 Settings 页的 **OAuth 2 → Redirect URIs** 处添加：
    - **本地回调模式（默认，推荐）**：填 `http://localhost:53682/` → 点 **Add**。
      - 必须和插件设置里的「回调端口」一致（默认 53682）；换端口就要在这里一起改。
      - Dropbox 要求：除 `localhost` 之外必须 HTTPS；端口要和请求一致；这里填的字符串必须与插件发出的 `redirect_uri` **完全一致**（结尾的 `/` 也算）。
    - **手动粘贴授权码模式**：**什么都不用填**。Dropbox 在 code flow 下允许省略 `redirect_uri`，此时它会把授权码**直接显示在页面上给你复制**（零配置兜底，适合不想开本地端口的情况）。

> 事后又加了权限怎么办？**必须重新授权一次**：Dropbox 不会把新作用域追溯给已有的 access_token / refresh_token。做法：插件里「断开 Dropbox」→ 再「连接 Dropbox（授权）」。

---

## 4. 授权连接

1. 设置面板 → **Dropbox App key** 填第 3 步复制的 App key（可选填 App secret）
2. 选授权模式：
   - **本地回调（callback，默认）**：点「连接 Dropbox」→ 浏览器自动打开 Dropbox 授权页 → 点 **Allow** → 页面显示「授权成功」，回到 Obsidian 即可，插件已抓到授权码。
   - **手动粘贴授权码（manual）**：点「连接 Dropbox」→ 浏览器打开授权页 → 点 **Allow** → 页面会**显示一串授权码**，复制它 → 回到 Obsidian 弹窗里粘贴。
3. 插件拿 `code + code_verifier` 去 `https://api.dropboxapi.com/oauth2/token` 换 token（授权 URL 带 `token_access_type=offline`），拿到：
   - `access_token`（约 4 小时过期，插件会自动刷新）
   - `refresh_token`（长期有效，后台定时同步靠它）
4. 点「测试连接」应显示账号名与邮箱，例如 `已连接 Dropbox：Test User <…>`；设置面板同时会显示配额占用。

凭据存在插件自己的 `data.json` 里（路径见第 10 节）。**注意第 12 节第 4 条**：该文件默认在同步范围内。

---

## 5. 设置项一览

| 设置 | 默认值 | 说明 |
|---|---|---|
| Dropbox App key | 空 | 第 3 步的 App key |
| App secret（可选） | 空 | PKCE 通常不需要；只在 Dropbox 要求 client_secret 时填 |
| 远端根目录 | `/Obsidian-Config-Backup` | 实际写入位置是 `<远端根目录>/<vault名>/…`。用 App folder 类型时必须改成 `/Apps/<App名称>` |
| 回调端口 | `53682` | 本地回调模式监听 127.0.0.1 的端口，必须与 App Console 里 Redirect URI 的端口一致 |
| 授权模式 | `callback` | `callback` = 本地回调；`manual` = 手动粘贴授权码 |
| 包含规则 | 空（= 全部） | 白名单，命中才同步。语法见第 8 节 |
| 排除规则 | 见第 1 节的表 | 黑名单，命中不同步；目录被排除时其子项一并排除 |
| 镜像删除 | 开 | 远端多出来的文件删掉，让远端 = 本地镜像。**第一次跑建议先关掉** |
| 精确比对（hash） | 关 | 开 = 每个文件算 sha256（慢，但变更判定最准）；关 = 用「大小 + 修改时间」 |
| 并发上传数 | 3 | 别调太高，Dropbox 会 429 |
| 单文件大小上限 | 150 MB | 超过就跳过（Dropbox 单次上传上限就是 150 MB；超过的走分块上传，这里指「跳过」阈值） |
| 文件变更时自动同步 | 开 | 监听 `.obsidian` 变化，防抖后自动跑一轮 |
| 变更防抖 | 60 秒 | 单位秒 |
| 定时同步间隔 | 0（关闭） | 单位分钟；0 = 只手动/只在变更与启动时跑 |
| 启动后延迟 | 45 秒 | Obsidian 启动后等 45 秒再跑，避开启动风暴 |
| 快照 | 开 | 生成带时间戳的 zip 并上传到 `<远端根>/<vault>/_snapshots/` |
| 快照模式 | `daily` | `daily` = 每天一份；`every-run` = 每轮同步一份（占配额快） |
| 快照保留份数 | 7 | 只保留最近 N 份，超出的自动删除 |
| 安全留底目录 | 空 | 留空 = `<vault 根>/.obsidian-safety-snapshots`。**建议改到 vault 之外**（见第 12 节第 3 条） |
| 还原时删除本地多出的文件 | 关 | 关闭 = 只把远端缺的文件写回来，本地独有的文件原样保留；打开 = 连本地独有文件一起删（危险，建议保持关闭） |
| 还原前二次确认 | 开 | 关掉后，设置面板里的「开始还原」不再弹确认框；命令面板那条还原命令**始终**会弹确认框（留底 zip 无论如何都会生成） |
| 日志级别 | `info` | `quiet` / `info` / `debug` |

---

## 6. 日常使用

- **手动备份**：命令面板「立即备份 .obsidian 到 Dropbox」，或点侧边栏云朵图标。
- **先看要传什么**：命令面板「预览差异（不写入任何东西）」→ 只算差异，不动远端也不动本地。
- **自动备份**：文件变更触发（防抖 60 秒）+ 可选定时（默认关闭）+ Obsidian 启动 45 秒后。都依赖已授权。
- **快照**：默认每天一份（`daily`），保留最近 7 份，超出自动删。
- **状态栏**：显示最近一次结果摘要（上传 / 删除 / 错误数），出错会变红；设置面板里有实时日志。
- **首次全量**：约 344 MB / 300+ 文件（含 8 MB 分块上传的大文件），第一次上传会跑一段时间，这期间**别关 Obsidian**。之后都是增量。

---

## 7. 还原（防呆版）

设计原则：**还原是危险操作，所以每一步都先摆到你面前，并且默认什么都不删。**

从云端拉回 `.obsidian` 的流程：

1. **预览差异（只读）**
   命令面板「还原：预览云端与本地差异」，或设置面板「还原」一节里的 **预览还原** 按钮。这一步**不下载、不写入、不删除**，只算出一份计划：
   - 要写回的文件（远端有，本地没有 / 大小不同）
   - 本地多出来的文件（远端没有）—— 只列出来，**默认不删**
   - 无变化的文件数
   - 需要下载的总字节数
2. **确认弹窗**
   弹窗里会写明：来源、要写回多少个文件、要下载多少 MB、**这次会不会删本地文件**、留底 zip 会放到哪个目录。**你点取消 = 一个字节都不会改。**
   （设置面板里的「还原前二次确认」关掉后，这条路径不再弹框；命令面板那条还原命令始终会弹。）
3. **自动留底**
   你确认之后，插件先把**当前整个 `.obsidian`**（同步范围内的全部文件）打包成一份带时间戳的 zip 放进留底目录，文件名叫 `obsidian-config-safety-YYYY-MM-DDThh-mm-ss-mmm.zip`。
   **留底不成功就不还原**：zip 创建失败、zip 没真正落盘、留底是空的却还要删文件 —— 这三种情况一律中止，而且此时一个文件都没改。
4. **写入**
   逐个下载写回。单个文件失败（网络抖动等）不会中断整轮，失败的会记进结果与日志。
5. **重启 Obsidian**：配置类文件（主题、插件设置）需要重启才彻底生效。

还原的安全约束（都写在代码里，不是文档口头承诺）：

- 默认**不删**本地独有文件：必须显式打开「还原时删除本地多出的文件」（设置面板，默认关）才会删；命令面板那条「还原：从云端拉回 .obsidian（防呆）」是硬编码不删的。打开删除开关时同样受下面这些约束保护。
- 写入/删除前会再跑一遍同步范围匹配器与路径校验：来源里的 `../`、绝对路径、带盘符的路径**一律拒绝**，绝不写/删到 `.obsidian` 之外。
- 远端 `_snapshots/` 下的快照压缩包**永远不会**被当成配置文件还原回去。
- 预览里远端一个文件都没有、而本地有几百个文件时，计划会带一条警告文字提示你先检查远端目录与授权，别盲目继续。

### 从某一份快照 zip 还原

核心层已实现（下载那份 zip → 按计划白名单解压 → 同样先确认、先留底），并且有测试覆盖；**但当前命令面板里还没接上入口**，只有「镜像还原」可用（见第 14 节）。

---

## 8. 排除规则的写法

gitignore 的一个子集，**不支持 `!` 取反**（要什么就往「包含规则」里加）：

| 写法 | 含义 |
|---|---|
| `*` | 匹配单段内的任意字符（不跨 `/`） |
| `**` | 匹配任意层级（含零层），例如 `**/*.tmp` |
| `?` | 匹配单个字符 |
| 结尾 `/` | 只匹配目录 |
| 不含 `/` 的模式 | 匹配任意层级下的同名条目（例如 `workspace.json`） |
| 含 `/` 的模式 | 从根开始锚定（例如 `plugins/插件备份*`） |

先看「包含规则」（空 = 全通过），命中的再被「排除规则」否决；目录被排除时其子项一并排除。

常用改法：

- 备份体积太怕了？保持默认即可（默认已经把 442 MB 的体积大户排掉了）。
- 想连 `.git` 一起备份（不推荐）：把 `.git/` 从排除规则里删掉，配额会多占 214 MB。
- 不想让 `data.json`（含 Dropbox 凭据）上云：在排除规则里加 `plugins/obsidian-config-sync/data.json`。代价是新机器上要重新填 App key 与重新授权。
- 想只备份「配置 + 主题 + 片段」，不带插件：包含规则填 `*.json`、`themes/**`、`snippets/**`（注意这会改变「远端=本地镜像」的范围，开启镜像删除时要小心）。

---

## 9. 故障排查

| 症状 | 原因 / 处理 |
|---|---|
| `does not have the required scope 'files.metadata.read'`（或其它 scope） | Permissions 页没勾该权限，或勾了**没点 Submit**。补齐后**必须断开再重新授权**（旧 token 不会追溯获得新权限）。 |
| `invalid_request: redirect_uri` / `redirect_uri mismatch` | App Console 里的 Redirect URI 与插件发出的不完全一致（端口、结尾 `/`、http/https）。或者反过来：App Console 填了 URI 却用 manual 模式（不带 `redirect_uri`）——两种模式必须前后一致。 |
| 授权页点完 Allow 后卡住、Obsidian 没有反应 | 回调端口 53682 被别的程序占用，或浏览器没把请求打回 `localhost`。换端口（两处一起改）或改用「手动粘贴授权码」模式。 |
| 连接后同步报 `409 not_found` / 上传失败 | 用了 **App folder** 类型却把远端根目录留在 `/Obsidian-Config-Backup`。改成 `/Apps/<App名称>`。 |
| 401 token 过期 | 正常现象，插件会用 refresh_token 自动刷新。若刷新也失败（`invalid_grant`），说明授权被撤销或权限变了，重新授权。 |
| 429 / 503 | 触发限流。插件会按 Retry-After 指数退避重试；如果频繁出现，把「并发上传数」从 3 降到 1~2。 |
| 远端文件数与本地不一致 | 先跑「预览差异」；确认「排除规则」符合预期（比如 `icons/` 本来就不会上传）。 |
| 配额不足 | 关掉 `every-run` 快照模式、调小「快照保留份数」、清理留底目录里的旧 zip；被覆盖文件的旧版本也会占 Dropbox 配额。 |
| 还原后看起来没变化 | 配置类文件需要重启 Obsidian；另外预览只比较「大小」，同大小不同内容的文件不会被写回（见第 12 节第 1 条）。 |

---

## 10. 数据都在哪

| 东西 | 位置 |
|---|---|
| 插件本体 | `<vault>/.obsidian/plugins/obsidian-config-sync/`（`main.js` / `manifest.json` / `styles.css`） |
| 设置与 Dropbox 凭据 | `<vault>/.obsidian/plugins/obsidian-config-sync/data.json` |
| 同步索引 | `<vault>/.obsidian/plugins/obsidian-config-sync/sync-index.json`（不在同步范围内） |
| 远端镜像 | `<你的远端根目录>/<vault名>/…`（默认 `/Obsidian-Config-Backup/MyVault/…`） |
| 远端快照 | `<上面那个目录>/_snapshots/*.zip` |
| 还原留底 zip | `<vault 根>/.obsidian-safety-snapshots/obsidian-config-safety-*.zip`（可在设置里改到 vault 外） |

---

## 11. 与 obsidian-git 共存

- obsidian-git 和本插件**各干各的**：本插件不读、不写、不修改 obsidian-git 的配置或它的 git 仓库；也不会去 `git commit` 任何东西。
- `.git/` 目录被排除，所以镜像同步不会把 214 MB 的仓库推上去。
- 两个备份会**各自占空间**：git 仓库在本地磁盘，Dropbox 在云端配额。都属于「多点备份」，不是重复劳动。
- 一个提醒：obsidian-git 若也备份 `.obsidian`，那么「插件改配置 → obsidian-git 提交」和「配置变更 → 本插件自动同步」会同时触发。本插件的变更监听有 60 秒防抖，正常不会互相打架，但如果你看到频繁的自动提交，把「文件变更时自动同步」关掉、只用定时或手动。

---

## 12. 已知限制与风险（如实写，不美化）

1. **还原预览只比较「相对路径 + 字节大小」**，不比较内容。
   Dropbox 给的 `content_hash` 不是 SHA-256，无法与本地 sha256 对比；要做到内容级比对就得在预览阶段下载 344 MB，不合理。**后果**：如果某个文件在本地被改动但**大小恰好没变**（例如把某行的 `true` 改成 `false`…），还原会判定它「无变化」而不覆盖它。真要强制回滚这种文件，先手动删掉它再还原。
   同步方向不受影响：同步那边可以开「精确比对（hash）」。
2. **没有端到端加密**。远端就是明文配置。插件自己的 `data.json`（含 `refresh_token`）在 1 节里说了**默认仍在同步范围内**，也就是会被上传到 Dropbox —— 这是为了「换机器连授权一起恢复」的取舍。**不接受的话，把 `plugins/obsidian-config-sync/data.json` 加进排除规则**（代价：新机器要重新授权）。
3. **留底 zip 默认放在 vault 根目录**（`<vault>/.obsidian-safety-snapshots/`），会出现在 Obsidian 的文件列表里，而且**不会自动清理**（每次还原新增一份，每份约 344 MB 的配置内容大小）。两个建议：在设置里把留底目录指到 vault 之外（例如 `D:\projects\obsidian-safety`）；定期手动删除旧 zip。
4. **Dropbox 的版本历史也占配额**。镜像同步会不断覆盖远端文件，旧版本会被 Dropbox 当作历史保留（保留时长按你的套餐规则）。所以长期占用会**高于** 344 MB，不是刚好等于。建议偶尔看一次设置面板里的配额显示。
5. **配额账（最坏情况估算）**：镜像一份 344 MB + 7 份快照 ≈ 8 × 344 MB ≈ **2.7 GB**（zip 压缩后一般更小）。当前可用 11.61 GiB，够用，但别把「快照保留份数」开到很大、也别用 `every-run`。
6. **不做冲突合并**。镜像同步以本地为准覆盖远端；还原以远端为准覆盖本地。没有「两边都改过」的自动合并，也没有多机同时编辑的锁。多台机器同时用，请手动错开时间。
7. **只在 Windows 11 + Obsidian 1.14.4 上验证过**，macOS / Linux 未验证（路径处理走 `node:path`，理论上可移植，但没实测）。
8. **默认只写不删**，删除要手动打开设置面板里的「还原时删除本地多出的文件」（默认关，且命令面板那条还原命令固定不删）。所以本地多出来的文件在还原后通常仍在，需要你自己判断要不要删。
9. **快照是整包**。从快照还原需要先下载整份 zip（约几百 MB），不是按需拉单文件。
10. **首次全量上传耗时较长**（344 MB / 300+ 文件），期间保持 Obsidian 开着、网络稳定。

---

## 13. 开发：构建与测试

```bash
cd "D:/projects/obsidian-config-sync"
npm install
npm run build        # tsc --noEmit && esbuild → main.js
npm run typecheck    # 只做类型检查
npm test             # 先构建，再跑 test/**/*.test.mjs（154 个测试）
npm run test:only    # 同上但不重新构建
npm run test:load    # 只跑「打包产物能否被加载」这一组
npm run deploy       # 拷进 Obsidian 插件目录
```

架构上分成两层，核心层刻意不依赖 `obsidian` 模块，所以能直接用 `node --test` + Node 24 的原生类型剥离跑真实测试：

- 外壳层（唯一允许 `import "obsidian"`）：`src/main.ts`、`src/ui/**`、`src/http/obsidian.ts`
- 核心层（纯 node 内置模块 + 注入的 HTTP 客户端 / zip 实现）：`src/scan/**`、`src/sync/**`、`src/snapshot/**`、`src/restore.ts`、`src/dropbox/**`

运行时依赖只有 `yazl` / `yauzl` 两个 zip 库（打包进 `main.js`），其余全用 node 内置模块。

三档测试，各自把关不同的东西：

| 命令 | 测什么 | 靠什么手段 |
|---|---|---|
| `node --test test/dropbox.test.mjs` 等单模块测试 | 各模块的纯逻辑与边界 | 真实临时文件 + 本地保真 mock 服务 |
| `node --test test/e2e.integration.test.mjs` | **默认注入实现**串起来能不能跑通 | 真实 `DropboxClient` + 真实 `scanDir` + 真实 `yazl/yauzl` + 真实 socket（服务端仍是 mock） |
| `npm run test:load` | 打包产物**在 Obsidian 里加载得起来吗** | 按 CJS 真编译 `main.js`，用 `test/helpers/obsidian-stub.cjs` 顶替 `obsidian`，真跑 `onload` / 设置面板 `display()` / 状态栏点击 / `onunload`，并验证改一个配置文件会走完防抖触发同步 |

> `test:load` 这一档不是形式主义：它抓到过一个单靠 `npm run build` 和单元测试都发现不了的致命 bug —— 早期 `onload()` 里就把同步引擎建好了，而建引擎需要 Dropbox 凭据，结果是**新用户装完插件根本加载不起来**。修法是把引擎改成懒建（`get engine()`）。

`test/e2e.integration.test.mjs` 里的 mock 服务（`test/helpers/mock-dropbox-server.mjs`）刻意比真服务更苛刻：每页只回 3 条强制翻页、校验 `upload_session` 的 `cursor.offset`、`create_folder_v2` 不自动补父目录、`delete_v2` 删不存在路径回 409。它对 `Dropbox-API-Result` 响应头做 `\uXXXX` 转义，跟真实 Dropbox 一致 —— 不做转义的话，中文文件名会让 Node 的 HTTP 层直接抛 `ERR_INVALID_CHAR`。

### 针对真实 Dropbox 的冒烟测试

```bash
DROPBOX_APP_KEY=xxx DROPBOX_REFRESH_TOKEN=yyy NODE_USE_ENV_PROXY=1 \
  node scripts/smoke-dropbox.mjs
```

只打 `/Obsidian-Config-Backup/_selftest-<时间戳>/` 这个沙盒目录，跑完删净，**不碰线上备份路径**。它验证真实服务端语义：token 刷新、中文名上传、9MB 走分块上传会话、递归列举、下载逐字节比对、幂等删除。

`NODE_USE_ENV_PROXY=1` 是必需的：node 的 `node:http` 不读 `http_proxy` / `https_proxy`，所以脚本用的是内置 fetch 版的 HttpClient（`scripts/fetch-http-client.mjs`）。**插件本身没这个问题** —— 它用 Obsidian 的 `requestUrl`，走 Electron 网络栈，自带系统代理。

---

## 14. 当前实现状态

写这份 README 时（2026-10-16，Phase 2 并行开发阶段）的实际情况，避免你按文档去找不存在的按钮：

| 能力 | 状态 |
|---|---|
| 同步核心（扫描 / 排除规则 / 差异计划 / 分块上传 / 镜像删除 / 索引） | 已实现 |
| 快照（打 zip、上传、保留 N 份轮转） | 已实现 |
| Dropbox 客户端与 OAuth PKCE（callback / manual 两种模式） | 已实现 |
| 还原（镜像还原 + 快照还原，含确认、留底、路径防穿越） | 核心层已实现，`test/restore.test.mjs` 23 个用例全绿 |
| 插件装配（命令、ribbon、状态栏、设置面板、还原入口） | 已装配（Phase 3 收尾中：命令面板与设置面板都能触发同步与还原） |
| 真 Dropbox 端到端冒烟（沙盒目录跑一遍上传/下载/删除/轮转） | **还没做**（Phase 4，以主流程的最终报告为准） |
| 部署到 vault 并在 Obsidian 里跑通 | **还没做**（Phase 5） |
| 从快照 zip 还原的**界面入口** | **还没接**（Phase 6 联调）：界面目前只提供「镜像还原」；快照还原的核心逻辑已实现并有测试，但没有按钮调用它 |

因此：**第一次真正使用前，请先跑一遍「预览差异」和一次小范围手动备份**，确认远端目录结构符合预期，再打开自动同步与镜像删除。这份文档里凡是标「已实现」的能力都有对应测试；标「进行中 / 还没做」的，请以实际界面为准，并在跑完 Phase 4/5 后回来更新本节。

---

作者：User-ZWW · 版本 0.1.0 · 仅桌面端
