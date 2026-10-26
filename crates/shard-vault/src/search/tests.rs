//! 搜索投影与扫描的测试。
//!
//! - `dual_*`：同一组文档分别写进本地目录（FsVfs）与服务端内容库（SqliteVfs），投影出的快照、每条查询的
//!   命中、读取单个目标的结果必须完全一致。不做任何归一化：CSV 的 revision / updatedAt 取文件修改时间，
//!   两边都钉在同一时刻（本地目录用 `set_times`，内容库用 `WriteCtx::with_now`）。
//! - 其余用例大多在两种实现上各跑一遍，覆盖投影细节、路径校验与错误码；CSV 表头读取与迁移前的
//!   逐字节 `BufReader` 实现做等价比对。

use std::{
    collections::BTreeMap,
    io::{BufRead, BufReader, Cursor, Read},
    path::PathBuf,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use shard_core::{
    ensure_vault_layout,
    search::{
        project_document, MatchLocation, ParsedQuery, ProjectedDocument, SearchProjectionBlock,
        SourceDocument,
    },
    write_fragment_file, FragmentFrontmatter, FsVfs, Vfs,
};
use shard_store::{LockboxItemRaw, SqliteVfs, Store, StoreError, WriteCtx};

use super::*;

const VAULT_ID: &str = "vault-测试";

/// CSV 的 revision 与 updatedAt 取修改时间；两边钉在同一刻，快照才能逐字节相同。
fn fixed_mtime() -> SystemTime {
    UNIX_EPOCH + Duration::from_secs(1_790_000_000)
}

enum Backend {
    Fs,
    Sqlite(Box<Store>),
}

struct TestVault {
    backend: Backend,
    root: PathBuf,
    _dir: tempfile::TempDir,
}

impl TestVault {
    fn fs() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let vault = Self {
            backend: Backend::Fs,
            root,
            _dir: dir,
        };
        vault.write(|vfs| ensure_vault_layout(vfs)).unwrap();
        vault
    }

    fn sqlite() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let root = store.root().to_path_buf();
        let vault = Self {
            backend: Backend::Sqlite(Box::new(store)),
            root,
            _dir: dir,
        };
        vault.write(|vfs| ensure_vault_layout(vfs)).unwrap();
        vault
    }

    fn both() -> [Self; 2] {
        [Self::fs(), Self::sqlite()]
    }

    fn name(&self) -> &'static str {
        match self.backend {
            Backend::Fs => "FsVfs",
            Backend::Sqlite(_) => "SqliteVfs",
        }
    }

    fn path(&self, relative: &str) -> PathBuf {
        self.root.join(relative)
    }

    /// 一次写操作；内容库侧是一个写事务，时间钉在 [`fixed_mtime`]。
    fn write<R>(&self, f: impl FnOnce(&dyn Vfs) -> R) -> R {
        match &self.backend {
            Backend::Fs => f(&FsVfs::new(&self.root)),
            Backend::Sqlite(store) => {
                let ctx = WriteCtx::new("search-test", "test")
                    .with_now(DateTime::<Utc>::from(fixed_mtime()));
                store
                    .write(&ctx, |vfs: &SqliteVfs<'_>| Ok::<_, StoreError>(f(vfs)))
                    .unwrap()
                    .0
            }
        }
    }

    /// 只读操作：内容库侧是只读快照，任何写入都会失败——顺带证明搜索投影不写盘。
    fn read<R>(&self, f: impl FnOnce(&dyn Vfs) -> R) -> R {
        match &self.backend {
            Backend::Fs => f(&FsVfs::new(&self.root)),
            Backend::Sqlite(store) => store.read(|vfs| f(vfs)).unwrap(),
        }
    }

    /// 本地目录侧把修改时间钉成 [`fixed_mtime`]（内容库侧由写事务的时钟负责）。
    fn pin_mtime(&self, relative: &str) {
        if let Backend::Fs = self.backend {
            std::fs::File::options()
                .write(true)
                .open(self.path(relative))
                .unwrap()
                .set_times(std::fs::FileTimes::new().set_modified(fixed_mtime()))
                .unwrap();
        }
    }

    fn put(&self, relative: &str, bytes: &[u8]) {
        let path = self.path(relative);
        self.write(|vfs| vfs.write_atomic(&path, bytes)).unwrap();
        self.pin_mtime(relative);
    }

    fn put_text(&self, relative: &str, text: &str) {
        self.put(relative, text.as_bytes());
    }

    fn put_markdown(&self, relative: &str, id: &str, tags: &[&str], body: &str) {
        let path = self.path(relative);
        let frontmatter = frontmatter(id, tags);
        self.write(|vfs| write_fragment_file(vfs, &path, &frontmatter, body))
            .unwrap();
        self.pin_mtime(relative);
    }

    /// 本地目录写进 `lockbox/`（含一份 CSV）；内容库拒绝一切 `lockbox/` 路径，信封只进 `lockbox_items`。
    fn put_lockbox(&self) {
        match &self.backend {
            Backend::Fs => {
                self.put_text(
                    "lockbox/fragments/2026/09/secret.shard",
                    "PRIVATE_MARKER 秘密正文",
                );
                self.put_text("lockbox/秘密.csv", "秘密列,PRIVATE_MARKER\n1,2\n");
            }
            Backend::Sqlite(store) => {
                store
                    .write(
                        &WriteCtx::new("search-test", "test"),
                        |vfs: &SqliteVfs<'_>| {
                            vfs.put_lockbox_item_raw(&LockboxItemRaw {
                                item_id: "secret".to_string(),
                                envelope: "PRIVATE_MARKER 秘密正文".to_string(),
                                legacy_path: None,
                                created_at: "2026-09-25T00:00:00Z".to_string(),
                                updated_at: "2026-09-25T00:00:00Z".to_string(),
                            })
                            .map_err(StoreError::from)
                        },
                    )
                    .unwrap();
            }
        }
    }

    fn snapshot(&self) -> SearchSnapshotData {
        self.read(|vfs| build_public_snapshot(vfs, VAULT_ID))
            .unwrap()
    }

    fn read_target(&self, target: &SearchTarget) -> Result<LoadedSearchDocument, SearchError> {
        self.read(|vfs| read_public_search_target(vfs, VAULT_ID, target))
    }
}

