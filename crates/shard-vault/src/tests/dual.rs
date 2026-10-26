//! 双实现测试：同一组领域场景在「本地目录 FsVfs + NoHooks」与「服务端内容库 SqliteVfs + NoHooks」上
//! 各跑一遍，比对两边的返回值与最终目录树。
//!
//! - 准备数据一律经 Vfs 写入（SqliteVfs 侧每次写入是一个写事务），不用 `std::fs` 直写。
//! - SqliteVfs 侧每个领域调用是一个写事务；领域函数返回 `Err` 时照样提交，与本地目录上
//!   「出错前写下的文件留在盘上」一致（例如导图冲突副本：先写副本再报错）。
//! - 两次运行的时钟不同，比对前做归一化（见 [`Norm`]）。这些归一化抹掉的是「运行时刻」，
//!   不是两种实现的差异；两种实现之间的已知差异在用到的地方单独注释。

use super::*;
use serde_json::{json, Value};
use shard_store::{SqliteVfs, Store, StoreError, WriteCtx};
use std::cell::RefCell;

const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR-dual-test";

enum Backend {
    Fs,
    Sqlite(Box<Store>),
}

struct Harness {
    backend: Backend,
    root: PathBuf,
    _dir: tempfile::TempDir,
    hooks: NoHooks,
    norm: Norm,
}

impl Harness {
    fn fs() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let harness = Self { backend: Backend::Fs, root, _dir: dir, hooks: NoHooks, norm: Norm::default() };
        harness.write(|cx| ensure_vault_layout(cx.vfs)).unwrap();
        harness
    }

    fn sqlite() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let root = store.root().to_path_buf();
        let harness =
            Self { backend: Backend::Sqlite(Box::new(store)), root, _dir: dir, hooks: NoHooks, norm: Norm::default() };
        harness.write(|cx| ensure_vault_layout(cx.vfs)).unwrap();
        harness
    }

    fn name(&self) -> &'static str {
        match self.backend {
            Backend::Fs => "FsVfs",
            Backend::Sqlite(_) => "SqliteVfs",
        }
    }

    fn path(&self, rel: &str) -> PathBuf {
        self.root.join(rel)
    }

    /// 一次写操作。SqliteVfs 侧是一个写事务，闭包的结果原样带出（领域错误不回滚）。
    fn write<R>(&self, f: impl FnOnce(&VaultCtx<'_>) -> R) -> R {
        match &self.backend {
            Backend::Fs => {
                let vfs = FsVfs::new(&self.root);
                f(&VaultCtx { vfs: &vfs, hooks: &self.hooks })
            }
            Backend::Sqlite(store) => {
                store
                    .write(&WriteCtx::new("dual-test", "test"), |vfs| {
                        Ok::<_, StoreError>(f(&VaultCtx { vfs, hooks: &self.hooks }))
                    })
                    .unwrap()
                    .0
            }
        }
    }

    /// 只读操作：SqliteVfs 侧是只读快照，任何写入都会失败——顺带证明这些领域函数不写盘。
    fn read<R>(&self, f: impl FnOnce(&VaultCtx<'_>) -> R) -> R {
        match &self.backend {
            Backend::Fs => {
                let vfs = FsVfs::new(&self.root);
                f(&VaultCtx { vfs: &vfs, hooks: &self.hooks })
            }
            Backend::Sqlite(store) => {
                store.read(|vfs| f(&VaultCtx { vfs, hooks: &self.hooks })).unwrap()
            }
        }
    }

    /// 经 Vfs 准备一个文件（自动建父目录）。
    fn put(&self, rel: &str, bytes: &[u8]) {
        let path = self.path(rel);
        self.write(|cx| cx.vfs.write_atomic(&path, bytes)).unwrap();
    }

    fn put_text(&self, rel: &str, text: &str) {
        self.put(rel, text.as_bytes());
    }

    /// 准备一条密匣信封（只有 id 与密文，不解密）。本地目录写进 `lockbox/fragments/`；
    /// 内容库拒绝一切 `lockbox/` 路径，信封只能进 `lockbox_items` 表。
    fn put_lockbox_envelope(&self, id: &str) {
        let envelope = json!({"version": 1, "id": id, "nonce": "bm9uY2U=", "ciphertext": "Y2lwaGVy"}).to_string();
        match &self.backend {
            Backend::Fs => self.put_text(&format!("lockbox/fragments/2026/01/{id}.shard"), &envelope),
            Backend::Sqlite(store) => {
                store
                    .write(&WriteCtx::new("dual-test", "test"), |vfs: &SqliteVfs<'_>| {
                        vfs.put_lockbox_item_raw(&shard_store::LockboxItemRaw {
                            item_id: id.to_string(),
                            envelope: envelope.clone(),
                            legacy_path: None,
                            created_at: "2026-01-01T00:00:00Z".to_string(),
                            updated_at: "2026-01-01T00:00:00Z".to_string(),
                        })
                        .map_err(StoreError::from)
                    })
                    .unwrap();
            }
        }
    }

    /// 最终目录树：相对路径 → 目录或（归一化后的）文件内容。经 Vfs 遍历，两边同一套代码。
    fn tree(&self) -> BTreeMap<String, String> {
        fn walk(vfs: &dyn Vfs, dir: &Path, root: &Path, out: &mut Vec<(String, Option<Vec<u8>>)>) {
            for entry in vfs.read_dir(dir).unwrap() {
                let path = entry.path();
                let rel = path.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
                let kind = entry.file_type().unwrap();
                if kind.is_dir() {
                    out.push((rel, None));
                    walk(vfs, &path, root, out);
                } else {
                    out.push((rel, Some(vfs.read(&path).unwrap())));
                }
            }
        }
        let entries = self.read(|cx| {
            let mut out = Vec::new();
            walk(cx.vfs, cx.root(), cx.root(), &mut out);
            out
        });
        entries
            .into_iter()
            // 已知差异：本地目录的密匣信封在 `lockbox/` 下，内容库把信封存在 `lockbox_items` 表里，
            // 目录树里没有 `lockbox/`。两边看到的密匣 id 由 `lockbox_item_ids` 的断言另行覆盖。
            .filter(|(rel, _)| rel != "lockbox" && !rel.starts_with("lockbox/"))
            .map(|(rel, content)| {
                let value = match content {
                    None => "<dir>".to_string(),
                    Some(bytes) => match String::from_utf8(bytes) {
                        Ok(text) => self.norm.text(&text),
                        Err(error) => format!("<binary {}>", hash_bytes(error.as_bytes())),
                    },
                };
                (self.norm.text(&rel), value)
            })
            .collect()
    }

    /// `fileSha` 必须等于存储给出的 `Vfs::content_sha`（SqliteVfs 读的是 sha 列，不读内容），
    /// 由此确认两种实现里的哈希都与原文一致。
    fn assert_file_sha(&self, fragment: &Fragment) {
        let path = self.path(&fragment.path);
        let sha = self.read(|cx| cx.vfs.content_sha(&path)).unwrap();
        assert_eq!(fragment.file_sha, sha, "{}：{} 的 fileSha 与存储里的 sha 不一致", self.name(), fragment.path);
    }

    fn alias(&self, dynamic: &str, label: &str) {
        self.norm.aliases.borrow_mut().push((dynamic.to_string(), format!("<{label}>")));
    }

    /// 新建导图的 id、节点 id、链接 id 都带随机后缀：逐个登记。
    fn alias_map(&self, file: &ShardMapFile) {
        self.alias(&file.id, "map");
        for (index, node) in file.nodes.values().enumerate() {
            let label = if node.id == file.root_id { "map-root".to_string() } else { format!("map-node-{index}") };
            self.alias(&node.id, &label);
            for link in &node.links {
                if let ShardDocumentLink::Fragment { id, .. } = link {
                    self.alias(id, &format!("{label}-link"));
                }
            }
        }
    }
}

