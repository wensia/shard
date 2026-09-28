#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { chmod, copyFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function targetTriple() {
  const configured = process.env.TAURI_ENV_TARGET_TRIPLE?.trim();
  if (configured) {
    return configured;
  }

  const version = execFileSync("rustc", ["-vV"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  const match = version.match(/^host:\s*(\S+)\s*$/m);
  if (!match) {
    throw new Error("无法从 rustc -vV 读取目标三元组");
  }
  return match[1];
}

const triple = targetTriple();

execFileSync(
  "cargo",
  ["build", "--release", "-p", "shard-cli", "--target", triple],
  { cwd: repositoryRoot, stdio: "inherit" },
);

const source = join(repositoryRoot, "target", triple, "release", "shard-cli");
const binariesDirectory = join(repositoryRoot, "src-tauri", "binaries");
const destination = join(binariesDirectory, `shard-cli-${triple}`);

await mkdir(binariesDirectory, { recursive: true });
await copyFile(source, destination);
await chmod(destination, 0o755);

console.log(`已生成 Shard CLI sidecar：${destination}`);
