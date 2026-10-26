//! FsVfs、SqliteVfs 与 MemVfs 的行为一致性：同一串随机操作在三边逐步执行，
//! 每一步的成败、读出的内容、目录列表都要相同，最后整棵树（路径、类型、内容哈希）也要相同。
//! SqliteVfs 侧每个操作是一个独立的写事务，顺带走一遍提交流水线；MemVfs（shard-core）是纯内存目录树。

use std::{
    collections::BTreeMap,
    io,
    path::{Path, PathBuf},
};

use rand::{rngs::StdRng, Rng, SeedableRng};
use shard_store::{sha256_hex, FsVfs, Store, StoreError, Vfs, WriteCtx};
use shard_core::MemVfs;

const DIRS: &[&str] = &["a", "a/b", "c", "notes", "notes/读书"];
const NAMES: &[&str] = &["x.md", "y.txt", "图.png", "b"];

#[derive(Clone, Debug)]
enum Op {
    Write(String, Vec<u8>),
    WriteAtomic(String, Vec<u8>),
    CreateDir(String),
    CreateDirAll(String),
    RemoveFile(String),
    RemoveDir(String),
    RemoveDirAll(String),
    Rename(String, String),
    Copy(String, String),
    Read(String),
    ReadDir(String),
    Stat(String),
}

fn random_path(rng: &mut StdRng) -> String {
    match rng.gen_range(0..3) {
        0 => DIRS[rng.gen_range(0..DIRS.len())].to_string(),
        _ => {
            let dir = if rng.gen_bool(0.2) { "" } else { DIRS[rng.gen_range(0..DIRS.len())] };
            let name = NAMES[rng.gen_range(0..NAMES.len())];
            if dir.is_empty() {
                name.to_string()
            } else {
                format!("{dir}/{name}")
            }
        }
    }
}

fn random_bytes(rng: &mut StdRng) -> Vec<u8> {
    let options: [&[u8]; 4] = [b"", "正文".as_bytes(), b"---\nid: x\n---\n", b"\x89PNG\r\n\x1a\n"];
    options[rng.gen_range(0..options.len())].to_vec()
}

fn random_op(rng: &mut StdRng) -> Op {
    match rng.gen_range(0..12) {
        0 => Op::Write(random_path(rng), random_bytes(rng)),
        1 => Op::WriteAtomic(random_path(rng), random_bytes(rng)),
        2 => Op::CreateDir(random_path(rng)),
        3 => Op::CreateDirAll(random_path(rng)),
        4 => Op::RemoveFile(random_path(rng)),
        5 => Op::RemoveDir(random_path(rng)),
        6 => Op::RemoveDirAll(random_path(rng)),
        7 => Op::Rename(random_path(rng), random_path(rng)),
        8 => {
            // 复制到自身：macOS 上 `fs::copy(a, a)` 会先截断目标、把文件清空，是本地文件系统的坑，
            // SqliteVfs 不照搬（文档已列为已知差异），这里不生成。
            let from = random_path(rng);
            let mut to = random_path(rng);
            while to == from {
                to = random_path(rng);
            }
            Op::Copy(from, to)
        }
        9 => Op::Read(random_path(rng)),
        10 => Op::ReadDir(random_path(rng)),
        _ => Op::Stat(random_path(rng)),
    }
}

/// 一步操作的可比较结果：成败 + 读出来的东西。
#[derive(Debug, PartialEq, Eq)]
enum Outcome {
    Ok,
    Bytes(Vec<u8>),
    Names(Vec<String>),
    Stat(Option<(bool, u64)>),
    Err,
}

fn run(vfs: &dyn Vfs, op: &Op) -> Outcome {
    let root = vfs.root().to_path_buf();
    let p = |rel: &str| root.join(rel);
    let done = |result: io::Result<()>| if result.is_ok() { Outcome::Ok } else { Outcome::Err };
    match op {
        Op::Write(path, bytes) => done(vfs.write(&p(path), bytes)),
        Op::WriteAtomic(path, bytes) => done(vfs.write_atomic(&p(path), bytes)),
        Op::CreateDir(path) => done(vfs.create_dir(&p(path))),
        Op::CreateDirAll(path) => done(vfs.create_dir_all(&p(path))),
        Op::RemoveFile(path) => done(vfs.remove_file(&p(path))),
        Op::RemoveDir(path) => done(vfs.remove_dir(&p(path))),
        Op::RemoveDirAll(path) => done(vfs.remove_dir_all(&p(path))),
        Op::Rename(from, to) => done(vfs.rename(&p(from), &p(to))),
        Op::Copy(from, to) => done(vfs.copy(&p(from), &p(to)).map(|_| ())),
        Op::Read(path) => vfs.read(&p(path)).map(Outcome::Bytes).unwrap_or(Outcome::Err),
        Op::ReadDir(path) => match vfs.read_dir(&p(path)) {
            Ok(entries) => {
                let mut names = entries
                    .iter()
                    .map(|entry| entry.file_name().to_string_lossy().into_owned())
                    .collect::<Vec<_>>();
                names.sort();
                Outcome::Names(names)
            }
            Err(_) => Outcome::Err,
        },
        Op::Stat(path) => Outcome::Stat(
            // 目录的字节数在本地文件系统上没有意义，只比较文件长度。
            vfs.metadata(&p(path))
                .ok()
                .map(|metadata| (metadata.is_dir(), if metadata.is_dir() { 0 } else { metadata.len() })),
        ),
    }
}