/// 把运行时刻抹平：
/// - 登记过的动态值（新生成的碎片 id、导图 id 等）换成占位符；
/// - RFC 3339 时间换成 `<time>`，`YYYYMMDD-HHMMSS[-mmm]` 时间戳换成 `<stamp>`；
/// - JSON 里 `fileSha` / `lastSavedHash` 换成 `<sha>`：它们是整份原文的哈希，原文含本次运行写入的
///   `updatedAt`；正确性另由 [`Harness::assert_file_sha`] 与目录树的原文比对覆盖；
/// - 文本文档（markdown / 导图 / 流程图 / 画布）条目的 `size` 换成 `<size>`：chrono 的
///   `to_rfc3339` 小数位数随时刻变化（3 或 6 位），原文长度因此不定。
#[derive(Default)]
struct Norm {
    aliases: RefCell<Vec<(String, String)>>,
}

impl Norm {
    fn text(&self, input: &str) -> String {
        let mut text = input.to_string();
        let mut aliases = self.aliases.borrow().clone();
        aliases.sort_by(|left, right| right.0.len().cmp(&left.0.len()));
        for (dynamic, label) in aliases {
            text = text.replace(&dynamic, &label);
        }
        known_io_error_text(&replace_compact_stamps(&replace_rfc3339(&text)))
    }

    fn json(&self, value: Value) -> Value {
        match value {
            Value::String(text) => Value::String(self.text(&text)),
            Value::Array(items) => Value::Array(items.into_iter().map(|item| self.json(item)).collect()),
            Value::Object(map) => {
                let text_document = map
                    .get("kind")
                    .and_then(Value::as_str)
                    .is_some_and(|kind| matches!(kind, "markdown" | "mindmap" | "flowchart" | "canvas"));
                Value::Object(
                    map.into_iter()
                        .map(|(key, value)| {
                            let value = match key.as_str() {
                                "fileSha" | "lastSavedHash" if value.is_string() => json!("<sha>"),
                                "size" if text_document => json!("<size>"),
                                _ => self.json(value),
                            };
                            (self.text(&key), value)
                        })
                        .collect(),
                )
            }
            other => other,
        }
    }
}

