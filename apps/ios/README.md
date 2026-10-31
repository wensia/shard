# Shard iOS

浏览 Shard 资料库并快速记录碎片的原生 iOS App（SwiftUI，iOS 17+）。支持用邮箱和密码连接 Shard 服务器，也保留 GitHub 仓库连接。设计与决策见 [docs/dev/ios-app-plan.md](../../docs/dev/ios-app-plan.md)。

## 目录

| 路径 | 内容 |
| --- | --- |
| `project.yml` | XcodeGen 工程定义；`Shard.xcodeproj` 由它生成，不入库 |
| `ShardKit/` | Swift Package：碎片格式、索引、服务器 / GitHub 同步与待发队列，可用 `swift test` 单测 |
| `Shard/` | SwiftUI App |
| `ShardUITests/` | 针对本地模拟服务器 / GitHub 的 UI 测试，每步截图 |
| `renderer/` | 用 Vite 打包 `@shard/markdown`，WKWebView 经 `shard://` 加载 |
| `scripts/` | 工程生成、渲染包构建、本地模拟 GitHub、真机安装 |

## 开发

```sh
pnpm install                              # 仓库根目录，含 renderer workspace
apps/ios/scripts/generate-project.sh      # 构建渲染包并生成 Shard.xcodeproj
open apps/ios/Shard.xcodeproj
```

Xcode 构建前会自动重建过期的渲染包（`scripts/build-renderer.sh`）。

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
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro'
```

Debug 构建支持启动参数 `-debugRepository owner/name@branch -debugToken x -githubAPIBase http://127.0.0.1:18787`，跳过设置页直连模拟服务；`-debugReset YES` 清空本机状态。

账号登录 UI 测试使用独立模拟器和内存夹具，不访问真实资料库：

```sh
python3 apps/ios/scripts/mock-server.py --port 18789
xcodebuild test -project apps/ios/Shard.xcodeproj -scheme Shard \
  -destination 'platform=iOS Simulator,name=Shard Login Tests' \
  -only-testing:ShardUITests/ServerLoginUITests -parallel-testing-enabled NO
```

`-debugServer http://127.0.0.1:18789` 只预填服务器地址，登录仍走真实的登录界面。ShardKit 另有仅允许私有测试端口 `18790` 的真实 Rust 服务互通测试，使用 `SHARD_IOS_TEST_SERVER`、`SHARD_IOS_TEST_EMAIL`、`SHARD_IOS_TEST_PASSWORD` 启用；未设置时自动跳过。

## 连接服务器

首次启动填写服务器地址、邮箱和密码。服务器使用与网页端相同的账号，地址须为 HTTPS（本机回环测试地址允许 HTTP）。密码仅用于换取设备令牌，令牌保存在 iOS 钥匙串；重启后恢复登录，令牌被吊销后返回登录页。

碎片、笔记与图片会同步到隔离的本机缓存，离线记录保存在待发队列中，联网后补交。退出登录不丢弃待发内容，重新登录同一服务器与账号后继续同步；有待发内容时不能直接切换到其他账号或资料库。

## 装到 iPhone

手机用数据线连接并解锁后：

```sh
apps/ios/scripts/install-device.sh
```

需要使用旧资料库时，在登录页选择“使用 GitHub 连接”，填写 vault 仓库（如 `wensia/shard-vault`、分支 `main`）和 GitHub 细粒度令牌；仅授权这一个仓库的 Contents 读写权限。令牌只保存在 iOS 钥匙串。

## 范围

做：时间线、标签、笔记、搜索、详情渲染（与桌面同一套 Markdown 组件）、离线记录与推送。
不做：编辑已有内容、密匣（`lockbox/` 不下载，拦截 `#密匣`）、大纲与流程图的结构化视图、图片上传。
