#!/usr/bin/env bash
# 在 Mac 上构建并发布到 docker 部署的服务器（见 deploy/README.md「docker 部署」）。
#
#   deploy/docker/release.sh build              交叉编译 Linux 服务端 + 构建网页，组装镜像上下文；不碰服务器
#   deploy/docker/release.sh upload <ssh 主机>  上传到 /opt/shard，重建镜像并重启容器，等健康检查通过
#
# 构建要 cargo-zigbuild（brew install cargo-zigbuild）和 x86_64-unknown-linux-gnu 目标（rustup target add）。
# glibc 版本对齐镜像里的 Debian bookworm（2.36）。
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
out="$root/target/shard-release"
target=x86_64-unknown-linux-gnu

build() {
	cd "$root"
	if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
		echo "工作区有未提交的改动：先提交，发布的版本才能对应到一个提交。" >&2
		exit 1
	fi
	cargo zigbuild --release -p shard-server --target "$target.2.36"
	pnpm build
	rm -rf "$out" && mkdir -p "$out/app"
	cp deploy/docker/Dockerfile "$out/app/"
	cp "target/$target/release/shard-server" "$out/app/"
	cp deploy/shard-backup.sh "$out/app/"
	cp -R dist "$out/app/web"
	cp deploy/docker/compose.yml "$out/"
	git rev-parse --short HEAD > "$out/REVISION"
	echo "已组装 ${out}（$(cat "$out/REVISION")）"
}

upload() {
	host=${1:?用法：release.sh upload <ssh 主机>}
	[ -f "$out/REVISION" ] || { echo "先运行 release.sh build" >&2; exit 1; }
	# /opt/shard 归 root：用 sudo rsync 写。.env、data/、backups/、backup-recipients.txt 不在上传范围内。
	rsync -a --delete --rsync-path="sudo rsync" "$out/app/" "$host:/opt/shard/app/"
	rsync -a --rsync-path="sudo rsync" "$out/compose.yml" "$out/REVISION" "$host:/opt/shard/"
	ssh "$host" 'cd /opt/shard && sudo docker compose up -d --build --wait --wait-timeout 120 && sudo docker compose ps'
	echo "已发布 $(cat "$out/REVISION") 到 $host"
}

case "${1:-}" in
build) build ;;
upload) shift && upload "$@" ;;
*)
	echo "用法：release.sh build | release.sh upload <ssh 主机>" >&2
	exit 2
	;;
esac
