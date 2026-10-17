# 并行开发须知（所有子 agent 必须先读这个）

项目：`/path/to/obsidian-config-sync` —— Obsidian 桌面端插件，把 vault 的 `.obsidian` 配置文件夹镜像同步 + 快照到 Dropbox。

**动手前请先读**：本文件 → `docs/plans/2026-10-16-obsidian-config-sync.md` → `src/types.ts` → `src/config/defaults.ts` → 你自己负责的桩文件。

## 硬性规则（违反会导致别人的代码编译不过）

1. **只改分配给你的文件**。别人的文件一个字都别碰，哪怕是明显的 bug —— 写进你的返回摘要里说明。
2. **不得修改 `src/types.ts`、`src/config/defaults.ts`、`src/plugin-api.ts`、`src/main.ts` 里已存在的签名/字段名**。只能追加，并在摘要里说明追加了什么。
3. **不许新增 npm 依赖**。可用的运行时依赖只有 `yazl`、`yauzl`（已在 package.json），其余一律用 node 内置模块。
4. **核心层不许 `import ... from "obsidian"`**。允许 import obsidian 的只有：`src/ui/**`、`src/http/obsidian.ts`、`src/main.ts`。原因：核心层要能用 `node --test` 直接跑，测试里没有 obsidian 这个模块。
5. **只写"可擦除"的 TypeScript**。测试是用 Node 24 的原生类型剥离直接跑 `.ts` 源码的，所以以下语法**一律禁止**：
   - 构造函数参数属性 `constructor(private x: T)` → 必须写成显式赋值
   - `enum`（用 `const` 对象 + 联合类型代替）
   - `namespace` / `module`
   - `import x = require(...)`、`export =`
   - 装饰器
6. **所有 import 一律带 `.ts` 扩展名**（`import { x } from "./foo.ts"`）。tsconfig 开了 `allowImportingTsExtensions`，esbuild 也接受。
7. **路径必须跨平台**：用 `node:path` 的 `join`/`relative`/`sep`，不要手写 `\` 或 `/` 拼路径。relPath 对外统一用 `/` 分隔、无前导 `/`。
8. 代码注释和用户可见文案用**简体中文**；标识符用英文。
9. 不要动 `package.json`、`tsconfig.json`、`esbuild.config.mjs`。

## 环境

- Windows 11，`terminal` 工具跑的是 git-bash（POSIX 语法）。给原生程序（node/npm）传路径要用 `C:/...` 正斜杠形式。
- node v24.15.0、npm 11.12.1。
- 临时文件请写进 `$TMPDIR`（Hermes 的 scratch 目录）或项目下的 `test/.tmp/`（自己清理）。

## 必须交付的验证

对每个你实现的功能：

```bash
cd "/path/to/obsidian-config-sync"
node --test --test-reporter=spec test/<你的测试文件>.mjs   # 只跑你自己的，别跑 npm test
npx tsc --noEmit 2>&1 | grep -E "^(src|test)/"              # 只看你自己文件的报错
```

**测试必须是真测试**：有断言、覆盖边界、且在实现写错时会失败。只打印不断言、或断言恒真，一律视为没做。不要为了让测试过而改断言 —— 改实现。

`npx tsc --noEmit` 可能会报别人还没写完的文件 —— 忽略，只看你自己负责的路径。**你自己的文件必须零错误零警告**。

## 返回摘要格式

结束时用中文返回，内容只包含：
1. 你改了/新建了哪些文件（完整相对路径）
2. 每个文件实现了什么（一句话）
3. 你跑过的命令 + 真实输出摘要（测试通过数、tsc 是否干净）
4. 你对契约做的**追加**（如果有）
5. 你发现的、别人文件里的问题（如果你看到了）
6. 还没做完 / 不确定的地方