/// 两种实现之间的已知差异：领域代码把 I/O 错误原样 `to_string()` 交给前端，错误文本随实现不同——
/// 本地目录是操作系统的文本（`No such file or directory (os error 2)`），内容库是自己的中文文本
/// （`不存在：<路径>`）。两边都报错、错误种类相同；这里只把「找不到」这一种折算成同一个记号再比。
fn known_io_error_text(text: &str) -> String {
    if text == "No such file or directory (os error 2)" || text.starts_with("不存在：") {
        "<io:not-found>".to_string()
    } else {
        text.to_string()
    }
}

fn digits(bytes: &[u8], from: usize, count: usize) -> bool {
    bytes.len() >= from + count && bytes[from..from + count].iter().all(u8::is_ascii_digit)
}

fn replace_rfc3339(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut last = 0;
    let mut index = 0;
    while index < bytes.len() {
        let shape = digits(bytes, index, 4)
            && bytes.get(index + 4) == Some(&b'-')
            && digits(bytes, index + 5, 2)
            && bytes.get(index + 7) == Some(&b'-')
            && digits(bytes, index + 8, 2)
            && bytes.get(index + 10) == Some(&b'T')
            && digits(bytes, index + 11, 2)
            && bytes.get(index + 13) == Some(&b':')
            && digits(bytes, index + 14, 2)
            && bytes.get(index + 16) == Some(&b':')
            && digits(bytes, index + 17, 2);
        if !shape {
            index += 1;
            continue;
        }
        let mut end = index + 19;
        if bytes.get(end) == Some(&b'.') {
            end += 1;
            while end < bytes.len() && bytes[end].is_ascii_digit() {
                end += 1;
            }
        }
        if bytes.get(end) == Some(&b'Z') {
            end += 1;
        } else if matches!(bytes.get(end), Some(b'+' | b'-'))
            && digits(bytes, end + 1, 2)
            && bytes.get(end + 3) == Some(&b':')
            && digits(bytes, end + 4, 2)
        {
            end += 6;
        }
        out.push_str(&text[last..index]);
        out.push_str("<time>");
        last = end;
        index = end;
    }
    out.push_str(&text[last..]);
    out
}

fn replace_compact_stamps(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut last = 0;
    let mut index = 0;
    while index < bytes.len() {
        let boundary = index == 0 || !bytes[index - 1].is_ascii_digit();
        if boundary
            && digits(bytes, index, 8)
            && bytes.get(index + 8) == Some(&b'-')
            && digits(bytes, index + 9, 6)
            && !bytes.get(index + 15).is_some_and(u8::is_ascii_digit)
        {
            let mut end = index + 15;
            if bytes.get(end) == Some(&b'-')
                && digits(bytes, end + 1, 3)
                && !bytes.get(end + 4).is_some_and(u8::is_ascii_digit)
            {
                end += 4;
            }
            out.push_str(&text[last..index]);
            out.push_str("<stamp>");
            last = end;
            index = end;
        } else {
            index += 1;
        }
    }
    out.push_str(&text[last..]);
    out
}

fn result<T: Serialize>(value: Result<T, String>) -> Value {
    match value {
        Ok(value) => json!({ "ok": serde_json::to_value(value).unwrap() }),
        Err(error) => json!({ "err": error }),
    }
}

/// 在两种实现上各跑一遍场景，比对归一化后的每一步返回值与最终目录树。
fn run_both(scenario: impl Fn(&Harness) -> Vec<Value>) {
    let mut outcomes = Vec::new();
    for harness in [Harness::fs(), Harness::sqlite()] {
        let steps = scenario(&harness);
        let steps: Vec<Value> = steps.into_iter().map(|step| harness.norm.json(step)).collect();
        outcomes.push((harness.name(), steps, harness.tree()));
    }
    let (fs_name, fs_steps, fs_tree) = &outcomes[0];
    let (sqlite_name, sqlite_steps, sqlite_tree) = &outcomes[1];
    if std::env::var_os("SHARD_DUAL_DUMP").is_some() {
        // 调试用：打印归一化后的每一步与目录树，确认场景真的走到了预期分支。
        println!("{}", serde_json::to_string_pretty(&json!({"steps": fs_steps, "tree": fs_tree})).unwrap());
    }
    assert_eq!(fs_steps.len(), sqlite_steps.len());
    for (index, (left, right)) in fs_steps.iter().zip(sqlite_steps).enumerate() {
        assert_eq!(
            left,
            right,
            "第 {index} 步的返回值不同\n{fs_name}: {}\n{sqlite_name}: {}",
            serde_json::to_string_pretty(left).unwrap(),
            serde_json::to_string_pretty(right).unwrap()
        );
    }
    assert_eq!(fs_tree, sqlite_tree, "最终目录树不同（左 {fs_name}，右 {sqlite_name}）");
}