fn frontmatter(id: &str, tags: &[&str]) -> FragmentFrontmatter {
    FragmentFrontmatter {
        id: id.to_string(),
        created_at: "2026-09-25T00:00:00Z".to_string(),
        updated_at: "2026-09-25T01:00:00Z".to_string(),
        tags: tags.iter().map(|tag| (*tag).to_string()).collect(),
        category: None,
        ai_status: Some("none".to_string()),
        pinned: false,
        source: "test".to_string(),
        conflict_of: None,
        related: Vec::new(),
    }
}

fn map_json(id: &str, title: &str, root: &str, child: Option<(&str, &str)>) -> Value {
    let mut nodes = serde_json::Map::new();
    nodes.insert(
        "secret-root-id".into(),
        json!({
            "id": "secret-root-id", "parentId": null, "sortKey": "secret-sort-a", "text": root,
            "createdAt": "2026-09-25T00:00:00Z", "updatedAt": "2026-09-25T00:00:00Z"
        }),
    );
    if let Some((text, note)) = child {
        nodes.insert(
            "secret-child-id".into(),
            json!({
                "id": "secret-child-id", "parentId": "secret-root-id", "sortKey": "secret-sort-b",
                "text": text, "note": note,
                "createdAt": "2026-09-25T00:00:00Z", "updatedAt": "2026-09-25T00:00:00Z"
            }),
        );
    }
    json!({
        "kind": "shard.map", "schemaVersion": 1, "id": id, "title": title,
        "createdAt": "2026-09-25T00:00:00Z", "updatedAt": "2026-09-25T02:00:00Z",
        "savedWithAppVersion": "internal-version", "revision": 1, "rootId": "secret-root-id",
        "hasProtectedLinks": false, "nodes": nodes
    })
}

fn flow_json(
    kind: &str,
    id: &str,
    title: &str,
    nodes: &[(&str, &str, &str)],
    edge: Option<&str>,
) -> Value {
    let nodes = nodes
        .iter()
        .enumerate()
        .map(|(index, (node_id, node_kind, text))| {
            json!({
                "id": node_id, "kind": node_kind, "x": 987_654 - index as i64, "y": 123_456,
                "text": text
            })
        })
        .collect::<Vec<_>>();
    let edges = match edge {
        Some(label) => vec![json!({
            "id": "secret-edge-id", "source": nodes[0]["id"],
            "target": nodes[nodes.len() - 1]["id"], "label": label
        })],
        None => Vec::new(),
    };
    json!({
        "kind": kind, "schemaVersion": 1, "id": id, "title": title,
        "createdAt": "2026-09-25T00:00:00Z", "updatedAt": "2026-09-25T03:00:00Z",
        "revision": 1, "nodes": nodes, "edges": edges
    })
}

/// 覆盖全部来源类型的一组文档：碎片、笔记、文档、大纲 / 流程图图形碎片（含损坏区域）、导图（含旧 `maps/`）、
/// 画布、独立流程图、CSV（含 BOM 与引号）、回收站条目、无法解析的文件、隐藏目录与密匣。
fn seed(vault: &TestVault) {
    vault.put_markdown(
        "fragments/2026/09/frag-reading.md",
        "frag-reading",
        &[],
        "今天读完《深度工作》第三章。\n\n记下要点：专注时间要成块。",
    );
    vault.put_markdown(
        "fragments/2026/09/frag-tagged.md",
        "frag-tagged",
        &["阅读", "work"],
        "Rust 搜索 pipeline 设计草稿",
    );
    vault.put_markdown(
        "notes/计划/季度计划.md",
        "note-plan",
        &["note", "工作"],
        "# 季度计划\n\n第一季度目标：完成搜索服务端。\n\n```text\n代码块里的词\n```",
    );
    vault.put_markdown(
        "notes/文档/说明.md",
        "doc-readme",
        &["document"],
        "## 使用说明\n\n这里是文档正文，介绍资料库。",
    );
    vault.put_markdown(
        "fragments/2026/09/outline.md",
        "outline-1",
        &["outline"],
        &format!(
            "```shardmap\n{}\n```",
            map_json(
                "secret-map-id",
                "不作为 md 标题",
                "路线规划",
                Some(("预订车票", "确认乘车时间"))
            )
        ),
    );
    vault.put_markdown(
        "fragments/2026/09/flow.md",
        "flow-1",
        &["flowchart"],
        &format!(
            "```shardflow\n{}\n```",
            flow_json(
                "shard.flow",
                "secret-flow-id",
                "发布流程",
                &[
                    ("secret-start-id", "terminal", "开始发布"),
                    ("secret-review-id", "process", "审核内容"),
                ],
                Some("审核通过"),
            )
        ),
    );
    vault.put_markdown(
        "fragments/2026/09/broken-outline.md",
        "broken-outline",
        &["outline"],
        "仍可搜索的前文\n\n```shardmap\n{not json}\n```\n\n仍可搜索的后文",
    );
    vault.put_text(
        "notes/导图/项目导图.shardmap.json",
        &map_json(
            "map-1",
            "项目导图",
            "项目根节点",
            Some(("分支甲", "导图备注不进投影")),
        )
        .to_string(),
    );
    vault.put_text(
        "maps/旧导图.shardmap.json",
        &map_json("map-legacy", "旧导图", "遗留节点", None).to_string(),
    );
    vault.put_text(
        "notes/白板.shardcanvas.json",
        &flow_json(
            "shard.canvas",
            "canvas-1",
            "白板",
            &[("n1", "text", "画布便签")],
            None,
        )
        .to_string(),
    );
    vault.put_text(
        "notes/流程/上线.shardflow.json",
        &flow_json(
            "shard.flow",
            "flow-file-1",
            "上线流程",
            &[
                ("n1", "process", "灰度发布"),
                ("n2", "terminal", "全量上线"),
            ],
            Some("观察指标"),
        )
        .to_string(),
    );
    vault.put_text("数据.csv", "姓名,进度\n小夏,完成\n");
    vault.put_text(
        "notes/表格/成绩.csv",
        "\u{feff}\"学号\",\"说明\n续行\",\"他说 \"\"你好\"\"\"\r\n1,正文不进投影,b\r\n",
    );
    vault.put_text("notes/.隐藏/内部.csv", "内部列\n1\n");
    vault.put_markdown(
        ".trash/notes/旧笔记.md",
        "trash-note",
        &["note"],
        "# 已归档的旧笔记\n\n回收站正文",
    );
    vault.put_markdown(
        ".trash/fragments/2026/09/trash-frag.md",
        "trash-frag",
        &[],
        "回收站里的碎片",
    );
    vault.put_text(
        ".trash/notes/废弃导图.shardmap.json",
        &map_json("map-trash", "废弃导图", "回收站导图", None).to_string(),
    );
    vault.put_text("notes/坏文件.md", "没有 frontmatter 的普通 Markdown");
    vault.put_text("notes/坏导图.shardmap.json", "{}");

    // 带自定义属性的笔记：在 frontmatter 里补一行。
    vault.put_markdown(
        "notes/属性文档.md",
        "property-note",
        &["note"],
        "# 属性文档",
    );
    let path = vault.path("notes/属性文档.md");
    let text = vault.read(|vfs| vfs.read_to_string(&path)).unwrap();
    vault.put_text(
        "notes/属性文档.md",
        &text.replacen("source: test", "source: test\n负责人: 张三", 1),
    );

    vault.put_lockbox();
}

