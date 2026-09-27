# H4a：旧格式 md 大纲升级

## 改动文件与要点

- `crates/shard-core/src/outline_import.rs`、`crates/shard-core/src/lib.rs`
  - 新增不依赖 Tauri 的正式旧大纲导入器，列表标记、Tab 四列制表位、根节点与顶层节点挂载规则与前端 `parseMindMapOutline` 对齐，但不再使用 200 节点预览截断。
  - 节点 ID 按 `n0`、`n1` 递增，兄弟排序键使用定宽两位 base62；输出同时满足 Rust 与前端图模型校验。
  - 分类统计被丢弃的非列表行、续行、代码围栏和超长节点文字，每类最多保留 3 条、每条最多 120 字的样例；无损与有损可直接区分。
  - 空内容、空根节点和超过 400 节点返回不可升级错误；超过 2000 个 Unicode 字符的节点文字截为 2000 字并列入损失报告。
  - 新增 14 项单元测试，覆盖所有列表标记、缩进/跳级/顶层挂载、CRLF/CR、损失分类、样例上限、Unicode 截断、200 节点旧上限取消及 400/401 边界。
- `src-tauri/src/lib.rs`
  - 新增异步后台命令 `preflight_outline_upgrade` 与 `run_outline_upgrade` 并注册；预检只读扫描 `fragments/`，不持写门，也不扫描回收站、密匣或资料库。
  - 仅把 type 为 `outline` 且确实缺少 `shardmap` 区域的公开碎片列为候选；已有 JSON 区域或损坏区域保持现状，不进入本批升级。
  - 执行命令拿写门后先建立恢复点：Git 库要求检查点结果为 `committed` / `no_changes`，非 Git 库先按原相对路径逐字节备份到 `.shard/backups/outline-upgrade/`；恢复点失败时不写目标文件。
  - 每篇重新核对完整文件 SHA、类型、区域和导入结果；构造 revision 1 的 `ShardMapFile`，校验并规范化序列化，只更新 frontmatter 的 `updated_at`，再原子替换正文。
  - 成功项最后按路径聚合为一次「升级旧格式大纲」语义提交；Git worktree 的 `.git` 文件形态也按 Git 库处理。
  - 新增 4 项后端集成测试，覆盖预检三种状态、忽略非候选、Git 检查点与可读图、未知 frontmatter/标签保真、陈旧 SHA/blocked 跳过、非 Git 字节备份及检查点阻塞零写入。
- `src/types.ts`、`src/lib/api.ts`
  - 增加预检、损失摘要、选择项和逐篇执行结果的前端合同，并封装两个新 Tauri 命令。
- `src/components/shard/fragment-workspace-controls.tsx`
  - 在既有上下文条区域新增旧大纲数量提示、「查看并升级」和「暂不」。
  - 复用 Kiln 的 `Dialog`、`Button`、`Checkbox` 及语义 token 实现升级对话框；展示无损、有损、无法升级三组，有损项默认禁用，只有勾选「包含有损项」后才加入选择。
  - 执行期设置 `aria-busy` 并锁定关闭，完成后展示成功/跳过/失败、逐篇原因、备份位置或 Git 检查点，以及提交阶段错误。
- `src/workspace/workbench-shell.tsx`
  - 直接从已加载公开碎片识别 `readOutlineContent(...).format === "legacy"`；「暂不」按 vault 路径和当时数量写入 localStorage，数量增加时自动重新出现。
  - 同时渲染升级提示和既有筛选状态条；支持批量入口与单篇预选，执行完成后刷新碎片列表。
  - 单篇升级前先排空当前编辑器；若成功项正被行内、禅模式或搜索编辑器打开，则关闭旧会话，避免旧格式正文被再次写回。
- `src/components/shard/fragment-timeline.tsx`、`src/components/shard/fragment-card.tsx`、`src/components/shard/fragment-editor.tsx`
  - 只透传单篇升级回调；旧格式大纲的行内和禅模式编辑面顶部显示提示与「升级」按钮，原有旧格式编辑和保存路径保持不变。
- `tests/ui/content-types-mock.ts`、`tests/ui/content-types.spec.ts`
  - mock 新增预检与执行命令，成功升级会真实更新内存碎片、完整文件 SHA 和图文件映射。
  - 新增 6 项 UI 测试，覆盖提示/暂不、与筛选条共存、三组与有损开关、结果与列表刷新、行内/禅模式入口及升级后关闭旧编辑器。
- `tests/ui/content-types.spec.ts`、`tests/ui/rich-surfaces.spec.ts`
  - 给施工令点名的高负载偏重用例标记 `test.slow()`；目标用例原本已使用可观察条件，没有可替换的固定等待。
- `docs/dev/content-model-tasks-log/H4a.md`
  - 记录本批实现、基线、验收、偏差与遗留问题。