fn fragment_fixture(id: &str, tags: &[&str], body: &str) -> String {
    let tags = tags.iter().map(|tag| format!("  - {tag}\n")).collect::<String>();
    format!(
        "---\nid: {id}\ncreated_at: 2026-01-02T03:04:05+08:00\nupdated_at: 2026-01-02T03:04:05+08:00\ntags:\n{tags}category: null\nai_status: none\nsource: test\nauthor: 外部字段保留\n---\n\n{body}\n"
    )
}

fn fragment_of(update: PublicFragmentUpdate) -> Fragment {
    match update {
        PublicFragmentUpdate::Saved(fragment) => *fragment,
        PublicFragmentUpdate::MoveToLockbox { .. } => panic!("不应移入密匣"),
    }
}

#[test]
fn dual_fragments_create_update_and_stale_base() {
    run_both(|h| {
        let mut steps = Vec::new();
        let (content, tags) = normalize_new_fragment("  第一条碎片  ", Some(vec!["工作".into()])).unwrap();
        let created = h.write(|cx| create_public_fragment(cx, &content, tags)).unwrap();
        h.alias(&created.id, "fragment-1");
        h.assert_file_sha(&created);
        steps.push(json!(created));

        // 正确基线保存成功；旧基线保存被拒绝（STALE_BASE），文件不变。
        let saved = fragment_of(
            h.write(|cx| {
                update_public_fragment_by_id(cx, &created.id, "第二版", vec!["工作".into()], Some(&created.file_sha))
            })
            .unwrap(),
        );
        h.assert_file_sha(&saved);
        steps.push(json!(saved));
        let stale = h.write(|cx| {
            update_public_fragment_by_id(cx, &created.id, "第三版", vec![], Some(&created.file_sha)).map(fragment_of)
        });
        assert_eq!(stale.as_ref().unwrap_err(), STALE_BASE_ERROR);
        steps.push(result(stale));

        // 标签改成密匣：只做前置校验，交回调用方移入密匣，不改文件。
        match h.write(|cx| update_public_fragment_tags_by_id(cx, &created.id, vec![LOCKBOX_TAG.into()])).unwrap() {
            PublicFragmentUpdate::MoveToLockbox { path, content, tags } => steps.push(json!({
                "moveToLockbox": relative_path(&h.root, &path).unwrap(),
                "content": content,
                "tags": tags,
            })),
            PublicFragmentUpdate::Saved(_) => panic!("{}：密匣标签应交回调用方", h.name()),
        }
        let retagged =
            fragment_of(h.write(|cx| update_public_fragment_tags_by_id(cx, &created.id, vec!["生活".into()])).unwrap());
        steps.push(json!(retagged));

        // 第二条碎片：关联、置顶、属性、进回收站再恢复。
        h.put_text("fragments/2026/01/fixed-two.md", &fragment_fixture("fixed-two", &["inbox"], "第二条"));
        steps.push(result(
            h.write(|cx| link_fragments_in_vault(cx, &created.id, "fixed-two", "manual", Some("备注".into()))),
        ));
        steps.push(result(h.write(|cx| unlink_fragments_in_vault(cx, &created.id, "missing-target"))));
        steps.push(result(h.write(|cx| set_public_fragment_pinned_by_id(cx, "fixed-two", true))));
        let value =
            property_input_to_yaml(serde_json::from_value(json!({"type": "number", "value": "12.5"})).unwrap()).unwrap();
        steps.push(result(h.write(|cx| set_public_fragment_property_in_vault(cx, "fixed-two", "评分", &value))));
        steps.push(result(h.write(|cx| remove_public_fragment_property_in_vault(cx, "fixed-two", "author"))));
        steps.push(result(h.write(|cx| set_public_fragment_archived_by_id(cx, "fixed-two", true))));
        steps.push(result(h.write(|cx| set_public_fragment_pinned_by_id(cx, "fixed-two", true))));
        steps.push(result(h.write(|cx| set_public_fragment_archived_by_id(cx, "fixed-two", false))));
        steps.push(result(h.write(|cx| {
            let registry = read_property_registry_in_vault(cx)?;
            register_property_type_in_vault(cx, "评分", PropertyType::Number, &registry.sha)
        })));

        let mut listed = h.read(|cx| list_public_fragments(cx, &HashSet::new())).unwrap();
        sort_fragment_list(&mut listed);
        for fragment in &listed {
            h.assert_file_sha(fragment);
        }
        steps.push(json!(listed));
        steps
    });
}