/// 快照里可比较的部分：文档（ProjectedDocument 含规范化文本）、元数据、skipped 与内容戳。
fn comparable(snapshot: &SearchSnapshotData) -> (Vec<ProjectedDocument>, Value, u32, String) {
    let metadata = snapshot
        .metadata
        .iter()
        .map(|(key, value)| {
            (
                key.clone(),
                json!({
                    "target": value.target,
                    "updatedAt": value.updated_at,
                    "revision": value.revision,
                    "revealHint": value.reveal_hint,
                    "readOnly": value.read_only,
                }),
            )
        })
        .collect::<BTreeMap<_, _>>();
    (
        snapshot.documents.clone(),
        serde_json::to_value(metadata).unwrap(),
        snapshot.skipped_files,
        snapshot.source_stamp.clone(),
    )
}

fn query(
    snapshot: &SearchSnapshotData,
    text: &str,
    limit: usize,
    include_trash: bool,
) -> SearchScanResult {
    snapshot
        .search(&parse_search_query(text).unwrap(), limit, include_trash)
        .unwrap()
}

fn paths(result: &SearchScanResult) -> Vec<&str> {
    result
        .hits
        .iter()
        .map(|hit| hit.target.path.as_str())
        .collect()
}

fn hit<'a>(result: &'a SearchScanResult, path: &str) -> &'a SearchHit {
    result
        .hits
        .iter()
        .find(|hit| hit.target.path == path)
        .unwrap_or_else(|| panic!("缺少命中 {path}：{:?}", paths(result)))
}

fn public_target(path: &str, kind: SearchKind, object_id: Option<&str>) -> SearchTarget {
    make_target(
        VAULT_ID,
        SearchScope::Public,
        path.to_string(),
        kind,
        object_id.map(str::to_string),
        false,
    )
}

#[test]
fn dual_snapshot_is_identical_on_fs_and_sqlite() {
    let [fs, sqlite] = TestVault::both();
    seed(&fs);
    seed(&sqlite);
    let left = fs.snapshot();
    let right = sqlite.snapshot();
    assert_eq!(
        comparable(&left),
        comparable(&right),
        "FsVfs 与 SqliteVfs 的快照不一致"
    );

    // 快照内容本身也要对：16 篇文档、3 个跳过（坏 Markdown、坏导图、回收站里的导图）。
    let mut kinds = left
        .metadata
        .values()
        .map(|metadata| {
            (
                metadata.target.path.clone(),
                serde_json::to_value(&metadata.target.kind).unwrap(),
            )
        })
        .collect::<Vec<_>>();
    kinds.sort_by(|left, right| left.0.cmp(&right.0));
    let expected = [
        (".trash/fragments/2026/09/trash-frag.md", "fragment"),
        (".trash/notes/旧笔记.md", "note"),
        ("fragments/2026/09/broken-outline.md", "outline"),
        ("fragments/2026/09/flow.md", "flowchart"),
        ("fragments/2026/09/frag-reading.md", "fragment"),
        ("fragments/2026/09/frag-tagged.md", "fragment"),
        ("fragments/2026/09/outline.md", "outline"),
        ("maps/旧导图.shardmap.json", "mindmap"),
        ("notes/导图/项目导图.shardmap.json", "mindmap"),
        ("notes/属性文档.md", "note"),
        ("notes/文档/说明.md", "document"),
        ("notes/流程/上线.shardflow.json", "flowchart"),
        ("notes/白板.shardcanvas.json", "canvas"),
        ("notes/表格/成绩.csv", "csv"),
        ("notes/计划/季度计划.md", "note"),
        ("数据.csv", "csv"),
    ]
    .map(|(path, kind)| (path.to_string(), json!(kind)));
    assert_eq!(kinds, expected.to_vec());
    assert_eq!(left.skipped_files, 3);
    assert_eq!(left.documents.len(), left.metadata.len());
    assert!(left
        .documents
        .windows(2)
        .all(|pair| pair[0].stable_key < pair[1].stable_key));
    for document in &left.documents {
        let metadata = &left.metadata[&document.stable_key];
        assert_eq!(metadata.target.key, document.stable_key);
        assert_eq!(metadata.target.vault_path, VAULT_ID);
        assert_eq!(
            metadata.target.key,
            target_key(VAULT_ID, &SearchScope::Public, &metadata.target.path)
        );
        assert!(metadata.read_only);
        // 密匣永不进公开快照，内部字段（id、排序键、坐标）也不进投影。
        for secret in [
            "PRIVATE_MARKER",
            "秘密",
            "内部列",
            "secret-root-id",
            "secret-sort",
            "987654",
            "schemaVersion",
            "导图备注不进投影",
            "正文不进投影",
        ] {
            assert!(
                !document.projection.searchable_text.contains(secret),
                "{} 泄露了 {secret}",
                metadata.target.path
            );
        }
    }
    let archived = left
        .metadata
        .values()
        .filter(|metadata| metadata.target.archived)
        .count();
    assert_eq!(archived, 2);

    // 同样的内容再建一次，快照不变。
    assert_eq!(comparable(&fs.snapshot()), comparable(&left));
}

