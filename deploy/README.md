# 部署 Shard 服务端

服务端是资料库的唯一真相源：一台 VPS 上的 `shard-server`（只监听本机）+ Caddy（TLS 与反代）。
设计见 `docs/dev/server-sqlite-plan.md`。下面每一步都在 VPS 上做，除非特别说明。

> **数据与凭据安全**
> - 登录用邮箱 + 密码（至少 8 位，建议让 iCloud 钥匙串或 1Password 生成并保存）。忘记密码只能 SSH 上服务器生成重置链接（第 9 节）。
> - 备份用 age 加密，**私钥只在你自己手里**（1Password + 纸质）。VPS 上只放公钥：服务器被入侵也解不开备份。
> - 没演练过的备份等于没有备份：Mac 上每周自动演练一次（见第 8 节）。

## 0. 前提

- 一个域名（下面用 `shard.example.com`），A/AAAA 记录指向 VPS。
- VPS：Debian / Ubuntu，开放 22、80、443；SSH 只允许密钥登录。
- 防火墙：`ufw allow OpenSSH && ufw allow 80,443/tcp && ufw enable`。

## docker 部署（和其他服务共用一台机器）

80/443 已经被别的项目的 Caddy 容器占着时（例如 askfish.net 这台），不另装 Caddy，服务端也不走 systemd：
Shard 跑在自己的容器里，加入那个 Caddy 所在的 docker 网络，Caddy 用 `import` 多挂一个站点。端口不映射到宿主，
公网只能经 Caddy 访问。下面第 1～3 节换成本节；第 4 节以后的 `sudo -u shard shard-server …` 换成
`sudo docker exec shard-server shard-server …`，`--data-dir` 写 `/data`。

| 路径（VPS） | 内容 |
|---|---|
| `/opt/shard/compose.yml`、`app/`、`REVISION` | `release.sh upload` 上传，不要手改 |
| `/opt/shard/.env` | 站点地址与 Caddy 所在的 docker 网络（`deploy/docker/env.example`） |
| `/opt/shard/data/` | 三个库，属主 10001（容器里的 shard 用户） |
| `/opt/shard/backups/` | 每小时一份加密快照，保留 48 份 |
| `/opt/shard/backup-recipients.txt` | age 公钥 |

首次部署：

```bash
# VPS 上：目录、站点地址、age 公钥
sudo install -d -m 755 /opt/shard /opt/shard/app
sudo install -d -m 700 -o 10001 -g 10001 /opt/shard/data /opt/shard/backups
sudo tee /opt/shard/.env < deploy/docker/env.example      # 改 SHARD_ORIGIN 与 SHARD_PROXY_DOCKER_NETWORK
echo 'age1…' | sudo tee /opt/shard/backup-recipients.txt

# Mac 上：交叉编译 + 构建网页，上传并启动（以后每次发布也只跑这两步）
brew install cargo-zigbuild && rustup target add x86_64-unknown-linux-gnu
deploy/docker/release.sh build
deploy/docker/release.sh upload <ssh 主机>

# VPS 上：Caddy 站点（以 ai-ditui 的 Caddy 为例：配置目录挂在容器的 /config，Caddyfile 是单文件挂载）
sudo cp deploy/docker/shard.caddy /opt/ai-ditui/caddy/config/shard.caddy         # 改域名
# Caddyfile 先备份，末尾追加一行 import /config/shard.caddy。单文件挂载要原地追加（>>），
# 用 sed -i 之类换了 inode，容器里看到的还是旧文件。
sudo docker exec ai-ditui-web-1 caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo docker exec ai-ditui-web-1 caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
curl -s https://<域名>/healthz                                                     # 应输出 ok

# VPS 上：每小时备份（快照、校验、加密都在容器里做）
sudo cp deploy/docker/shard-backup.service deploy/docker/shard-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now shard-backup.timer
sudo systemctl start shard-backup.service && sudo ls /opt/shard/backups           # 先手动跑一次
```

设置登录用的邮箱和密码：`sudo docker exec shard-server shard-server setup --data-dir /data --origin https://<域名>`，24 小时内打开输出的链接（只能用一次）。
忘记密码：同样的参数改用 `reset-password`（加 `--revoke-all` 同时吊销全部会话与设备令牌）。

**异地副本放在 Mac 上**（不用另开云存储账号）：Mac 每天两次把最新一份加密快照拉到 `~/shard-backups`，
每 7 天顺带做一次恢复演练，失败或服务器超过 6 小时没有新备份时弹通知。

```bash
mkdir -p ~/.config/shard/bin
cp deploy/pull-backups.sh deploy/restore-drill.sh ~/.config/shard/bin/
cargo build --release -p shard-server                                           # 演练用的本机 shard-server
cp target/release/shard-server ~/.config/shard/bin/
~/.config/shard/bin/pull-backups.sh <ssh 主机> ~/.config/shard/backup.key ~/.config/shard/bin/shard-server --drill
cp deploy/dev.shard.pull-backups.plist ~/Library/LaunchAgents/                  # 改里面的路径与 ssh 主机
launchctl load ~/Library/LaunchAgents/dev.shard.pull-backups.plist
```