#[test]
fn dual_public_checks_see_lockbox_ids_without_lockbox_paths() {
    run_both(|h| {
        h.put_text("fragments/2026/01/public-a.md", &fragment_fixture("public-a", &["inbox"], "公开"));
        h.put_lockbox_envelope("private-x");
        let mut steps = vec![
            json!(h.read(|cx| is_lockbox_fragment_id(cx.vfs, "private-x")).unwrap()),
            json!(h.read(|cx| is_lockbox_fragment_id(cx.vfs, "public-a")).unwrap()),
            result(h.write(|cx| link_fragments_in_vault(cx, "public-a", "private-x", "manual", None))),
            result(h.write(|cx| create_mind_map_in_vault(cx, "私密导图".into(), Some("private-x".into())).map(|_| ()))),
        ];
        // 导图里的碎片链接经 shard-core 的 graph_model 校验：两种实现都要拒绝指向密匣的链接。
        let map = h.write(|cx| create_mind_map_in_vault(cx, "公开导图".into(), None)).unwrap();
        h.alias_map(&map.file);
        let mut file = map.file.clone();
        let root = file.root_id.clone();
        file.nodes.get_mut(&root).unwrap().links.push(ShardDocumentLink::Fragment {
            id: "link-private".into(),
            target_id: "private-x".into(),
        });
        let id = file.id.clone();
        steps.push(result(
            h.write(|cx| write_mind_map_in_vault(cx, &id, file, map.file.revision, &map.last_saved_hash).map(|_| ())),
        ));
        steps
    });
}

#[test]
fn dual_create_notes_directories_and_convert_fragments() {
    run_both(|h| {
        let mut steps = vec![
            result(h.write(|cx| create_library_directory_in_vault(cx, "项目", None))),
            result(h.write(|cx| create_library_directory_in_vault(cx, "项目", None))),
        ];
        let note = h.write(|cx| create_library_note_in_vault(cx, "周报", Some("notes/项目"))).unwrap();
        h.alias(&note.id, "note");
        h.assert_file_sha(&note);
        steps.push(json!(note));
        let second = h.write(|cx| create_library_note_in_vault(cx, "周报", Some("notes/项目"))).unwrap();
        h.alias(&second.id, "note-2");
        steps.push(json!(second));

        h.put_text(
            "fragments/2026/01/conv-1.md",
            &fragment_fixture("conv-1", &["inbox"], "# 转换标题\n\n引用 [[conv-1]]"),
        );
        h.put_text("notes/引用转换.md", &fragment_fixture("ref-conv", &["note"], "见 [[conv-1]] 与 [[conv-1|别名]]"));
        steps.push(result(h.write(|cx| convert_fragment_to_note_in_vault(cx, "conv-1", Some("notes/项目"), None))));
        steps.push(result(h.write(|cx| convert_note_to_fragment_in_vault(cx, "conv-1"))));
        steps.push(json!(h.read(|cx| library_mutation_result(cx, None, 0)).unwrap()));
        steps
    });
}

#[test]
fn dual_rename_and_move_rewrite_wikilinks_markdown_images_and_csv_cells() {
    run_both(|h| {
        h.put_text("notes/目标.md", &fragment_fixture("target-1", &["note"], "# 目标"));
        h.put_text(
            "notes/引用.md",
            &fragment_fixture(
                "ref-1",
                &["note"],
                "[[目标]] 与 [[目标|别名]]\n\n![图](notes/图片/a.png)\n![附件](assets/ab/x.png)",
            ),
        );
        h.put("notes/图片/a.png", PNG);
        h.put_text("notes/清单.csv", "名称,图片\n第一行,notes/图片/a.png\n第二行,无\n");
        h.put_text("datasets/表.csv", "名称,图片\n甲,notes/图片/a.png\n");
        h.write(|cx| create_library_directory_in_vault(cx, "归档", None)).unwrap();

        let mut steps = vec![
            result(h.write(|cx| rename_library_entry_in_vault(cx, "notes/目标.md", "新目标"))),
            result(h.write(|cx| rename_library_entry_in_vault(cx, "notes/目标.md", "再改"))),
            result(h.write(|cx| rename_library_entry_in_vault(cx, "notes/图片/a.png", "b"))),
            result(h.write(|cx| rename_library_entry_in_vault(cx, "notes/图片/b.png", "c.jpg"))),
            result(h.write(|cx| move_library_entry_in_vault(cx, "notes/图片", Some("notes/归档")))),
            result(h.write(|cx| move_library_entry_in_vault(cx, "notes/归档", Some("notes/归档/图片")))),
            result(h.write(|cx| move_library_entry_in_vault(cx, "notes/新目标.md", Some("notes/归档")))),
        ];
        steps.push(result(h.read(|cx| image_references_in_vault(cx, "notes/归档/图片/b.png"))));
        steps.push(json!(h.read(build_library_tree).unwrap()));
        steps
    });
}