#[test]
fn dual_queries_return_identical_hits_on_fs_and_sqlite() {
    let [fs, sqlite] = TestVault::both();
    seed(&fs);
    seed(&sqlite);
    let left = fs.snapshot();
    let right = sqlite.snapshot();

    let queries = [
        "计划",
        "读",
        "阅读",
        "WORK",
        "预订车票",
        "确认乘车时间",
        "审核通过",
        "画布便签",
        "观察指标",
        "分支甲",
        "遗留节点",
        "进度",
        "续行",
        "回收站",
        "代码块里的词",
        "季度 目标",
        "仍可搜索的后文",
        "发布",
        "说明",
        "内部",
        "PRIVATE_MARKER",
        "secret-root-id",
        "不存在的词",
        "",
    ];
    for text in queries {
        for include_trash in [false, true] {
            for limit in [1, 50] {
                assert_eq!(
                    query(&left, text, limit, include_trash),
                    query(&right, text, limit, include_trash),
                    "查询 {text:?} include_trash={include_trash} limit={limit} 两边不一致"
                );
            }
        }
    }

    // 中文 1–2 字查询与标题命中。
    let plan = query(&left, "计划", 50, false);
    let note = hit(&plan, "notes/计划/季度计划.md");
    assert_eq!(note.title, "季度计划");
    assert!(note.matched_fields.contains(&SearchField::Title));
    assert!(note
        .title_parts
        .iter()
        .any(|part| part.hit && part.text == "计划"));
    assert_eq!(note.reveal_hint, SearchRevealHint::Text);
    assert_eq!(
        note.revision.as_deref(),
        Some(left.metadata[&note.target.key].revision.as_str())
    );

    let read = query(&left, "读", 50, false);
    assert!(hit(&read, "fragments/2026/09/frag-reading.md")
        .matched_fields
        .contains(&SearchField::Body));
    assert!(hit(&read, "fragments/2026/09/frag-tagged.md")
        .matched_fields
        .contains(&SearchField::Tags));
    // 无标签碎片按 inbox 处理。
    assert_eq!(
        hit(&read, "fragments/2026/09/frag-reading.md").tags,
        vec!["inbox".to_string()]
    );

    // 标签命中（含大小写折叠）。
    for text in ["阅读", "WORK"] {
        let result = query(&left, text, 50, false);
        let tagged = hit(&result, "fragments/2026/09/frag-tagged.md");
        assert_eq!(tagged.matched_fields, vec![SearchField::Tags], "{text}");
        assert_eq!(tagged.tags, vec!["阅读".to_string(), "work".to_string()]);
    }

    // 图形碎片只投影用户文字，命中只能整篇打开。
    for (text, path, title) in [
        ("预订车票", "fragments/2026/09/outline.md", "路线规划"),
        ("确认乘车时间", "fragments/2026/09/outline.md", "路线规划"),
        ("审核通过", "fragments/2026/09/flow.md", "发布流程"),
    ] {
        let result = query(&left, text, 50, false);
        assert_eq!(paths(&result), vec![path], "{text}");
        assert_eq!(result.hits[0].title, title);
        assert_eq!(result.hits[0].reveal_hint, SearchRevealHint::DocumentOnly);
    }
    let broken = query(&left, "仍可搜索的后文", 50, false);
    assert_eq!(paths(&broken), vec!["fragments/2026/09/broken-outline.md"]);
    assert_eq!(broken.hits[0].title, "仍可搜索的前文");

    // 结构化文档。
    for (text, path, kind, reveal) in [
        (
            "画布便签",
            "notes/白板.shardcanvas.json",
            SearchKind::Canvas,
            SearchRevealHint::DocumentOnly,
        ),
        (
            "观察指标",
            "notes/流程/上线.shardflow.json",
            SearchKind::Flowchart,
            SearchRevealHint::DocumentOnly,
        ),
        (
            "分支甲",
            "notes/导图/项目导图.shardmap.json",
            SearchKind::Mindmap,
            SearchRevealHint::DocumentOnly,
        ),
        (
            "遗留节点",
            "maps/旧导图.shardmap.json",
            SearchKind::Mindmap,
            SearchRevealHint::DocumentOnly,
        ),
        (
            "进度",
            "数据.csv",
            SearchKind::Csv,
            SearchRevealHint::External,
        ),
        (
            "续行",
            "notes/表格/成绩.csv",
            SearchKind::Csv,
            SearchRevealHint::External,
        ),
    ] {
        let result = query(&left, text, 50, false);
        assert_eq!(paths(&result), vec![path], "{text}");
        assert_eq!(result.hits[0].target.kind, kind, "{text}");
        assert_eq!(result.hits[0].reveal_hint, reveal, "{text}");
        assert!(result.hits[0].tags.is_empty());
    }
    let csv = query(&left, "进度", 50, false);
    assert_eq!(csv.hits[0].title, "数据");
    assert_eq!(csv.hits[0].target.object_id, None);
    assert_eq!(
        csv.hits[0].updated_at.as_deref(),
        Some(DateTime::<Utc>::from(fixed_mtime()).to_rfc3339().as_str())
    );
    let map = query(&left, "分支甲", 50, false);
    assert_eq!(map.hits[0].title, "项目导图");
    assert_eq!(map.hits[0].target.object_id.as_deref(), Some("map-1"));
    assert_eq!(
        map.hits[0].updated_at.as_deref(),
        Some("2026-09-25T02:00:00Z")
    );

    // 代码块里的词只能整篇打开。
    let code = query(&left, "代码块里的词", 50, false);
    assert_eq!(paths(&code), vec!["notes/计划/季度计划.md"]);
    assert_eq!(code.hits[0].reveal_hint, SearchRevealHint::DocumentOnly);
    assert_eq!(
        paths(&query(&left, "季度 目标", 50, false)),
        vec!["notes/计划/季度计划.md"]
    );

    // 回收站开关。
    assert_eq!(query(&left, "回收站", 50, false).total, 0);
    let trash = query(&left, "回收站", 50, true);
    assert_eq!(trash.total, 2);
    assert!(trash.hits.iter().all(|hit| hit.target.archived));
    assert!(paths(&trash).contains(&".trash/notes/旧笔记.md"));
    assert!(paths(&trash).contains(&".trash/fragments/2026/09/trash-frag.md"));

    // limit 只截断命中，不截断 total。
    let publish = query(&left, "发布", 1, false);
    assert_eq!(publish.hits.len(), 1);
    assert_eq!(publish.total, 2);
    assert_eq!(query(&left, "发布", 50, false).hits.len(), 2);

    // 隐藏目录、密匣、内部字段都搜不到。
    for text in ["内部", "PRIVATE_MARKER", "secret-root-id", "不存在的词"] {
        assert_eq!(query(&left, text, 50, true).total, 0, "{text}");
    }
}

