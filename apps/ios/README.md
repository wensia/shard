# Shard iOS

iOS 17+ 客户端。服务器模式使用 WKWebView 加载本地打包的完整网页前端，与网页版共用 React 界面、编辑器、Markdown 和 Kiln 样式；Swift 保留凭据、网络、缓存、待发队列和系统分享。旧 GitHub 连接保留兼容入口。迁移计划见 [ios-shared-web-plan.md](../../docs/dev/ios-shared-web-plan.md)。

这是 Shard 的移动客户端，与 **Web、macOS 桌面**共同构成三个应用端。平台关系与发布状态见 [三端说明](../../docs/dev/platforms.md)。当前 GitHub Release 不含 IPA；真机安装需要自己的 Apple 签名配置。

## 目录

| 路径 | 内容 |
| --- | --- |
| `project.yml` | XcodeGen 工程定义；`Shard.xcodeproj` 由它生成，不入库 |
| `ShardKit/` | Swift Package：碎片格式、索引、服务器 / GitHub 同步与待发队列，可用 `swift test` 单测 |
| `Shard/` | SwiftUI 薄壳、WebAppView、原生会话桥与旧 GitHub 兼容界面 |
| `ShardUITests/` | 针对本地模拟服务器 / GitHub 的 UI 测试，每步截图 |
| `renderer/` | 旧 GitHub 详情页的 Markdown 渲染包；服务器模式使用仓库根 `src/main.tsx` |
| `scripts/` | 工程生成、渲染包构建、本地模拟 GitHub、真机安装 |

## 开发

```sh
pnpm install                              # 仓库根目录，含 renderer workspace
apps/ios/scripts/generate-project.sh      # 构建渲染包并生成 Shard.xcodeproj
open apps/ios/Shard.xcodeproj
```

Xcode 构建前会自动重建过期的渲染包（`scripts/build-renderer.sh`）。

`pnpm build:ios-web` 将现有网页入口打包到 `Shard/Resources/WebApp`；旧详情渲染包位于 `Shard/Resources/Renderer`。两者均为生成资源，不入库。服务器模式的列表、详情、复选框与编辑器使用网页组件，不再经过 `Preview.compact` 的 Swift 正则预览。

## 测试

```sh
# 格式核心、索引、同步与队列（macOS 上运行）
cd apps/ios/ShardKit && swift test

# 与 Rust 的跨语言对照样例；改了标签或 frontmatter 规则后加 SHARD_WRITE_IOS_FIXTURES=1 重写
cargo test -p shard-core --test ios_fixtures

# 真实 GitHub 只读同步（令牌只在这条命令的环境变量里）
SHARD_GITHUB_TOKEN=$(gh auth token) swift test --filter LiveGitHub

# UI 测试：先用 vault 的裸克隆起本地模拟 GitHub（端口 18787）
git clone --bare ~/Documents/ShardVault /tmp/vault.git
apps/ios/scripts/mock-github.py /tmp/vault.git &
xcodebuild test -project apps/ios/Shard.xcodeproj -scheme Shard \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -only-testing:ShardUITests/ShardUITests
```

Debug 构建支持启动参数 `-debugRepository owner/name@branch -debugToken x -githubAPIBase http://127.0.0.1:18787`，跳过设置页直连模拟服务；`-debugReset YES` 清空本机状态。

共享网页工作台与账号登录的原生验收使用独立模拟器和真实临时 Rust 服务：

```sh
cargo build -p shard-server
python3 apps/ios/scripts/web-server-fixture.py --server-bin target/debug/shard-server
# 代理 localhost:18792，私有后端 127.0.0.1:18793；数据仅在 TemporaryDirectory。
xcodebuild test -project apps/ios/Shard.xcodeproj -scheme Shard \
  -destination 'platform=iOS Simulator,name=Shard Web Runtime Probe' \
  -only-testing:ShardUITests/WebWorkspaceUITests -parallel-testing-enabled NO
```

测试先核对服务器字段为 `localhost:18792`，再输入假账号。不要把 `-debugReset` 或这些测试用例用于真实手机。

ShardKit 另有仅允许私有测试端口 `18790` 的真实 Rust 服务互通测试，使用 `SHARD_IOS_TEST_SERVER`、`SHARD_IOS_TEST_EMAIL`、`SHARD_IOS_TEST_PASSWORD` 启用；未设置时自动跳过。

## 连接服务器

首次启动填写服务器地址、邮箱和密码。服务器使用与网页端相同的账号，地址须为 HTTPS（本机回环测试地址允许 HTTP）。密码仅用于换取设备令牌，令牌保存在 iOS 钥匙串；重启后恢复登录，令牌被吊销后返回登录页。

碎片、笔记与图片会同步到隔离的本机缓存，离线记录保存在待发队列中，联网后补交。退出登录不丢弃待发内容，重新登录同一服务器与账号后继续同步；有待发内容时不能直接切换到其他账号或资料库。

网页请求通过可信本地页面的异步桥接送到原生。设备令牌和 Cookie 不交给 JavaScript；敏感操作仍以用户输入的密码建立真实服务器会话。各账号使用独立 WKWebsiteDataStore，避免草稿与站点存储交叉。离线保留公开内容读取、缓存图片与新建碎片；其他写操作需要联网。首次升级若尚无完整网页响应缓存又处于离线，保留旧缓存兼容界面，联网后转入共享界面。

## 装到 iPhone

手机用数据线连接并解锁后：

```sh
apps/ios/scripts/install-device.sh
```

需要使用旧资料库时，在登录页选择“使用 GitHub 连接”，填写 vault 仓库（如 `wensia/shard-vault`、分支 `main`）和 GitHub 细粒度令牌；仅授权这一个仓库的 Contents 读写权限。令牌只保存在 iOS 钥匙串。

## 范围

服务器模式复用网页端已有的内容界面与在线操作；原生离线范围见上文。GitHub 兼容模式仍保留原有浏览、搜索、离线新建与推送能力，不会自动导入或删除旧资料库。
