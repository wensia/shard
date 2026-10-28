# Shard 服务端运行镜像。二进制与网页在 Mac 上构建好（deploy/docker/release.sh），这里只装运行时依赖：
# age、zstd 给容器里的备份脚本用，wget 给健康检查用。
FROM debian:bookworm-slim

ARG DEBIAN_APT_MIRROR=http://mirrors.tencentyun.com/debian
RUN sed -i "s|http://deb.debian.org/debian|${DEBIAN_APT_MIRROR}|g" /etc/apt/sources.list.d/debian.sources \
	&& apt-get update \
	&& apt-get install -y --no-install-recommends age zstd wget \
	&& rm -rf /var/lib/apt/lists/* \
	&& groupadd --system --gid 10001 shard \
	&& useradd --system --uid 10001 --gid 10001 --home-dir /data --no-create-home --shell /usr/sbin/nologin shard

COPY shard-server /usr/local/bin/shard-server
COPY shard-backup.sh /usr/local/bin/shard-backup.sh
COPY web /usr/local/share/shard/web

USER shard
ENTRYPOINT ["/usr/local/bin/shard-server"]