#[test]
fn dual_read_target_returns_identical_documents_on_fs_and_sqlite() {
    let [fs, sqlite] = TestVault::both();
    seed(&fs);
    seed(&sqlite);
    let snapshot = fs.snapshot();
    let mut markdown_targets = 0;
    for metadata in snapshot.metadata.values() {
        let target = &metadata.target;
        let left = fs.read_target(target);
        let right = sqlite.read_target(target);
        if !is_markdown_target(target) {
            assert_eq!(
                left.unwrap_err(),
                SearchError::UnsupportedTarget,
                "{}",
                target.path
            );
            assert_eq!(
                right.unwrap_err(),
                SearchError::UnsupportedTarget,
                "{}",
                target.path
            );
            continue;
        }
        markdown_targets += 1;
        let (left, right) = (left.unwrap(), right.unwrap());
        assert_eq!(left.projected, right.projected, "{}", target.path);
        // 读出来的投影与快照里的一致。
        let index = snapshot
            .documents
            .binary_search_by(|document| document.stable_key.cmp(&target.key))
            .unwrap();
        assert_eq!(left.projected, snapshot.documents[index]);
        assert_eq!(left.metadata.target, *target);
        assert_eq!(left.metadata.revision, metadata.revision);
        assert_eq!(left.metadata.target, right.metadata.target);
        assert_eq!(left.metadata.revision, right.metadata.revision);
        let left_fragment = serde_json::to_value(left.fragment.unwrap()).unwrap();
        let right_fragment = serde_json::to_value(right.fragment.unwrap()).unwrap();
        assert_eq!(left_fragment, right_fragment, "{}", target.path);
        assert_eq!(left_fragment["path"], json!(target.path));
        assert_eq!(left_fragment["archived"], json!(target.archived));
        assert_eq!(left_fragment["lockbox"], json!(false));
        assert_eq!(left_fragment["gitStatus"], json!("saved"));
        // fileSha 就是原文哈希，等于存储给出的 content_sha。
        for vault in [&fs, &sqlite] {
            let path = vault.path(&target.path);
            let sha = vault.read(|vfs| vfs.content_sha(&path)).unwrap();
            assert_eq!(left_fragment["fileSha"], json!(sha), "{}", vault.name());
        }
    }
    assert_eq!(markdown_targets, 10);

    let property = public_target("notes/属性文档.md", SearchKind::Note, Some("property-note"));
    for vault in [&fs, &sqlite] {
        let fragment = vault.read_target(&property).unwrap().fragment.unwrap();
        assert_eq!(fragment.properties.len(), 1, "{}", vault.name());
        assert_eq!(fragment.properties[0].key, "负责人");
        assert_eq!(
            serde_json::to_value(&fragment.properties[0].value).unwrap(),
            json!({ "kind": "text", "text": "张三" })
        );
        assert_eq!(fragment.content, "# 属性文档\n");
    }
}

#[test]
fn read_target_rejects_bad_targets_with_fixed_codes() {
    for vault in TestVault::both() {
        seed(&vault);
        let name = vault.name();
        let note = public_target(
            "notes/计划/季度计划.md",
            SearchKind::Note,
            Some("note-plan"),
        );
        assert!(vault.read_target(&note).is_ok(), "{name}");

        let other_vault = SearchTarget {
            vault_path: "另一个资料库".into(),
            ..note.clone()
        };
        assert_eq!(
            vault.read_target(&other_vault).unwrap_err(),
            SearchError::VaultChanged,
            "{name}"
        );
        let tampered = SearchTarget {
            path: "notes/文档/说明.md".into(),
            ..note.clone()
        };
        assert_eq!(
            vault.read_target(&tampered).unwrap_err(),
            SearchError::TargetChanged,
            "{name}"
        );
        let lockbox = make_target(
            VAULT_ID,
            SearchScope::Lockbox,
            "lockbox/fragments/2026/09/secret.shard".into(),
            SearchKind::Fragment,
            Some("secret".into()),
            false,
        );
        assert_eq!(
            vault.read_target(&lockbox).unwrap_err(),
            SearchError::UnsupportedTarget,
            "{name}"
        );
        let csv = public_target("数据.csv", SearchKind::Csv, None);
        assert_eq!(
            vault.read_target(&csv).unwrap_err(),
            SearchError::UnsupportedTarget,
            "{name}"
        );
        let flow_file = public_target(
            "notes/流程/上线.shardflow.json",
            SearchKind::Flowchart,
            Some("flow-file-1"),
        );
        assert_eq!(
            vault.read_target(&flow_file).unwrap_err(),
            SearchError::UnsupportedTarget,
            "{name}"
        );

        let invalid = SearchError::InvalidRequest {
            reason: "invalidTargetPath".into(),
        };
        for path in [
            "../outside.md",
            "notes/../notes/计划/季度计划.md",
            "/notes/a.md",
            "notes\\a.md",
            "notes/.隐藏/a.md",
            "assets/a.md",
            "notes/计划/季度计划.txt",
            "",
        ] {
            let target = public_target(path, SearchKind::Note, Some("note-plan"));
            assert_eq!(
                vault.read_target(&target).unwrap_err(),
                invalid,
                "{name} {path:?}"
            );
        }
        let missing = public_target("notes/不存在.md", SearchKind::Note, Some("note-plan"));
        assert_eq!(
            vault.read_target(&missing).unwrap_err(),
            SearchError::NotFound,
            "{name}"
        );
        let broken = public_target("notes/坏文件.md", SearchKind::Note, None);
        assert_eq!(
            vault.read_target(&broken).unwrap_err(),
            SearchError::UnsupportedTarget,
            "{name}"
        );

        // 同一路径换成另一个对象：身份对不上。
        vault.put_markdown(
            "notes/计划/季度计划.md",
            "replacement",
            &["note"],
            "# 新对象",
        );
        assert_eq!(
            vault.read_target(&note).unwrap_err(),
            SearchError::TargetChanged,
            "{name}"
        );
        // 换了类型同样对不上。
        vault.put_markdown(
            "notes/计划/季度计划.md",
            "note-plan",
            &["document"],
            "# 季度计划",
        );
        assert_eq!(
            vault.read_target(&note).unwrap_err(),
            SearchError::TargetChanged,
            "{name}"
        );
    }
}