#[test]
fn dual_trash_restore_purge_and_empty() {
    run_both(|h| {
        h.put_text("notes/资料/甲.md", &fragment_fixture("trash-a", &["note"], "甲"));
        h.put_text("notes/资料/乙.md", &fragment_fixture("trash-b", &["note"], "乙"));
        h.put_text("fragments/2026/01/trash-f.md", &fragment_fixture("trash-f", &["inbox"], "碎片"));
        h.put_text("datasets/废弃.csv", "a\n1\n");
        let to_rel = |cx: &VaultCtx<'_>, path: PathBuf| relative_path(cx.root(), &path).unwrap();
        let mut steps = vec![
            result(h.write(|cx| move_to_trash_in_vault(cx, "notes/资料/甲.md").map(|path| to_rel(cx, path)))),
            result(h.write(|cx| move_to_trash_in_vault(cx, "lockbox/x.shard").map(|_| ()))),
            result(h.write(|cx| move_to_trash_in_vault(cx, "../外面").map(|_| ()))),
            result(h.write(|cx| set_public_fragment_archived_by_id(cx, "trash-f", true))),
            result(h.write(|cx| move_to_trash_in_vault(cx, "datasets/废弃.csv").map(|path| to_rel(cx, path)))),
        ];
        // 原位置又有了同名文件：恢复时加时间戳后缀，绝不覆盖。
        h.put_text("notes/资料/甲.md", &fragment_fixture("trash-a2", &["note"], "新甲"));
        steps.push(result(
            h.write(|cx| restore_from_trash_in_vault(cx, ".trash/notes/资料/甲.md").map(|path| to_rel(cx, path))),
        ));
        // `.trash/notes/资料` 已存在（恢复甲之后留下的空目录），整个目录进回收站时加时间戳后缀。
        let moved = h.write(|cx| move_to_trash_in_vault(cx, "notes/资料").map(|path| to_rel(cx, path)));
        steps.push(result(moved.clone()));
        let moved = moved.unwrap();
        steps.push(result(h.write(|cx| purge_from_trash_in_vault(cx, &format!("{moved}/乙.md")))));
        steps.push(result(h.write(|cx| purge_from_trash_in_vault(cx, &format!("{moved}/乙.md")))));
        steps.push(result(h.write(|cx| purge_from_trash_in_vault(cx, "notes/资料"))));
        steps.push(json!(h.read(build_library_tree).unwrap()));
        steps.push(result(h.write(|cx| empty_trash_in_vault(cx, ContentScope::Library))));
        steps.push(json!(h.read(build_library_tree).unwrap()));
        steps.push(result(h.write(|cx| empty_trash_in_vault(cx, ContentScope::All))));
        steps.push(json!(h.read(build_library_tree).unwrap()));
        steps
    });
}

#[test]
fn dual_mind_map_read_write_conflict_copy_and_delete() {
    run_both(|h| {
        h.put_text("fragments/2026/01/map-src.md", &fragment_fixture("map-src", &["inbox"], "导图来源"));
        h.write(|cx| create_library_directory_in_vault(cx, "导图", None)).unwrap();
        let created = h
            .write(|cx| create_mind_map_at_in_vault(cx, "计划".into(), Some("map-src".into()), Some("notes/导图")))
            .unwrap();
        h.alias_map(&created.file);
        let branch = created.file.nodes.keys().find(|key| **key != created.file.root_id).unwrap().clone();
        let mut steps = vec![json!(created)];
        let read = h.read(|cx| read_mind_map_in_vault(cx, &created.file.id)).unwrap();
        assert_eq!(read.last_saved_hash, created.last_saved_hash, "{}：读回的哈希与写入时不同", h.name());
        steps.push(json!(read));

        let mut next = read.file.clone();
        next.nodes.get_mut(&branch).unwrap().text = "第一步".into();
        let written = h
            .write(|cx| {
                write_mind_map_in_vault(cx, &created.file.id, next.clone(), read.file.revision, &read.last_saved_hash)
            })
            .unwrap();
        steps.push(json!(written));
        // 旧版本基线再写：另存冲突副本并报错，主文件不变。
        let mut stale = read.file.clone();
        stale.nodes.get_mut(&branch).unwrap().text = "过期草稿".into();
        steps.push(result(h.write(|cx| {
            write_mind_map_in_vault(cx, &created.file.id, stale, read.file.revision, &read.last_saved_hash)
        })));
        steps.push(result(h.read(list_mind_maps_in_vault)));
        steps.push(json!(h.read(build_library_tree).unwrap()));
        steps.push(result(h.write(|cx| delete_mind_map_in_vault(cx, &created.file.id, read.file.revision))));
        steps.push(result(h.write(|cx| delete_mind_map_in_vault(cx, &created.file.id, written.file.revision))));
        steps.push(result(h.read(list_mind_maps_in_vault)));
        steps
    });
}