本批没有新增依赖、CSS、视觉 token 或通用控件，没有改变旧格式大纲升级前的编辑行为，也没有修改 H2–H3 的 JSON 大纲、流程图与搜索合同。

## 开工前 UI 基线

1. 开工前确认使用仓库既有且不纳入提交的 `playwright.worktree.config.ts`；其 Vite 服务、健康检查和 `baseURL` 均为 `http://127.0.0.1:1422`，没有连接 1420。
2. 在任何代码改动前运行 §9.6 指定的 6 个 UI spec，共 69 项，69/69 通过，耗时约 1.5 分钟，没有基线失败或需串行复跑的偶发项。
3. 基线运行改写了 8 个 `tests/evidence` 图片或几何 JSON；最终验收完成后已全部恢复。

## 验收结果

| 命令 | 结果 |
| --- | --- |
| `cargo test -p shard-core -p shard -p shard-cli` | 通过。`shard` 220 通过、4 忽略；`shard-cli` 10 通过；`shard-core` 49 通过；文档测试 0 项。合计 279 通过、4 忽略、0 失败。H4a 新增 Rust 测试 18 项。 |
| `pnpm test:unit` | 符合 §9.6 已知失败边界：全套 630 通过、1 失败，共 631 项。唯一失败仍是 `roundtrip.test.ts` 的 golden 目录检查，当前只发现 1 组而断言至少 22 组；`quick-open-perf.test.ts` 2/2 通过，其中「参考结果对照」逐项通过。 |
| `pnpm build` | 通过。Markdown 构建、215 个 token 契约、101 个 UI 控件静态契约、TypeScript 与 Vite 2915 个模块构建全部通过；只有既有 Rollup 注释、动态/静态导入和大 chunk 警告。 |
| `pnpm build:markdown && pnpm exec playwright test -c playwright.worktree.config.ts ...` | 通过。最终 6 个 spec 在 1422 上 75/75 通过，耗时约 1.7 分钟；相对 69/69 基线新增 6 项且没有新增失败。另用 `--workers=1 --retries=0` 定向运行 `content-types.spec.ts`，26/26 通过。 |
| `rustfmt --edition 2021 --check crates/shard-core/src/frontmatter.rs crates/shard-core/src/graph_region.rs crates/shard-core/src/outline_import.rs` | 通过。 |
| `git diff --check` | 通过。 |

Playwright 改写的 8 个 `tests/evidence` 文件已恢复；`playwright.worktree.config.ts` 保持开工前的未跟踪状态，没有纳入交付改动。

## 偏差及原因

1. `src/workspace/fragments-workspace.tsx` 的 `filterContext` 源码已经是 `ReactNode`，可直接组合升级提示和筛选条，因此没有为施工令描述的插槽另改接口或复制布局。
2. AGENTS.md 引用的 `docs/design/frontend.md` 在当前 worktree 中不存在。本批没有补造该文件，UI 按 `vendor/kiln` 规范和仓库现有 pointer-first 行为实现，未新增视觉规则。
3. 施工令要求对超过 2000 字的节点报告损失，同时 `validate_mind_map_file` 明确拒绝超过 2000 字的节点。为让被明确接受的有损升级能通过既有模型校验，导入器截到 2000 个 Unicode 字符并标记为 `truncatedNodeText`，不把整篇额外判为 blocked。
4. 施工令返回合同没有单列预检 blocked 原因与升级后语义提交失败。源码中两者都需要向 UI 提供真实结果，因此最小增加了预检 `reason` 和执行结果 `commitError`；前者用于「无法升级」组，后者避免已经原子写入的成功项被错误报告为未升级。
5. 批量执行命令一次返回整批结果，没有流式逐篇进度合同。对话框执行期显示「正在升级 N 篇」的可观察忙碌状态与 `aria-busy`，没有为进度条扩大 IPC 或后端事件范围。
6. §9.4 点名的 JSON 大纲、流程图禅模式和冲突用例源码中已经没有固定时长等待，断言均基于调用记录、状态文字或元素出现/消失；本批只按要求增加 `test.slow()`。`rich-surfaces.spec.ts` 中仍有一个 1500ms 等待属于未被点名的「打开不规范碎片不触发保存」负向节拍测试，未越界改动。
7. `docs/dev/content-model-tasks-log/H4a.md` 受仓库现有 `docs/dev/*` 忽略规则影响，不会出现在普通 `git status` 中；仍按施工令创建并直接读取核对，没有 stage、commit 或修改 `.gitignore`。

## 遗留问题

- `pnpm test:unit` 仍有 1 项既有、稳定失败：Markdown golden 夹具当前只发现 1 组，断言要求至少 22 组。本批未扩大为夹具补录或测试规则修改。
- 多个/未闭合/非法 JSON 的受管区域按施工令不属于 H4a，继续保持现状，不进入旧格式升级列表。
- H4b、H4c 及其它后续批次均未实施。
- 未执行 Git commit、push、合并或部署。