#[test]
fn enumeration_lists_the_same_sources_on_both_backends() {
    let listings = TestVault::both().map(|vault| {
        seed(&vault);
        let (sources, skipped) = vault.read(|vfs| enumerate_public_sources(vfs)).unwrap();
        let mut listed = sources
            .iter()
            .map(|source| {
                (
                    source.relative.clone(),
                    format!("{:?}", source.kind),
                    source.stamp.len(),
                )
            })
            .collect::<Vec<_>>();
        listed.sort();
        (listed, skipped)
    });
    assert_eq!(listings[0], listings[1]);
    let (listed, skipped) = &listings[0];
    // 枚举阶段只计回收站里的结构化文档；坏文件在投影阶段才计入。
    assert_eq!(*skipped, 1);
    assert_eq!(listed.len(), 18);
    assert!(listed
        .iter()
        .all(|(path, _, _)| !path.starts_with("lockbox") && !path.contains(".隐藏")));
}

#[cfg(unix)]
#[test]
fn fs_symlinks_are_skipped_or_rejected() {
    use std::os::unix::fs::symlink;

    let vault = TestVault::fs();
    seed(&vault);
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("外部.csv"), "外部列\n1\n").unwrap();
    symlink(
        outside.path().join("外部.csv"),
        vault.path("notes/链接.csv"),
    )
    .unwrap();
    symlink(
        vault.path("notes/计划/季度计划.md"),
        vault.path("notes/别名.md"),
    )
    .unwrap();
    std::fs::remove_file(vault.path("maps/旧导图.shardmap.json")).unwrap();
    std::fs::remove_dir(vault.path("maps")).unwrap();
    symlink(vault.path("notes"), vault.path("maps")).unwrap();

    let snapshot = vault.snapshot();
    // 符号链接 CSV 与符号链接 maps 根各计一次；符号链接 Markdown 在目录遍历时就被略过。
    assert_eq!(snapshot.skipped_files, 3 + 2);
    assert!(snapshot.metadata.values().all(|metadata| {
        !metadata.target.path.contains("链接")
            && !metadata.target.path.contains("别名")
            && !metadata.target.path.starts_with("maps/")
    }));
    assert_eq!(query(&snapshot, "外部列", 50, true).total, 0);

    let alias = public_target("notes/别名.md", SearchKind::Note, Some("note-plan"));
    assert_eq!(
        vault.read_target(&alias).unwrap_err(),
        SearchError::InvalidRequest {
            reason: "symlinkTarget".into()
        }
    );
}

#[test]
fn markdown_projection_details() {
    for vault in TestVault::both() {
        seed(&vault);
        let snapshot = vault.snapshot();
        let document = |path: &str| {
            let key = target_key(VAULT_ID, &SearchScope::Public, path);
            snapshot
                .documents
                .iter()
                .find(|document| document.stable_key == key)
                .unwrap()
                .clone()
        };

        let outline = document("fragments/2026/09/outline.md");
        assert_eq!(outline.title, "路线规划");
        assert!(matches!(
            outline.projection.blocks.as_slice(),
            [SearchProjectionBlock::DocumentOnly { .. }]
        ));
        for text in ["路线规划", "预订车票", "确认乘车时间"] {
            assert!(outline.projection.searchable_text.contains(text), "{text}");
            let result = shard_core::search::scan_exact(
                std::slice::from_ref(&outline),
                &ParsedQuery::parse(text).unwrap(),
                10,
            );
            assert_eq!(result.matches[0].location, MatchLocation::DocumentOnly);
        }
        assert!(!outline
            .projection
            .searchable_text
            .contains("不作为 md 标题"));

        let flow = document("fragments/2026/09/flow.md");
        assert_eq!(flow.title, "发布流程");
        assert!(matches!(
            flow.projection.blocks.as_slice(),
            [SearchProjectionBlock::DocumentOnly { .. }]
        ));

        let readme = document("notes/文档/说明.md");
        assert_eq!(readme.title, "使用说明");
        assert_eq!(
            readme.modified_at,
            parse_modified_at("2026-09-25T01:00:00Z")
        );

        let reading = document("fragments/2026/09/frag-reading.md");
        assert_eq!(reading.title, "今天读完《深度工作》第三章。");
        let expected = project_document(&SourceDocument {
            stable_key: reading.stable_key.clone(),
            title: reading.title.clone(),
            tags: vec!["inbox".into()],
            body: "今天读完《深度工作》第三章。\n\n记下要点：专注时间要成块。\n".into(),
            modified_at: parse_modified_at("2026-09-25T01:00:00Z"),
        });
        assert_eq!(reading, expected, "{}", vault.name());
    }
}

#[test]
fn markdown_titles_follow_type_rules() {
    assert_eq!(
        markdown_title(&SearchKind::Note, "前言\n# 正式标题 #\n"),
        "正式标题"
    );
    assert_eq!(markdown_title(&SearchKind::Note, "\n\n第一行\n"), "第一行");
    assert_eq!(markdown_title(&SearchKind::Note, ""), "未命名笔记");
    assert_eq!(
        markdown_title(&SearchKind::Document, "正文\n### 三级标题\n"),
        "三级标题"
    );
    assert_eq!(
        markdown_title(&SearchKind::Document, "#没有空格"),
        "#没有空格"
    );
    assert_eq!(markdown_title(&SearchKind::Document, ""), "未命名文档");
    assert_eq!(
        markdown_title(&SearchKind::Outline, "  - 根节点\n  - 子"),
        "根节点"
    );
    assert_eq!(
        markdown_title(&SearchKind::Outline, "12. 编号节点"),
        "编号节点"
    );
    assert_eq!(markdown_title(&SearchKind::Outline, "- "), "-");
    assert_eq!(markdown_title(&SearchKind::Outline, "\n  \n"), "未命名大纲");
    assert_eq!(
        markdown_title(&SearchKind::Fragment, "  碎片第一行  \n第二行"),
        "碎片第一行"
    );
    assert_eq!(markdown_title(&SearchKind::Fragment, "\n"), "未命名碎片");
    let long = "长".repeat(60);
    assert_eq!(
        markdown_title(&SearchKind::Note, &long),
        format!("{}…", "长".repeat(48))
    );
    assert_eq!(
        markdown_title(&SearchKind::Document, &long),
        format!("{}…", "长".repeat(40))
    );
    assert_eq!(markdown_title(&SearchKind::Fragment, &long), long);
}