#[test]
fn dual_dataset_apply_ops_and_stale_base() {
    run_both(|h| {
        h.put_text("datasets/阅读.csv", "id,书名,评分\nr1,第一本,5\nr2,第二本,4\n");
        h.put_text(
            "datasets/阅读.csv.schema.json",
            &json!({"schemaVersion": 1, "datasetId": "ds_0123456789abcdef0123456789abcdef", "title": "阅读", "primaryKey": "id"})
                .to_string(),
        );
        h.put_text("notes/外部.csv", "a,b\n1,2\n");
        let read = h.read(|cx| read_dataset_in_vault(cx, "datasets/阅读.csv")).unwrap();
        let mut steps = vec![json!(read)];
        let ops = vec![
            DatasetOp::SetCells { cells: vec![dataset::CellEdit { row: 0, column: 1, value: "改名".into() }] },
            DatasetOp::InsertRows { at: 2, rows: vec![vec!["r3".into(), "第三本".into(), "3".into()]] },
            DatasetOp::RenameColumn { column: 2, name: "得分".into() },
        ];
        let applied = h
            .write(|cx| apply_dataset_ops_in_vault(cx, "datasets/阅读.csv", &read.sha, read.schema_sha.as_deref(), &ops))
            .unwrap();
        steps.push(json!(applied));
        steps.push(result(h.write(|cx| {
            apply_dataset_ops_in_vault(cx, "datasets/阅读.csv", &read.sha, read.schema_sha.as_deref(), &ops)
        })));
        steps.push(result(h.read(list_csv_files_in_vault)));
        let bytes = h.read(|cx| read_csv_file_in_vault(cx, "datasets/阅读.csv")).unwrap();
        steps.push(json!(String::from_utf8(bytes).unwrap()));
        steps.push(result(h.read(|cx| read_csv_file_in_vault(cx, "lockbox/x.csv").map(|_| ()))));
        steps
    });
}

#[test]
fn dual_images_store_import_and_reference_queries() {
    run_both(|h| {
        let stored = h.write(|cx| store_image_attachment(cx, PNG)).unwrap();
        let again = h.write(|cx| store_image_attachment(cx, PNG)).unwrap();
        assert_eq!(stored, again, "{}：同一张图只存一份", h.name());
        let hash = Path::new(&stored).file_stem().unwrap().to_str().unwrap().to_string();
        let mut steps = vec![
            json!(stored),
            result(h.write(|cx| store_image_attachment(cx, b"not an image"))),
            result(h.write(|cx| store_image_attachment(cx, b""))),
        ];
        h.put_text(
            "notes/配图.md",
            &fragment_fixture("img-note", &["note"], &format!("![图]({stored})\n![旧](shard-attachment:{hash})")),
        );
        h.put_text("notes/表.csv", &format!("图\n{stored}\n"));
        h.put_text("fragments/2026/01/img-frag.md", &fragment_fixture("img-frag", &["inbox"], &format!("![图]({stored})")));
        h.write(|cx| create_library_directory_in_vault(cx, "相册", None)).unwrap();

        // 服务端没有「访达里的文件」：来源字节由调用方提供（这里是内存里的上传内容）。
        let uploads = [
            ("/上传/营业执照.png", PNG.to_vec()),
            ("/上传/营业执照.png", PNG.to_vec()),
            ("/上传/说明.txt", b"text".to_vec()),
        ];
        let paths: Vec<String> = uploads.iter().map(|(path, _)| path.to_string()).collect();
        let read_source = |source: &Path| -> Result<Vec<u8>, String> {
            let bytes = uploads
                .iter()
                .find(|(path, _)| Path::new(path) == source)
                .map(|(_, bytes)| bytes.clone())
                .ok_or_else(|| "找不到图片文件".to_string())?;
            sniff_image_mime_type(&bytes)?;
            Ok(bytes)
        };
        steps.push(json!(h
            .write(|cx| import_library_images_in_vault_with(cx, &paths, Some("notes/相册"), &read_source))
            .unwrap()));

        steps.push(result(h.read(|cx| image_references_in_vault(cx, &stored))));
        steps.push(result(h.read(|cx| image_references_in_vault(cx, "notes/相册/营业执照.png"))));
        let candidates = vec![
            stored.clone(),
            format!("shard-attachment:{hash}"),
            "notes/相册/营业执照-2.png".into(),
            "notes/没有.png".into(),
            "lockbox/a.png".into(),
            "notes/配图.md".into(),
        ];
        steps.push(json!(h.read(|cx| existing_vault_images_in(cx.vfs, candidates))));
        // 返回的是规范路径（本地目录会解开临时目录的符号链接），按规范化后的根取相对路径。
        steps.push(result(h.read(|cx| {
            let root = cx.vfs.canonicalize(cx.root()).unwrap();
            resolve_vault_asset_path(cx.vfs, &format!("shard-attachment:{hash}"))
                .map(|path| relative_path(&root, &path).unwrap())
        })));
        steps.push(json!(h.read(|cx| sniff_library_asset_mime_type(cx.vfs, &cx.root().join(&stored)))));
        steps.push(json!(h.read(collect_library_assets)));
        steps
    });
}