从备份恢复（对应第 7 节）：

```bash
cd /opt/shard && sudo docker compose stop
sudo rm -f data/shard.db-wal data/shard.db-shm data/blobs.db-wal data/blobs.db-shm
# 把 Mac 上解密出的 shard.db、blobs.db 放进 /opt/shard/data（auth.db 保留现有的），属主改回 10001
sudo chown 10001:10001 data/*.db
sudo docker compose run --rm shard-server verify --data-dir /data
sudo docker compose run --rm shard-server rotate-epoch --data-dir /data
sudo docker compose up -d
```

## 1. 构建

服务端二进制可以直接在 VPS 上编译（不依赖 OpenSSL；docker 部署则在 Mac 上交叉编译，见上一节）：

```bash
apt install -y build-essential git
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

## 4. 设置登录用的邮箱和密码

```bash
sudo -u shard shard-server setup --data-dir /var/lib/shard --origin https://shard.example.com
```

24 小时内用浏览器打开输出的链接（只能用一次），填邮箱和密码（至少 8 位）。Safari 会建议强密码并存进
iCloud 钥匙串，之后 iPhone 与 Mac 都能自动填。之后在「设置 › 账号与安全」里可以改邮箱和密码，
改密码会让其他浏览器退出登录。

服务器对密码错误限流：每个 IP 每分钟 10 次，全站每小时最多 50 次错误，用完后暂停新的登录（已登录的不受影响）。

## 5. 连接桌面应用与命令行

桌面应用在「设置 › 服务器」里填服务器地址、邮箱和密码；命令行运行 `shard login https://shard.example.com`
后按提示输入。它们各自拿到一枚设备令牌（密码不保存），可以在网页设置里单独吊销。

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

`auth.db`（账号、会话、设备令牌）不随内容回滚：否则已吊销的会话和令牌会随旧库复活。
怀疑服务器被入侵时，另外执行 `shard-server reset-password --revoke-all`，吊销全部凭据后重设密码。

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

## 9. 忘记密码

```bash
sudo -u shard shard-server reset-password --data-dir /var/lib/shard --origin https://shard.example.com
# 怀疑密码泄露时加 --revoke-all：同时吊销全部会话与设备令牌（桌面与命令行要重新登录）
```

24 小时内打开输出的链接，重新设置邮箱和密码。设置后全部浏览器会话退出。

## 10. 正式切换：导入现有资料库（只在你确认后做一次）

设计与风险见 `docs/dev/server-sqlite-plan.md` 第 9 节。导入在 Mac 上做（资料库在 Mac 上），全程只读原 vault：

```bash
# 1. 旧版 App 里同步一次 Git、确认没有未提交改动，然后退出 App；停用 iOS 快速记录（切换后它写的内容没人读）。
# 2. 只读复制一份（APFS 克隆，秒完成，不动原件）：
mkdir -p /tmp/shard-import && cp -c -R ~/Documents/ShardVault /tmp/shard-import/vault
# 3. 导入到一个新的数据目录（前置检查不过会拒绝并列出原因：方言、archive/、带 note 标签的碎片、旧大纲）：
shard-server import --data-dir /tmp/shard-import/data --vault /tmp/shard-import/vault
# 4. 往返校验：导出后与原 vault 逐字节比对，只允许排除清单（.git、.DS_Store、.shard/notes.sqlite3* 等）不同：
shard-server export --data-dir /tmp/shard-import/data --out /tmp/shard-import/roundtrip
diff -r /tmp/shard-import/vault /tmp/shard-import/roundtrip
shard-server verify --data-dir /tmp/shard-import/data
```

上传到 VPS（第一次部署时服务还没有内容库；以后重做导入时先停服务）：

```bash
ssh vps 'systemctl stop shard-server'
rsync -a /tmp/shard-import/data/shard.db /tmp/shard-import/data/blobs.db vps:/var/lib/shard/   # auth.db 不动
ssh vps 'chown shard:shard /var/lib/shard/*.db && rm -f /var/lib/shard/shard.db-wal /var/lib/shard/shard.db-shm /var/lib/shard/blobs.db-wal /var/lib/shard/blobs.db-shm && systemctl start shard-server'
```

收尾：

```bash
chflags -R uchg ~/Documents/ShardVault        # 冻结旧 vault：残留的旧版 App / 旧命令行写入会明确报错
shard login https://shard.example.com         # 命令行改连服务器（在终端里由你本人运行）
rm -rf /tmp/shard-import                      # 确认网页与命令行都正常后再删
```

回滚：网页「设置 → 数据与备份 → 导出 zip」解压后用旧版 App 打开；`chflags -R nouchg ~/Documents/ShardVault` 解冻旧 vault。