#[test]
fn markdown_type_priority_matches_core_contract() {
    let tags = ["document", "flowchart", "outline", "note"].map(str::to_string);
    assert_eq!(markdown_kind(&tags), SearchKind::Note);
    assert_eq!(
        markdown_kind(&["document".into(), "flowchart".into()]),
        SearchKind::Flowchart
    );
    assert_eq!(markdown_kind(&["随便".into()]), SearchKind::Fragment);
    assert_eq!(markdown_kind(&[]), SearchKind::Fragment);
}

/// 迁移前 src-tauri 的逐字节实现（`BufReader` + `fill_buf` 窥视），用来比对新的分段读取。
fn reference_csv_header_bytes(file: &[u8]) -> Result<Vec<u8>, SearchError> {
    let mut reader = BufReader::new(Cursor::new(file.to_vec()));
    let mut bytes = Vec::new();
    let mut quoted = false;
    let mut field_start = true;

    if reader.fill_buf().unwrap().starts_with(&[0xef, 0xbb, 0xbf]) {
        bytes.extend_from_slice(&[0xef, 0xbb, 0xbf]);
        reader.consume(3);
    }

    loop {
        if bytes.len() as u64 >= CSV_HEADER_MAX_BYTES {
            return Err(SearchError::UnsupportedTarget);
        }
        let mut byte = [0u8; 1];
        if reader.read(&mut byte).unwrap() == 0 {
            return if quoted {
                Err(SearchError::UnsupportedTarget)
            } else {
                Ok(bytes)
            };
        }
        bytes.push(byte[0]);

        if quoted {
            if byte[0] == b'"' {
                let next = reader.fill_buf().unwrap();
                if next.first() == Some(&b'"') {
                    if bytes.len() as u64 >= CSV_HEADER_MAX_BYTES {
                        return Err(SearchError::UnsupportedTarget);
                    }
                    bytes.push(b'"');
                    reader.consume(1);
                } else {
                    quoted = false;
                }
            }
            continue;
        }

        match byte[0] {
            b'"' if field_start => {
                quoted = true;
                field_start = false;
            }
            b',' => field_start = true,
            b'\r' | b'\n' => return Ok(bytes),
            _ => field_start = false,
        }
    }
}

fn csv_header_cases() -> Vec<Vec<u8>> {
    let mut cases: Vec<Vec<u8>> = vec![
        b"".to_vec(),
        b"a,b,c".to_vec(),
        b"a,b\nc,d".to_vec(),
        b"a,b\r\nc,d".to_vec(),
        "\u{feff}姓名,\"说明\n续行\",\"他说 \"\"你好\"\"\"\r\n张三,x,y"
            .as_bytes()
            .to_vec(),
        b"\"unterminated,a\nb".to_vec(),
        b"\"\"".to_vec(),
        b"\"a\"\"".to_vec(),
        b"a\"b,\"c\"\n".to_vec(),
        vec![0xef, 0xbb],
        vec![0xef, 0xbb, 0xbf],
    ];
    // 跨 8 KiB 边界：被转义的引号对正好劈在第一次读取的末尾。
    for k in [8188usize, 8189, 8190, 8191, 8192] {
        let mut case = b"\"".to_vec();
        case.extend(std::iter::repeat_n(b'a', k));
        case.extend_from_slice(b"\"\"b\",x\nrest");
        cases.push(case);
    }
    // 第一口正好读满 8 KiB、没有换行。
    cases.push(vec![b'a'; 8192]);
    cases.push(vec![b'a'; 8191]);
    cases.push(vec![b'a'; 8193]);
    // 表头恰在 1 MiB 上下。
    let max = CSV_HEADER_MAX_BYTES as usize;
    for length in [max - 2, max - 1, max, max + 1] {
        let mut case = vec![b'x'; length];
        case.push(b'\n');
        cases.push(case);
    }
    let mut quoted_huge = b"\"".to_vec();
    quoted_huge.extend(std::iter::repeat_n(b'q', max + 10));
    cases.push(quoted_huge);
    // 伪随机：引号、逗号、换行混排，长度覆盖 8 KiB 边界两侧。
    let mut seed = 0x5eed_u64;
    let mut next = || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        seed
    };
    for _ in 0..300 {
        let length = (next() % 20_000) as usize;
        let newline_rare = next() % 2 == 0;
        let mut case = Vec::with_capacity(length + 3);
        if next() % 4 == 0 {
            case.extend_from_slice(&[0xef, 0xbb, 0xbf]);
        }
        for _ in 0..length {
            let roll = next() % 100;
            case.push(match roll {
                0..=9 => b'"',
                10..=14 => b',',
                15 if !newline_rare => b'\n',
                16 if !newline_rare => b'\r',
                _ => b'a' + (roll % 26) as u8,
            });
        }
        cases.push(case);
    }
    cases
}

#[test]
fn csv_header_reading_matches_the_previous_byte_reader() {
    let cases = csv_header_cases();
    for vault in TestVault::both() {
        for (index, case) in cases.iter().enumerate() {
            let relative = format!("notes/表头/{index}.csv");
            vault.put(&relative, case);
            let path = vault.path(&relative);
            let actual = vault.read(|vfs| read_csv_header_bytes(vfs, &path));
            assert_eq!(
                actual,
                reference_csv_header_bytes(case),
                "{} 第 {index} 例（{} 字节）",
                vault.name(),
                case.len()
            );
        }
    }
}

#[test]
fn csv_header_parsing_supports_quotes_bom_and_newlines() {
    let header = parse_csv_header(
        "\u{feff}姓名,\"说明\n续行\",\"他说 \"\"你好\"\"\"\r\n张三,ignored,ignored".as_bytes(),
    )
    .unwrap();
    assert_eq!(header, vec!["姓名", "说明\n续行", "他说 \"你好\""]);
    assert!(parse_csv_header(b"\"unterminated").is_err());
    assert!(parse_csv_header(&[0xff, 0xfe]).is_err());

    for vault in TestVault::both() {
        vault.put(
            "quoted.csv",
            "\u{feff}\"首列\n续行\",第二列\r\n正文不应读取到表头".as_bytes(),
        );
        let path = vault.path("quoted.csv");
        let bytes = vault.read(|vfs| read_csv_header_bytes(vfs, &path)).unwrap();
        assert_eq!(
            parse_csv_header(&bytes).unwrap(),
            vec!["首列\n续行", "第二列"],
            "{}",
            vault.name()
        );
    }
}