#[test]
fn dual_library_tree_snapshot() {
    run_both(|h| {
        h.put_text("fragments/2026/01/tree-a.md", &fragment_fixture("tree-a", &["inbox"], "碎片 A"));
        h.put_text("fragments/2026/02/tree-b.md", &fragment_fixture("tree-b", &["inbox"], "碎片 B"));
        h.put_text("fragments/2025/12/tree-c.md", &fragment_fixture("tree-c", &["inbox"], "碎片 C"));
        h.put_text("fragments/2026/02/忽略.txt", "不是 Markdown");
        h.put_text("notes/首页.md", &fragment_fixture("tree-home", &["note"], "# 首页\n\n![图](assets/cd/ref.png)"));
        h.put_text("notes/目录/子页.md", &fragment_fixture("tree-sub", &["note"], "# 子页"));
        h.put_text("notes/目录/表格.csv", "a,b\n1,2\n");
        h.put("notes/目录/照片.heic", b"heic-bytes");
        h.put_text("notes/目录/备注.txt", "不上树");
        h.put_text("notes/.隐藏/秘密.md", &fragment_fixture("tree-hidden", &["note"], "隐藏"));
        h.put("assets/cd/ref.png", PNG);
        h.put("assets/ef/orphan.png", PNG);
        h.put_text(
            "notes/流程.shardflow.json",
            &json!({"kind": "shard.flow", "schemaVersion": 1, "id": "flow-tree", "title": "流程",
                "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z", "revision": 1,
                "nodes": [], "edges": []})
            .to_string(),
        );
        h.put_text(".trash/notes/旧页.md", &fragment_fixture("tree-old", &["note"], "旧"));
        h.put_text(".trash/fragments/2026/01/tree-del.md", &fragment_fixture("tree-del", &["inbox"], "删了"));
        h.put_text(".trash/notes/残留.bin", "回收站里的其他文件");
        let map = h.write(|cx| create_mind_map_in_vault(cx, "树图".into(), None)).unwrap();
        h.alias_map(&map.file);
        vec![json!(h.read(build_library_tree).unwrap())]
    });
}

#[test]
fn dual_graph_fragment_and_flow_canvas_documents() {
    run_both(|h| {
        let operation = format!("op-{}", h.name());
        let created = h
            .write(|cx| create_graph_fragment_in_vault(cx, "flowchart", &operation, None, vec!["流程".into()]))
            .unwrap();
        h.alias(&created.fragment.id, "graph");
        let mut steps = vec![json!(created)];
        let read = h.read(|cx| read_graph_fragment_in_vault(cx, &created.fragment.id)).unwrap();
        let mut graph = read.graph.clone();
        graph["title"] = json!("改过的流程图");
        steps.push(result(h.write(|cx| {
            write_graph_fragment_in_vault(cx, &created.fragment.id, graph.clone(), Some(&read.fragment.file_sha))
        })));
        steps.push(result(h.write(|cx| {
            write_graph_fragment_in_vault(cx, &created.fragment.id, graph, Some(&read.fragment.file_sha))
        })));

        let flow: CanvasFile = serde_json::from_value(json!({
            "kind": "shard.flow", "schemaVersion": 1, "id": "flow-dual", "title": "双实现流程",
            "createdAt": "2026-09-07T00:00:00.000Z", "updatedAt": "2026-09-07T00:00:00.000Z", "revision": 0,
            "nodes": [{"id": "a", "kind": "process", "x": 0.1, "y": 0, "text": "开始"}],
            "edges": []
        }))
        .unwrap();
        let canvas_created = h.write(|cx| canvas::create_in_vault(cx, "notes", "双实现流程", flow.clone())).unwrap();
        steps.push(json!(canvas_created));
        // 重放同一个创建请求：认出已创建的文档，不重复创建。
        steps.push(json!(h.write(|cx| canvas::create_in_vault(cx, "notes", "双实现流程", flow)).unwrap()));
        let mut next = canvas_created.file.clone();
        next.nodes[0].text = "改过".into();
        let saved = h
            .write(|cx| {
                canvas::write_in_vault(
                    cx,
                    &canvas_created.path,
                    next,
                    canvas_created.file.revision,
                    &canvas_created.last_saved_hash,
                )
            })
            .unwrap();
        steps.push(json!(saved));
        steps.push(json!(h.read(canvas::split::list_in_vault).unwrap()));
        steps.push(result(h.write(|cx| import_graph_file_to_timeline_in_vault(cx, &canvas_created.path))));
        steps
    });
}

#[test]
fn normalization_only_masks_run_dependent_text() {
    let norm = Norm::default();
    norm.aliases.borrow_mut().push(("20261026-101010-abcd1234-ef5678".into(), "<id>".into()));
    assert_eq!(
        norm.text("a 2026-10-26T10:10:10.123456+08:00 b 2026-10-26T02:10:10Z c 20261026-101010-123 d"),
        "a <time> b <time> c <stamp> d"
    );
    assert_eq!(norm.text("fragments/2026/10/20261026-101010-abcd1234-ef5678.md"), "fragments/2026/10/<id>.md");
    assert_eq!(norm.text("2026-10-26 不是时间 123456789-123456"), "2026-10-26 不是时间 123456789-123456");
}
