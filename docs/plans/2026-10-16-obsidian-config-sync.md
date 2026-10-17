# 配置文件夹云备份插件（obsidian-config-sync）实施计划

**目标**：写一个 Obsidian 桌面端插件，把 vault 的 `.obsidian` 配置文件夹镜像同步到 Dropbox，并生成带时间戳的 zip 快照；支持定时、文件变更触发、手动按钮；附带防呆还原。

**架构**：插件 = Obsidian 外壳层（main.ts / ui/，唯一允许 import 'obsidian' 的部分）+ 无依赖核心层（scan / dropbox / sync / snapshot / restore，只依赖 `fs`+注入的 HttpClient）。这样核心逻辑可以用 `node --test` 直接跑真实测试，不需要启动 Obsidian。HTTP 走注入的 `HttpClient`：生产用 Obsidian 的 `requestUrl`（绕 CORS），测试用 node http。

**技术栈**：TypeScript（只写可擦除语法，靠 Node 24 原生类型剥离跑测试）+ esbuild 打成 CJS `main.js` + `yazl`/`yauzl` 做 zip。核心层 import 一律带 `.ts` 扩展名（Node 原生 TS 与 esbuild 都接受）。

**关键事实（实测）**
- `.obsidian` 总计 786,622,940 字节 ≈ 750 MiB。
- 目标载荷 ≈ 344 MB = plugins 234M（378M 减去 `插件备份*` 144M）+ snippets 90M + themes 9M + 配置 json 0.2M。
- 排除项：`.git/`(214M)、`icons/`(91M)、`plugins/插件备份*`(144M)。
- Dropbox 账户 `your-account`：配额 18 GiB / 已用 6.39 GiB / 剩 11.61 GiB。
- 本机没装 Dropbox 桌面客户端。用户已确认：插件自己走 OAuth PKCE。
- Dropbox 官方规则：PKCE + refresh token 是桌面端推荐流程；redirect_uri 必须与 App Console 登记值**完全一致**，除 localhost 外必须 HTTPS；code flow 下 redirect_uri **可省略**，此时 Dropbox 直接把 code 显示给用户粘贴 —— 这是零配置的兜底路径。
- 环境：node v24.15.0、npm 11.12.1、Obsidian 1.14.4、7-Zip。

**代码位置**：`/path/to/obsidian-config-sync`（源码仓库）
**部署位置**：`<vault>/.obsidian/plugins/obsidian-config-sync/`（只放 main.js / manifest.json / styles.css）

---

## 阶段划分

### Phase 1（主 agent，已完成）
脚手架、`src/types.ts` 契约、各模块空实现桩、`npm install`、构建与测试两个命令跑通。

### Phase 2（并行子 agent，文件互不重叠）
| Agent | 负责文件 | 自测文件 |
|---|---|---|
| A | `src/http/node.ts` `src/http/obsidian.ts` `src/dropbox/oauth.ts` `src/dropbox/client.ts` | `test/dropbox.test.mjs` |
| B | `src/scan/exclude.ts` `src/scan/scanner.ts` | `test/scan.test.mjs` |
| C | `src/sync/index-store.ts` `src/snapshot/zip.ts` `src/snapshot/manager.ts` `src/sync/engine.ts` | `test/sync.test.mjs` |
| D | `src/watch/watcher.ts` `src/scheduler.ts` `src/ui/status.ts` `src/ui/settings-tab.ts` | `test/watch.test.mjs` |
| E | `src/restore.ts` `README.md` | `test/restore.test.mjs` |

**硬约束**：不许改别人的文件；不许改 `src/types.ts` / `src/config/defaults.ts` 里的既有签名（只能追加，并在返回摘要里说明）；不许加新的 npm 依赖；核心层不许 import 'obsidian'（只有 `src/ui/*` 和 `src/http/obsidian.ts`、`src/main.ts` 可以）。

### Phase 3（主 agent）
写 `src/main.ts` 把全部模块接起来、`tsc --noEmit` 过、全部测试过、用一个模拟 Dropbox 的本地 HTTP server 跑一次端到端同步。

### Phase 4（主 agent）
真 Dropbox 冒烟测试：用独立沙盒目录 `/Obsidian-Config-Backup/_selftest/` 真跑 上传/分块上传/删除/列举/下载/快照轮转，跑完删除沙盒目录。

### Phase 5（主 agent）
`npm run deploy` 拷进插件目录，确认 Obsidian 能加载，写用户指引（在 Dropbox App Console 建 App 的步骤）。

### Phase 6
还原功能联调验证（防呆流程），把本次踩到的坑写进技能。

---

## 用户需要做的一件事
到 https://www.dropbox.com/developers/apps 建一个 App：
- 选 **Scoped access** → **App folder** 或 **Full Dropbox**（推荐 Full Dropbox，因为要写 `/Obsidian-Config-Backup/`）
- Permissions 勾 `files.content.write`、`files.content.read`、`account_info.read`
- Redirect URIs 填 `http://localhost:53682/`（若只用「粘贴授权码」模式可不填）
- 把 **App key** 填进插件设置

---

## 验证标准
1. `npm run build` 无错误输出。
2. `npm test` 全部通过，且测试是真实的（有断言、会失败在错误实现上）。
3. 模拟端到端：300+ 文件、含中文路径、含 >8MB 大文件、含删除场景，镜像结果与本地一致。
4. 真 Dropbox 冒烟：沙盒目录里的文件名/大小/数量与本地一致，快照 zip 可下载且能被 yauzl 打开、条目数正确。
5. 部署后 Obsidian 启动无控制台报错，命令面板出现「配置文件夹云备份」相关命令。