fn is_write(op: &Op) -> bool {
    !matches!(op, Op::Read(_) | Op::ReadDir(_) | Op::Stat(_))
}

/// 整棵树：相对路径 → (是否目录, 内容哈希)。
fn snapshot(vfs: &dyn Vfs) -> BTreeMap<String, (bool, Option<String>)> {
    fn walk(vfs: &dyn Vfs, dir: &Path, root: &Path, out: &mut BTreeMap<String, (bool, Option<String>)>) {
        for entry in vfs.read_dir(dir).expect("目录可读") {
            let path = entry.path();
            let rel = path.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
            if entry.file_type().unwrap().is_dir() {
                out.insert(rel, (true, None));
                walk(vfs, &path, root, out);
            } else {
                let sha = sha256_hex(&vfs.read(&path).expect("文件可读"));
                out.insert(rel, (false, Some(sha)));
            }
        }
    }
    let mut out = BTreeMap::new();
    let root = vfs.root().to_path_buf();
    walk(vfs, &root, &root, &mut out);
    out
}

fn run_sqlite(store: &Store, op: &Op) -> Outcome {
    if is_write(op) {
        let ctx = WriteCtx::new("conformance", "test");
        let result: Result<(Outcome, _), StoreError> = store.write(&ctx, |vfs| {
            let outcome = run(vfs, op);
            if outcome == Outcome::Err {
                // 让事务回滚，与「本地失败的操作没有副作用」对齐。
                Err(StoreError::Invalid("操作失败".to_string()))
            } else {
                Ok(outcome)
            }
        });
        result.map(|(outcome, _)| outcome).unwrap_or(Outcome::Err)
    } else {
        store.read(|vfs| run(vfs, op)).expect("只读事务")
    }
}

#[test]
fn random_operation_sequences_match_the_local_file_system() {
    for seed in 0..60u64 {
        let fs_dir = tempfile::tempdir().unwrap();
        let db_dir = tempfile::tempdir().unwrap();
        let fs_vfs = FsVfs::new(fs_dir.path().to_path_buf());
        let store = Store::open_with_root(db_dir.path(), Path::new("/vault")).unwrap();
        let mem_vfs = MemVfs::new("/vault");
        let mut rng = StdRng::seed_from_u64(seed);
        let mut history = Vec::new();
        for _ in 0..160 {
            let op = random_op(&mut rng);
            history.push(op.clone());
            let local = run(&fs_vfs, &op);
            let remote = run_sqlite(&store, &op);
            assert_eq!(local, remote, "seed {seed}：第 {} 步 {op:?} 结果不同\n历史：{history:#?}", history.len());
            let memory = run(&mem_vfs, &op);
            assert_eq!(local, memory, "seed {seed}：第 {} 步 {op:?} MemVfs 结果不同\n历史：{history:#?}", history.len());
        }
        let local_tree = snapshot(&fs_vfs);
        let remote_tree = store.read(|vfs| snapshot(vfs)).unwrap();
        assert_eq!(local_tree, remote_tree, "seed {seed}：最终目录树不同");
        assert_eq!(local_tree, snapshot(&mem_vfs), "seed {seed}：MemVfs 最终目录树不同");
    }
}

#[test]
fn paths_outside_the_vault_and_lockbox_paths_are_rejected() {
    let db_dir = tempfile::tempdir().unwrap();
    let store = Store::open_with_root(db_dir.path(), Path::new("/vault")).unwrap();
    let result: Result<((), _), StoreError> = store.write(&WriteCtx::new("t", "test"), |vfs| {
        assert!(vfs.write(Path::new("/elsewhere/x.md"), b"x").is_err());
        assert!(vfs.write(&PathBuf::from("/vault/../etc/passwd"), b"x").is_err());
        assert!(vfs.create_dir_all(Path::new("/vault/lockbox/fragments")).is_err());
        assert!(vfs.create_dir_all(Path::new("/vault/LockBox")).is_err());
        Ok(())
    });
    result.unwrap();
}
