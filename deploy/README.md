# 部署 Shard 服务端

服务端是资料库的唯一真相源：一台 VPS 上的 `shard-server`（只监听本机）+ Caddy（TLS 与反代）。
设计见 `docs/dev/server-sqlite-plan.md`。下面每一步都在 VPS 上做，除非特别说明。

> **数据与凭据安全**
> - 通行密钥至少注册两把（例如 iPhone 一把、Mac 一把）。只有一把时，丢了设备就只能 SSH 上服务器走恢复流程。
> - 备份用 age 加密，**私钥只在你自己手里**（1Password + 纸质）。VPS 上只放公钥：服务器被入侵也解不开备份。
> - 没演练过的备份等于没有备份：Mac 上每周自动演练一次（见第 8 节）。

## 0. 前提

- 一个域名（下面用 `shard.example.com`），A/AAAA 记录指向 VPS。
- VPS：Debian / Ubuntu，开放 22、80、443；SSH 只允许密钥登录。
- 防火墙：`ufw allow OpenSSH && ufw allow 80,443/tcp && ufw enable`。

## 1. 构建

服务端二进制在 VPS 上编译最省事（webauthn-rs 依赖 OpenSSL）：

```bash
apt install -y build-essential pkg-config libssl-dev git
curl https://sh.rustup.rs -sSf | sh -s -- -y
git clone <仓库> shard && cd shard
cargo build --release -p shard-server          # 发行版不要加 test-auth 特性
install -m 755 target/release/shard-server /usr/local/bin/shard-server
```

网页在 Mac 上构建后上传（产物是纯静态文件）：

```bash
pnpm install && pnpm build                       # 生成 dist/
rsync -a --delete dist/ vps:/usr/local/share/shard/web/
```

## 2. 用户、目录与服务

```bash
useradd --system --home /var/lib/shard --shell /usr/sbin/nologin shard
install -d -m 700 -o shard -g shard /var/lib/shard /var/backups/shard
install -d -m 755 /etc/shard /usr/local/share/shard/web
cp deploy/server.env.example /etc/shard/server.env      # 改 SHARD_ORIGIN 为你的域名
cp deploy/shard-server.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now shard-server
curl -s http://127.0.0.1:8787/healthz                   # 应输出 ok
```

## 3. Caddy

```bash
apt install -y caddy
cp deploy/Caddyfile /etc/caddy/Caddyfile                # 改域名
caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy
```

日志里的 Cookie、Authorization、Set-Cookie 已在 Caddyfile 里删除，不要去掉这几行。

## 4. 注册第一把通行密钥

```bash
sudo -u shard shard-server setup --data-dir /var/lib/shard --origin https://shard.example.com
```

15 分钟内用手机打开输出的链接，注册通行密钥（iPhone 会存进 iCloud 钥匙串）。登录后在
「设置 › 通行密钥」里再用 Mac 添加第二把。

## 5. 连接桌面应用与命令行

桌面应用与 `shard` 命令行用设备配对：它们会显示一个 8 位配对码，在已登录的浏览器打开
`https://shard.example.com/pair` 输入配对码并验证通行密钥即可。设备可以在设置里单独吊销。

## 6. 备份

```bash
apt install -y age zstd rclone
# 在 Mac 上生成密钥对：age-keygen -o shard-backup.key   （私钥离线保存，绝不放到 VPS）
# 把输出里的公钥（age1…）写到 VPS：
echo 'age1…' > /etc/shard/backup-recipients.txt
# 配置异地存储（S3 / R2 / B2 / SFTP 任选），远端名写进 /etc/shard/server.env 的 SHARD_BACKUP_REMOTE：
sudo -u shard rclone config
install -m 755 deploy/shard-backup.sh /usr/local/bin/shard-backup.sh
cp deploy/shard-backup*.service deploy/shard-backup*.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now shard-backup.timer shard-backup-offsite.timer
sudo -u shard /usr/local/bin/shard-backup.sh --upload   # 先手动跑一次确认能成功
```

- 每小时：一致快照 → 完整性校验 → 压缩 → age 加密，本地保留 48 份。
- 每天 04:20：同样流程并上传到异地，异地保留 90 天。
- 快照用 `VACUUM INTO` 生成，服务运行中也是一致的；**不要直接 cp 数据目录里的 .db 文件**（WAL 模式下会拿到不一致的副本）。

## 7. 从备份恢复

```bash
systemctl stop shard-server
# 在 Mac 上解密（私钥在 Mac 上）：age -d -i shard-backup.key shard-时间.tar.zst.age | zstd -d | tar -xf -
# 先删掉旧库的日志文件，否则旧 WAL 会被回放到新库上：
rm -f /var/lib/shard/shard.db-wal /var/lib/shard/shard.db-shm /var/lib/shard/blobs.db-wal /var/lib/shard/blobs.db-shm
# 再把解出的 shard.db、blobs.db 传到 VPS，替换 /var/lib/shard 下的同名文件（auth.db 保留现有的，不回滚），属主改回 shard
sudo -u shard shard-server verify --data-dir /var/lib/shard
sudo -u shard shard-server rotate-epoch --data-dir /var/lib/shard   # 客户端据此全量对账，找回备份之后写下的内容
systemctl start shard-server
```

`auth.db`（通行密钥、会话、设备令牌）不随内容回滚：否则已吊销的会话和令牌会随旧库复活。
怀疑服务器被入侵时，另外执行 `shard-server recover --revoke-all`，吊销全部凭据后重新注册。

## 8. 恢复演练（每周自动一次，在 Mac 上）

私钥只在 Mac 上，VPS 解不开自己的备份，所以演练在 Mac 上跑。手动跑一次：

```bash
rclone copy <远端>:<最近一份备份> .          # 或从 VPS 的 /var/backups/shard 拷一份
deploy/restore-drill.sh shard-时间.tar.zst.age shard-backup.key target/release/shard-server
```

输出「演练通过」才算备份可用。

每周自动跑：`deploy/restore-drill-latest.sh <rclone 远端> <age 私钥> [shard-server]` 从异地取最新一份做同样的事，
失败或最新备份超过 2 天时弹 macOS 通知。把 `deploy/dev.shard.restore-drill.plist` 复制到 `~/Library/LaunchAgents/`，
改好里面的路径后 `launchctl load` 即可（每周日 10:00）。

## 9. 通行密钥全部丢失

```bash
sudo -u shard shard-server recover --data-dir /var/lib/shard --origin https://shard.example.com
# 怀疑凭据泄露时加 --revoke-all：同时吊销全部通行密钥、会话与设备令牌
```

打开输出的链接注册新的通行密钥。
