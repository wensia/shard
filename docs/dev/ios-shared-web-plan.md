# iOS 共享网页界面迁移

日期：2026-10-31。分支：`codex/ios-shared-web`，基线 `4a3babd`。

## 目标与边界

- iOS 服务器模式直接复用 `src/main.tsx → App → WorkbenchShell`、共享编辑器、`@shard/markdown` 和 Kiln；不再维护 SwiftUI 内容卡片/Markdown 预览。
- 前端随 App 本地打包，WKWebView 负责显示；Swift 保留 Keychain、URLSession、文件、系统分享、缓存及待发队列。
- Bundle ID、服务器账号、Keychain、`ServerVaults`、`manifest.json` 和 `outbox.json` 原位保留。GitHub 连接与缓存保留兼容入口。
- 不操作真实资料库做测试，不更换数据库或服务器配置。本任务不自动提交、push 或再次生产发布。

## 实施计划

- [x] M1：原生桥协议及本地运行时。固定可信 `shard://app` 主框架，异步请求、取消、事件、文件响应；本地资源读取离开 UI 线程。
- [x] M2：共享 Web 入口与 iOS shell。打包现有完整前端，替换服务器模式 SwiftUI 内容界面；共享登录、导航、编辑器和 Markdown。
- [x] M3：账号与离线连续性。设备 token/Cookie 仅留在原生；成功公共读响应按账号缓存；新建继续进入现有 outbox；实际 401 不降级为离线成功。
- [x] M4：系统能力与移动适配。图片、下载分享、SSE/前后台、键盘与 safe-area；保持现有桌面/浏览器行为。具体行为验收记录见 M5。
- [x] M5：验证。桥接口与安全边界单测、共享 UI/真实临时服务 E2E、独立 iOS 模拟器与真机安装/启动检查，具体范围和结果如下。

## 关键技术决策

- 本地网页请求经公开的 `WKScriptMessageHandlerWithReply` 与原生会话通信，JS 只提交站内 `/api` 路径；服务器 origin 与凭据由原生管理。
- 设备身份与浏览器会话不混用。敏感操作通过用户输入的密码正常建立/确认服务器 Cookie 会话，不能伪造 step-up，也不能同时发送 Bearer 与 Cookie。
- 使用同一份 HTTP/RPC 语义和真实状态码；SSE 保留事件、游标、取消和重连后的整体刷新。
- 离线仅延续既有公共读取、缓存图片与新建碎片能力。未有本地写队列的编辑/勾选/删除等要求联网，不能返回假成功。
- 优先缓存真实的只读 RPC JSON，而不是用丢失关系、属性或密匣信息的 Swift DTO 冒充完整服务器状态；加密密匣快照可缓存，解密结果不可落盘。
- 迁移期间已有 Swift 缓存和待发数据不能因新缓存尚未生成而消失；首次离线迁移需要明确的兼容读取路径。
- 账号切换、退出、重载后丢弃旧页面/旧账号的异步结果；取消旧流和请求。

## 验收标准

1. 同一测试内容在网页与 iOS 主界面使用同一套复选框组件、空行与硬换行规则；字面 `/`、`\\`、路径及代码块不被误删。
2. 在 iOS WebKit 中实际覆盖时间线、标签、资料库、详情与编辑；不以桌面 Chromium 截图代替原生验收。
3. 重启恢复登录；断网后可读缓存、记录新碎片；重启后待发仍在，恢复网络仅补交一次。
4. 错误密码、令牌吊销、退出与账号切换符合现有边界，不泄露上一账号的数据或密匣明文。
5. 拒绝 iframe/外站调桥、任意 origin/请求头注入、路径逃逸与重定向；token、Cookie、密码不进 JS 持久化或日志。
6. `pnpm build`、相关 `pnpm test:ui`/E2E、Swift 测试、iOS 构建及 `git diff --check` 有实际结果。

## 已确认

- 根因：旧列表使用 `Text(Preview.highlighted(...))`，以正则替换复选框并保留未解析 Markdown；详情页虽已用 WebView，列表未共享渲染。
- 独立 iOS 26.5 WKWebView 探针确认 `shard://app` 为 secure context，`crypto.subtle`、`crypto.randomUUID` 可用；没有使用私有 API 或证书绕过。
- 探针同时验证模块 Worker、fetch POST、流式响应、取消和 reply Promise；自定义 scheme 不存 Cookie，认证会话由原生隔离 URLSession 持有。
- `pnpm build`、完整前端 1112 项单测、Swift 53 项测试与 Swift 6 类型检查通过；前端单测使用单 worker，未调整原有性能阈值。
- 真实临时 Rust 服务 + 独立 iOS 26.5 模拟器的首轮 2 项 UI 测试通过：HTML 任务控件、硬换行与字面斜杠、空行几何；断网新建、重启恢复、前台 SSE 联网补交一次、补交后立刻断网重启仍可读。结果：`/tmp/shard-ios-web-workspace-core.xcresult`。
- 1.0（2）签名 Release 已构建并在“潘宇航的 iPhone”覆盖安装、无测试参数启动，设备查询确认版本和进程存活；没有对真实资料库执行测试写入。
- 该版本真机反馈暴露出后台账号列表读取触发密码确认、取消后报失败的问题；真实临时服务器还确认原生密码确认请求缺少 JSON Content-Type，返回 HTTP 415。已修复两处请求头；iOS 设置仅读基本账号，设备与会话管理改为显式验证，取消与卸载后的迟到响应静默处理。
- 修复后新增 6 项浏览器中的原生桥 UI 回归及原有 22 项浏览器认证 UI 回归通过；此前共享编辑器、移动布局、主题、状态及认证的 82 项相关 UI 回归通过。
- 1.0（3）签名 Release 与最新 629 个网页资源逐文件哈希一致，已覆盖安装到同一 iPhone 并无参数启动；设备查询确认 build 3、进程 9081。真实账号内容未用于测试写入。
- 真实 iOS WebKit 的五条独特 E2E 均取得成功记录：HTML 复选框与换行、离线缓存/补交一次、错密码/显隐/Keychain 恢复、账号管理取消重试/令牌吊销/退出重启、资料库编辑/密匣设置与重启解锁。最后一项 78.756 秒通过并正式 `TEST SUCCEEDED`：`/tmp/shard-ios-web-workspace-library-verified.xcresult`。
- 混合轮 `/tmp/shard-ios-web-workspace-final.xcresult` 为 4 通过、1 失败；失败项是新测试对上锁后的导航/提示预期，修正测试后仅补跑该项通过。没有将混合轮或失败后重启的空套件记作整体通过。
- 真机验收边界：签名包安装、版本与启动进程已验证；上面的业务写入/密码测试使用独立模拟器和真实临时 Rust 服务，没有在真实账号中创建测试内容。
