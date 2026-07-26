# 部署 shard-server

单用户自建同步服务端。数据全部落在一台 VPS 上：SQLite 库 + 内容寻址的附件目录。

## 组成

| 组件 | 作用 |
|---|---|
| `shard-server` | axum 服务，只绑 `127.0.0.1:8787` |
| Caddy | 终止 TLS、反向代理。服务本体不面向公网 |
| Litestream | 把 SQLite 持续复制到对象存储。**唯一的异地备份** |
| restic（可选） | 附件目录的定时快照 |

## 一、构建

在本机交叉编译，或直接在服务器上编译：

```bash
cargo build --release -p shard-server
# 产物：target/release/shard-server
```

服务器上编译需要 Rust 工具链与 `build-essential`。产物是单个静态链接程度较高的
二进制，除 libc 外没有运行时依赖。

## 二、安装

```bash
# 专用系统用户，不给登录 shell
sudo useradd --system --no-create-home --shell /usr/sbin/nologin shard

sudo install -m 755 target/release/shard-server /usr/local/bin/shard-server
sudo install -d -o shard -g shard -m 700 /var/lib/shard
sudo install -d -m 755 /etc/shard

# 令牌：用随机值，不要用能记住的口令
openssl rand -hex 32
sudo install -m 600 -o shard -g shard deploy/shard-server.env.example /etc/shard/server.env
sudo vi /etc/shard/server.env   # 填入上面生成的令牌

sudo install -m 644 deploy/shard-server.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now shard-server
curl -s localhost:8787/healthz   # 期望：ok
```

## 三、TLS

把 `deploy/Caddyfile` 里的域名换成自己的，然后：

```bash
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

验证认证确实生效——**这一步不要跳过**：

```bash
# 无令牌必须 401
curl -s -o /dev/null -w '%{http_code}\n' https://你的域名/v1/sync/changes
# 带令牌应为 200
curl -s -H "Authorization: Bearer $TOKEN" https://你的域名/v1/sync/changes
```

## 四、备份

```bash
sudo cp deploy/litestream.yml /etc/litestream.yml
sudo vi /etc/litestream.yml     # 填 bucket 与 endpoint
sudo systemctl enable --now litestream
```

凭据走 systemd 的环境文件，不要写进 `litestream.yml`。

附件目录单独备份（Litestream 只管 SQLite）：

```bash
restic -r $RESTIC_REPO backup /var/lib/shard/attachments
```

### 恢复演练是交付项，不是文档里的一句话

没演练过的备份等于没有备份。第一次部署完成后立刻做一次，之后每季度一次：

```bash
litestream restore -o /tmp/verify.sqlite3 /var/lib/shard/notes.sqlite3
sqlite3 /tmp/verify.sqlite3 'PRAGMA integrity_check;'
sqlite3 /tmp/verify.sqlite3 'SELECT count(*) FROM fragments WHERE deleted_at IS NULL;'
```

两条结果都合理，才算这份备份是真的。

## 五、客户端配置

Shard 设置里填服务器地址与令牌。客户端会在后台按 outbox 队列推送、按 seq 游标
拉取；离线期间照常读写，联网后自动追平。

## 运维备忘

```bash
journalctl -u shard-server -f          # 看日志
systemctl restart shard-server          # 重启（SIGTERM，在途请求会做完）
sqlite3 /var/lib/shard/notes.sqlite3 'SELECT value FROM sync_seq;'   # 当前序号
```

**日志里不会出现笔记内容**，只有请求路径与耗时。密匣条目在服务端全程是密文，
被拖库也读不到。
