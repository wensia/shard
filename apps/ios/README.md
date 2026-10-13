# Shard iOS

浏览 Shard 资料库并快速记录碎片的原生 iOS App（SwiftUI，iOS 17+）。经 GitHub REST API 同步 vault 仓库，不在手机上运行 git。设计与决策见 [docs/dev/ios-app-plan.md](../../docs/dev/ios-app-plan.md)。

## 目录

| 路径 | 内容 |
| --- | --- |
| `project.yml` | XcodeGen 工程定义；`Shard.xcodeproj` 由它生成，不入库 |
| `ShardKit/` | Swift Package：碎片格式、索引、GitHub 同步与待发队列，可用 `swift test` 单测 |
| `Shard/` | SwiftUI App |
| `ShardUITests/` | 针对本地模拟 GitHub 的 UI 测试，每步截图 |
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

## 装到 iPhone

手机用数据线连接并解锁后：

```sh
apps/ios/scripts/install-device.sh
```

首次打开 App，填写 vault 仓库（如 `wensia/shard-vault`、分支 `main`）和 GitHub 细粒度令牌：只授权这一个仓库，权限给 Contents 读写。令牌只保存在 iOS 钥匙串。

## 范围

做：时间线、标签、笔记、搜索、详情渲染（与桌面同一套 Markdown 组件）、离线记录与推送。
不做：编辑已有内容、密匣（`lockbox/` 不下载，拦截 `#密匣`）、大纲与流程图的结构化视图、图片上传。