#[test]
fn unreadable_csv_counts_as_skipped() {
    for vault in TestVault::both() {
        vault.put_text("好.csv", "列一\n");
        vault.put("非 UTF-8.csv", &[0xff, 0xfe, b'\n']);
        vault.put_text("未闭合.csv", "\"列一\n");
        let mut huge = vec![b'x'; CSV_HEADER_MAX_BYTES as usize + 1];
        huge.push(b'\n');
        vault.put("超长表头.csv", &huge);
        let snapshot = vault.snapshot();
        assert_eq!(snapshot.documents.len(), 1, "{}", vault.name());
        assert_eq!(snapshot.skipped_files, 3, "{}", vault.name());
    }
}

#[test]
fn empty_vault_builds_an_empty_snapshot() {
    for vault in TestVault::both() {
        let snapshot = vault.snapshot();
        assert!(snapshot.documents.is_empty(), "{}", vault.name());
        assert!(snapshot.metadata.is_empty());
        assert_eq!(snapshot.skipped_files, 0);
        assert_eq!(snapshot.source_stamp, crate::hash_text("skipped:0"));
        assert_eq!(query(&snapshot, "任何", 50, true).total, 0);
    }
}

#[test]
fn snapshot_stamp_and_id_follow_content() {
    let vault = TestVault::sqlite();
    seed(&vault);
    let first = vault.snapshot();
    let context = SearchContext {
        vault_path: VAULT_ID.into(),
        vault_epoch: "1".into(),
        privacy_epoch: "0".into(),
    };
    let id = snapshot_id(&context, &SearchScope::Public, &first.source_stamp);
    assert_eq!(
        id,
        snapshot_id(
            &context,
            &SearchScope::Public,
            &vault.snapshot().source_stamp
        )
    );
    assert_ne!(
        id,
        snapshot_id(&context, &SearchScope::Lockbox, &first.source_stamp)
    );
    let next_epoch = SearchContext {
        vault_epoch: "2".into(),
        ..context.clone()
    };
    assert_ne!(
        id,
        snapshot_id(&next_epoch, &SearchScope::Public, &first.source_stamp)
    );

    vault.put_markdown(
        "notes/计划/季度计划.md",
        "note-plan",
        &["note", "工作"],
        "# 季度计划\n\n改过的正文",
    );
    let second = vault.snapshot();
    assert_ne!(first.source_stamp, second.source_stamp);
    assert_eq!(query(&second, "改过的正文", 50, false).total, 1);
    assert_eq!(query(&first, "改过的正文", 50, false).total, 0);
}

#[test]
fn request_validation_and_query_parsing_use_fixed_reason_codes() {
    let request = SearchVaultRequest {
        client_request_id: "request-1".into(),
        expected_vault_path: VAULT_ID.into(),
        context: None,
        scope: SearchScope::Public,
        include_trash: false,
        query_version: SEARCH_WIRE_VERSION,
        projection_version: SEARCH_WIRE_VERSION,
        query: "计划".into(),
        limit: 50,
        refresh: SearchRefresh::Auto,
    };
    assert_eq!(validate_search_request(&request), Ok(()));
    let reason = |request: SearchVaultRequest| match validate_search_request(&request) {
        Err(SearchError::InvalidRequest { reason }) => reason,
        other => panic!("{other:?}"),
    };
    assert_eq!(
        reason(SearchVaultRequest {
            client_request_id: "  ".into(),
            ..request.clone()
        }),
        "missingClientRequestId"
    );
    assert_eq!(
        reason(SearchVaultRequest {
            query_version: 2,
            ..request.clone()
        }),
        "unsupportedQueryVersion"
    );
    assert_eq!(
        reason(SearchVaultRequest {
            projection_version: 0,
            ..request.clone()
        }),
        "unsupportedProjectionVersion"
    );
    assert_eq!(
        reason(SearchVaultRequest {
            limit: 0,
            ..request.clone()
        }),
        "invalidLimit"
    );
    assert_eq!(
        reason(SearchVaultRequest {
            limit: SEARCH_LIMIT_MAX + 1,
            ..request.clone()
        }),
        "invalidLimit"
    );
    assert_eq!(
        validate_search_request(&SearchVaultRequest {
            limit: SEARCH_LIMIT_MAX,
            ..request
        }),
        Ok(())
    );

    assert_eq!(
        parse_search_query(&"长".repeat(257)).unwrap_err(),
        invalid_request("queryTooLong")
    );
    assert_eq!(
        parse_search_query("a b c d e f g h i").unwrap_err(),
        invalid_request("tooManyTerms")
    );
    assert_eq!(
        parse_search_query("  计划   计划 ").unwrap().terms,
        vec!["计划".to_string()]
    );
}

#[test]
fn scan_reports_internal_error_when_metadata_is_missing() {
    let vault = TestVault::fs();
    seed(&vault);
    let mut snapshot = vault.snapshot();
    let key = target_key(VAULT_ID, &SearchScope::Public, "notes/计划/季度计划.md");
    snapshot.metadata.remove(&key);
    // 不含回收站时缺元数据的文档被过滤掉；含回收站时扫到它就是内部错误。
    assert_eq!(query(&snapshot, "季度", 50, false).total, 0);
    assert_eq!(
        snapshot
            .search(&parse_search_query("季度").unwrap(), 50, true)
            .unwrap_err(),
        SearchError::Internal { retryable: false }
    );
}

#[test]
fn reads_never_write_to_the_store() {
    // SqliteVfs 的只读事务拒绝一切写入：构建快照与读取目标都在只读事务里完成即为证明。
    let vault = TestVault::sqlite();
    seed(&vault);
    let snapshot = vault.snapshot();
    for metadata in snapshot
        .metadata
        .values()
        .filter(|metadata| is_markdown_target(&metadata.target))
    {
        vault.read_target(&metadata.target).unwrap();
    }
    let probe = vault.path("notes/探针.md");
    assert!(vault.read(|vfs| vfs.write_atomic(&probe, b"x")).is_err());
}
