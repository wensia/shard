//! 远程模式下各命令的实现：参数解析、校验与输出和本地模式一样（`agent`、`find`、`graph` 里的函数），
//! 只是读写换成服务器 RPC。服务器响应一律反序列化成有类型的结构体，缺字段报 `BAD_RESPONSE`。
//!
//! | CLI | RPC |
//! |---|---|
//! | 新建碎片 | `create_fragment`（给了 `--source` 时带 `source`） |
//! | `-s` | `search_vault`（不带关键词时 `list_documents` 按最近修改列出） |
//! | `--read` | `read_document` |
//! | `--update --expect` | `rewrite_document`（服务端一个事务里核对 sha 并改写，规则同本地） |
//! | `--append` | `append_document`（服务端一个事务里读改写） |
//! | `--note` | `create_note` |
//! | `--tags` / `--ls` | `list_tags` / `list_library` |
//! | `--read-dataset` / `--create-dataset` / `--append-dataset` | `read_dataset` / `create_library_dataset`（带 `--folder` 时先 `ensure_library_folder`）/ `append_dataset_records` |
//! | `--graph-*` | `read_graph_fragment` → 本地改节点 → `write_graph_fragment`（带 expected 基线） |
//! | `-i` / `-e` | `list_documents`（带正文）→ 本地搜索与编辑 → `read_document` / `rewrite_document` 带 sha 写回 |

use super::{decode, IntoCli, Remote, RemoteError};
use crate::{
    agent::{
        self, note_parts, print_created, print_created_dataset, print_dataset, print_document, print_library,
        print_rewrite, print_tags, read_addition, read_create_dataset_input, read_update_body, STALE_REWRITE_MESSAGE,
    },
    edit,
    find::{self, FragmentEntry, Hit},
    graph::{self, GraphCommand, GraphFile, GraphKind},
    tui::app::{SaveError, SaveReport, Store},
    AppendInput, CliError,
};
use serde::Deserialize;
use serde_json::{json, Value};
use shard_core::{
    dataset::DatasetSnapshot,
    search::{ParsedQuery, SearchTextPart},
};
use shard_vault::{
    cli::{
        library_folder, normalize_body, prepare_note, CreatedNote, DatasetAppended, DocumentView, LibraryItem,
        RewriteReport, TagCount, TextDocument, TextEntry,
    },
    search::{SearchHit, SearchKind, SEARCH_LIMIT_MAX},
};
use std::{collections::HashMap, thread, time::Duration};

/// 「上次搜索」的归属：服务器地址。
pub fn scope(remote: &Remote) -> String {
    remote.server().to_string()
}

// ---------------------------------------------------------------------------
// 服务器响应的类型（只取用到的字段）
// ---------------------------------------------------------------------------

/// 桌面 `Fragment` DTO 里命令行用到的部分。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FragmentDto {
    id: String,
    path: String,
    file_sha: String,
    tags: Vec<String>,
    #[serde(default)]
    archived: bool,
}

#[derive(Deserialize)]
struct GraphResult {
    fragment: FragmentDto,
    graph: Value,
}

#[derive(Deserialize)]
struct PathAndSha {
    path: String,
    sha: String,
}

#[derive(Deserialize)]
struct PathOnly {
    path: String,
}

#[derive(Deserialize)]
struct LibraryWithNote {
    fragment: PathOnly,
}

#[derive(Deserialize)]
struct LibraryDatasetDto {
    dataset: PathAndSha,
    library: LibraryWithNote,
}

#[derive(Deserialize)]
struct DocumentList {
    total: usize,
    documents: Vec<TextDocument>,
}

#[derive(Deserialize)]
struct ServerStatus {
    vault: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchResponse {
    index_state: String,
    snapshot_id: Option<String>,
    hits: Vec<SearchHit>,
    total: Option<u32>,
}

/// 目标是上次搜索的序号时换成 id（序号是本机状态，服务器不知道）；其余原样交给服务器解析。
fn remote_target(remote: &Remote, target: &str) -> String {
    recalled_id(remote, target).unwrap_or_else(|| target.trim().to_string())
}

fn recalled_id(remote: &Remote, target: &str) -> Option<String> {
    let index = target.trim().parse::<usize>().ok()?;
    let ids = find::recall_search(&scope(remote))?;
    (1..=ids.len()).contains(&index).then(|| ids[index - 1].clone())
}

fn read_document(remote: &Remote, target: &str) -> Result<DocumentView, CliError> {
    decode(remote.read("read_document", json!({ "target": target }))?, "文档")
}

fn entry_from_document(document: DocumentView) -> FragmentEntry {
    TextDocument {
        id: document.id,
        path: document.path,
        title: document.title,
        kind: document.kind,
        tags: if document.tags.is_empty() { vec!["inbox".to_string()] } else { document.tags },
        created_at: document.created_at,
        updated_at: document.updated_at,
        body: Some(document.body),
    }
    .into_entry()
}

// ---------------------------------------------------------------------------
// 新建碎片与非交互命令
// ---------------------------------------------------------------------------

/// 新建碎片（`create_fragment`）。`body`、`tags` 已按速记规则整理，与本地模式写入的内容相同。
pub fn create_fragment(
    remote: &Remote,
    body: &str,
    tags: Vec<String>,
    source: Option<String>,
    json: bool,
) -> Result<(), CliError> {
    let fragment: FragmentDto = decode(
        remote.write("create_fragment", json!({ "content": body, "tags": tags, "source": source }))?,
        "新建结果",
    )?;
    print_created(json, &fragment.id, &fragment.path, &fragment.file_sha, &fragment.tags);
    Ok(())
}

pub fn run_agent(
    command: agent::Command,
    remote: &Remote,
    json: bool,
    source: Option<String>,
) -> Result<(), CliError> {
    match command {
        agent::Command::Read { target } => {
            print_document(json, &read_document(remote, &remote_target(remote, &target))?);
            Ok(())
        }
        agent::Command::Update { target, expect } => {
            let body = read_update_body()?;
            let args = json!({ "target": remote_target(remote, &target), "body": body, "expectedSha": expect });
            let report: RewriteReport = decode(
                remote.write("rewrite_document", args).map_err(stale_as(STALE_REWRITE_MESSAGE))?,
                "改写结果",
            )?;
            print_rewrite(json, &report);
            Ok(())
        }
        agent::Command::Append { target, expect, content } => {
            let addition = read_addition(&content)?;
            let args = json!({ "target": remote_target(remote, &target), "text": addition, "expectedSha": expect });
            let report: RewriteReport = decode(
                remote.write("append_document", args).map_err(stale_as(STALE_REWRITE_MESSAGE))?,
                "追加结果",
            )?;
            print_rewrite(json, &report);
            Ok(())
        }
        agent::Command::Note { title, folder, content } => {
            let (body, tags) = note_parts(&content)?;
            // 发请求前按同一份规则校验（手写 frontmatter、密匣），出错与本地模式同一条报错。
            prepare_note(&title, &body, tags.clone())?;
            let args = json!({ "title": title, "folder": folder, "body": body, "tags": tags, "source": source });
            let created: CreatedNote = decode(remote.write("create_note", args)?, "笔记")?;
            print_created(json, &created.id, &created.path, &created.sha, &created.tags);
            Ok(())
        }
        agent::Command::Tags => {
            let counts: Vec<TagCount> = decode(remote.read("list_tags", json!({}))?, "标签")?;
            print_tags(json, &counts);
            Ok(())
        }
        agent::Command::List { folder } => {
            let items: Vec<LibraryItem> =
                decode(remote.read("list_library", json!({ "folder": folder }))?, "目录")?;
            print_library(json, &items);
            Ok(())
        }
        agent::Command::ReadDataset { path } => {
            let snapshot: DatasetSnapshot =
                decode(remote.read("read_dataset", json!({ "path": path }))?, "数据集")?;
            print_dataset(json, &snapshot)
        }
        agent::Command::CreateDataset { title, folder } => {
            let input = read_create_dataset_input()?;
            let parent = library_folder(folder.as_deref());
            if let Some(parent) = &parent {
                remote.write("ensure_library_folder", json!({ "folder": parent }))?;
            }
            let created: LibraryDatasetDto = decode(
                remote.write(
                    "create_library_dataset",
                    json!({
                        "title": title,
                        "header": input.header,
                        "rows": input.rows,
                        "primaryKey": input.primary_key,
                        "parentPath": parent,
                        "source": source,
                    }),
                )?,
                "数据集",
            )?;
            print_created_dataset(json, &created.dataset.path, &created.dataset.sha, &created.library.fragment.path);
            Ok(())
        }
    }
}

/// 基线过期（409 STALE_BASE）→ `CONFLICT`（退出码 2），消息用本地模式同一句。
fn stale_as(message: &'static str) -> impl Fn(RemoteError) -> CliError {
    move |error| {
        if error.is("STALE_BASE") {
            CliError::new("CONFLICT", message)
        } else {
            error.into_cli()
        }
    }
}

/// `--append-dataset`：按主键幂等追加（`append_dataset_records`），输出与本地模式相同的一行 JSON。
pub fn append_dataset(remote: &Remote, path: &str, request: AppendInput) -> Result<(), CliError> {
    let appended: DatasetAppended = decode(
        remote.write(
            "append_dataset_records",
            json!({ "path": path, "expectedHeader": request.expected_header, "records": request.records }),
        )?,
        "追加结果",
    )?;
    println!(
        "{}",
        json!({ "appended": appended.appended, "skipped": appended.skipped, "sha": appended.sha })
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// 大纲与流程图：读 → 本地改 → 带 expected 基线写回
// ---------------------------------------------------------------------------

struct RemoteGraph {
    kind: GraphKind,
    graph: GraphFile,
    file_sha: String,
}

/// 读图；`expected` 给了表示要写：必须是活跃的公开碎片（不在回收站），sha 与基线一致，
/// 当前图的 id 与类型与碎片一致——与本地模式写前的检查相同。
fn load_graph(remote: &Remote, fragment_id: &str, expected: Option<&str>) -> Result<RemoteGraph, CliError> {
    let result: GraphResult = decode(remote.read("read_graph_fragment", json!({ "id": fragment_id }))?, "图")?;
    if expected.is_some() && result.fragment.archived {
        return Err(format!("找不到公开片段 {fragment_id}").into());
    }
    if expected.is_some_and(|expected| expected != result.fragment.file_sha) {
        return Err(CliError::new("CONFLICT", graph::STALE_MESSAGE));
    }
    let kind = GraphKind::from_tags(&result.fragment.tags)?;
    let graph = graph::parse_graph(kind, result.graph)?;
    if expected.is_some() {
        let consistent = match &graph {
            GraphFile::Outline(file) => file.id == fragment_id && file.kind == "shard.map",
            GraphFile::Flowchart(file) => file.id == fragment_id && file.kind == "shard.flow",
        };
        if !consistent {
            return Err(match kind {
                GraphKind::Outline => "大纲 graph 的 id 或类型与碎片不一致。",
                GraphKind::Flowchart => "流程图 graph 的 id 或类型与碎片不一致。",
            }
            .into());
        }
    }
    Ok(RemoteGraph { kind, graph, file_sha: result.fragment.file_sha })
}

fn save_graph(remote: &Remote, fragment_id: &str, graph: &GraphFile, expected: &str) -> Result<String, CliError> {
    let value = graph::graph_value(graph)?;
    let result: GraphResult = decode(
        remote
            .write(
                "write_graph_fragment",
                json!({ "id": fragment_id, "graph": value, "expectedFileSha": expected }),
            )
            .map_err(stale_as(graph::STALE_MESSAGE))?,
        "图",
    )?;
    Ok(result.fragment.file_sha)
}

pub fn run_graph(command: GraphCommand, remote: &Remote) -> Result<(), CliError> {
    match command {
        GraphCommand::Read { fragment_id } => {
            let loaded = load_graph(remote, &fragment_id, None)?;
            println!(
                "{}",
                json!({
                    "id": fragment_id,
                    "kind": loaded.kind.name(),
                    "fileSha": loaded.file_sha,
                    "graph": graph::graph_value(&loaded.graph)?,
                })
            );
        }
        GraphCommand::Outline { fragment_id } => {
            let loaded = load_graph(remote, &fragment_id, None)?;
            let GraphFile::Outline(file) = loaded.graph else {
                return Err("目标不是大纲。".into());
            };
            print!("{}", graph::serialize_outline(&file));
            if !file.nodes.is_empty() {
                println!();
            }
        }
        GraphCommand::Write { fragment_id, expect } => {
            let value = graph::read_stdin_json()?;
            let loaded = load_graph(remote, &fragment_id, Some(&expect))?;
            let submitted = graph::parse_submitted_graph(loaded.kind, &fragment_id, value)?;
            let file_sha = save_graph(remote, &fragment_id, &submitted, &expect)?;
            println!("{}", json!({ "fileSha": file_sha }));
        }
        GraphCommand::SetText { fragment_id, node_id, text, expect } => {
            let mut loaded = load_graph(remote, &fragment_id, Some(&expect))?;
            graph::set_node_text(&mut loaded.graph, &node_id, text)?;
            let file_sha = save_graph(remote, &fragment_id, &loaded.graph, &expect)?;
            println!("{}", json!({ "fileSha": file_sha }));
        }
        GraphCommand::AddChild { fragment_id, parent_id, text, expect } => {
            let mut loaded = load_graph(remote, &fragment_id, Some(&expect))?;
            let node_id = graph::add_outline_child(&mut loaded.graph, &parent_id, text)?;
            let file_sha = save_graph(remote, &fragment_id, &loaded.graph, &expect)?;
            println!("{}", json!({ "nodeId": node_id, "fileSha": file_sha }));
        }
        GraphCommand::Remove { fragment_id, node_id, expect } => {
            let mut loaded = load_graph(remote, &fragment_id, Some(&expect))?;
            graph::remove_outline_node(&mut loaded.graph, &node_id)?;
            let file_sha = save_graph(remote, &fragment_id, &loaded.graph, &expect)?;
            println!("{}", json!({ "fileSha": file_sha }));
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 搜索与选择
// ---------------------------------------------------------------------------

/// 全部文本条目（带正文），给交互界面与 `-e` 的关键词选择在本地搜索。
pub fn load_entries(remote: &Remote) -> Result<Vec<FragmentEntry>, CliError> {
    list_documents(remote, true, None).map(|(_, entries)| entries)
}

fn list_documents(
    remote: &Remote,
    with_body: bool,
    limit: Option<usize>,
) -> Result<(usize, Vec<FragmentEntry>), CliError> {
    let list: DocumentList =
        decode(remote.read("list_documents", json!({ "withBody": with_body, "limit": limit }))?, "文档列表")?;
    Ok((list.total, list.documents.into_iter().map(TextDocument::into_entry).collect()))
}

/// `-e` 在非终端里（外部编辑器）不必先下载整个资料库：目标确定时只取这一篇。规则与本地 `find::select`
/// 的前几步一致——不带参数取最近修改的一条；单个参数是上次搜索的序号、完整 id，或 id 中至少 4 个字符
/// 且唯一的片段。其余（关键词、多个词、找不到或歧义）返回 `None`，由调用方取全量后按关键词选择。
pub fn quick_entry(remote: &Remote, terms: &[String]) -> Result<Option<FragmentEntry>, CliError> {
    match terms {
        [] => Ok(list_documents(remote, false, Some(1))?.1.into_iter().next()),
        [token] => {
            if let Some(id) = recalled_id(remote, token) {
                return match read_document(remote, &id) {
                    Ok(document) => Ok(Some(entry_from_document(document))),
                    Err(error) if error.kind == "NOT_FOUND" => {
                        Err(format!("上次搜索的第 {} 条已不存在（可能被删除或移入密匣）", token.trim()).into())
                    }
                    Err(error) => Err(error),
                };
            }
            let document = match read_document(remote, token) {
                Ok(document) => document,
                Err(error) if matches!(error.kind, "NOT_FOUND" | "AMBIGUOUS") => return Ok(None),
                Err(error) => return Err(error),
            };
            let needle = token.to_lowercase();
            let by_id = document.id == *token
                || (needle.chars().count() >= 4 && document.id.to_lowercase().contains(&needle));
            Ok(by_id.then(|| entry_from_document(document)))
        }
        _ => Ok(None),
    }
}

/// `-s`：有关键词时调服务器搜索（`search_vault`，匹配与排序同 App），只保留碎片、笔记、文档；
/// 没有关键词时按最近修改列出。输出与本地模式相同；JSON 里的 `createdAt` 服务器搜索不提供，为 null。
pub fn search(remote: &Remote, query: &str, limit: usize, json: bool) -> Result<(), CliError> {
    let parsed = ParsedQuery::parse(query).map_err(|error| error.to_string())?;
    let (entries, previews, total, created_known) = if parsed.is_empty() {
        let (total, entries) = list_documents(remote, false, Some(limit))?;
        let previews = entries
            .iter()
            .map(|entry| vec![SearchTextPart { text: entry.title.clone(), hit: false }])
            .collect::<Vec<_>>();
        (entries, previews, total, true)
    } else {
        let (entries, previews, total) = search_vault(remote, query, limit)?;
        (entries, previews, total, false)
    };
    let hits = entries
        .iter()
        .zip(previews)
        .map(|(entry, preview)| Hit { entry, preview })
        .collect::<Vec<_>>();
    if json {
        println!("{}", hits_json(&hits, created_known));
        return Ok(());
    }
    find::print_hits(&scope(remote), query, &hits, total)?;
    Ok(())
}

type SearchRows = (Vec<FragmentEntry>, Vec<Vec<SearchTextPart>>, usize);

fn search_once(remote: &Remote, vault: &str, query: &str, requested: usize) -> Result<SearchResponse, CliError> {
    let mut attempt = 0;
    loop {
        let request = json!({
            "request": {
                "clientRequestId": super::idempotency_key(),
                "expectedVaultPath": vault,
                "context": null,
                "scope": "public",
                "includeTrash": false,
                "queryVersion": 1,
                "projectionVersion": 1,
                "query": query,
                "limit": requested,
                "refresh": "auto",
            }
        });
        let response: SearchResponse =
            decode(remote.read("search_vault", request).map_err(search_error)?, "搜索结果")?;
        // 索引还在建：快照出来之前没有结果，稍等再问（最多约 10 秒）。
        if response.index_state == "indexing" && response.snapshot_id.is_none() {
            attempt += 1;
            if attempt > 20 {
                return Err("服务器正在建立搜索索引，请稍后再试。".into());
            }
            thread::sleep(Duration::from_millis(500));
            continue;
        }
        return Ok(response);
    }
}

fn text_kind(hit: &SearchHit) -> Option<Option<&'static str>> {
    match hit.target.kind {
        SearchKind::Fragment => Some(None),
        SearchKind::Note => Some(Some("note")),
        SearchKind::Document => Some(Some("document")),
        _ => None,
    }
}

fn search_vault(remote: &Remote, query: &str, limit: usize) -> Result<SearchRows, CliError> {
    let status: ServerStatus = decode(remote.read("server_status", json!({}))?, "服务器状态")?;
    let maximum = SEARCH_LIMIT_MAX as usize;
    // 服务器搜索还会返回导图、画布、CSV 等，过滤后可能不够数：先多取一些，不够再翻倍（服务端上限内）。
    let mut requested = (limit + 50).min(maximum);
    let response = loop {
        let response = search_once(remote, &status.vault, query, requested)?;
        let usable = response
            .hits
            .iter()
            .filter(|hit| text_kind(hit).is_some() && hit.target.object_id.is_some() && !hit.target.archived)
            .count();
        let exhausted = response.hits.len() < requested;
        if usable >= limit || exhausted || requested >= maximum {
            break response;
        }
        requested = (requested * 2).min(maximum);
    };

    let returned = response.hits.len();
    let mut excluded = 0usize;
    let mut entries = Vec::new();
    let mut previews = Vec::new();
    for hit in response.hits {
        let (Some(kind), Some(id)) = (text_kind(&hit), hit.target.object_id.clone()) else {
            excluded += 1;
            continue;
        };
        if hit.target.archived || id.is_empty() {
            excluded += 1;
            continue;
        }
        if entries.len() == limit {
            continue;
        }
        let parts = |parts: &[shard_vault::search::SearchTextPart]| -> Vec<SearchTextPart> {
            parts.iter().map(|part| SearchTextPart { text: part.text.clone(), hit: part.hit }).collect()
        };
        previews.push(if hit.preview.is_empty() { parts(&hit.title_parts) } else { parts(&hit.preview) });
        let updated_at = hit.updated_at.clone().unwrap_or_default();
        entries.push(TextEntry {
            id,
            path: hit.target.path.clone(),
            title: hit.title.clone(),
            // 搜索结果没有创建时间：终端列表里的日期显示为最近修改时间。
            created_at: updated_at.clone(),
            modified_at: shard_vault::cli::parse_millis(&updated_at),
            updated_at,
            kind,
            tags: hit.tags.clone(),
            body: String::new(),
        });
    }
    let total = match response.total.map(|total| total as usize) {
        // 服务器把全部命中都给了：过滤后的条数就是准确总数。
        Some(total) if total <= returned => total.saturating_sub(excluded).max(entries.len()),
        Some(total) => total.saturating_sub(excluded).max(entries.len()),
        None => entries.len(),
    };
    Ok((entries, previews, total))
}

/// 搜索契约的错误码（`SearchError`）→ 给人看的一句话；其余按通用规则映射。
fn search_error(error: RemoteError) -> CliError {
    let message = match error.code.as_str() {
        "invalidRequest" => format!("搜索请求无效（{}）", error.message),
        "vaultChanged" | "contextExpired" => "服务器上的资料库刚刚变化（例如从备份恢复），请重试。".to_string(),
        "io" | "internal" => "服务器搜索出错了，请稍后重试。".to_string(),
        _ => return error.into_cli(),
    };
    CliError::new("ERROR", message)
}

/// 与本地 `find::hits_json` 同一组键；远程搜索没有创建时间时 `createdAt` 为 null。
fn hits_json(hits: &[Hit<'_>], created_known: bool) -> String {
    let items = hits
        .iter()
        .enumerate()
        .map(|(index, hit)| {
            json!({
                "index": index + 1,
                "id": hit.entry.id,
                "path": hit.entry.path,
                "title": hit.entry.title,
                "kind": hit.entry.kind_name(),
                "tags": hit.entry.tags,
                "createdAt": if created_known { Value::String(hit.entry.created_at.clone()) } else { Value::Null },
                "updatedAt": find::millis_rfc3339(hit.entry.modified_at),
                "preview": hit.preview.iter().map(|part| part.text.as_str()).collect::<String>(),
            })
        })
        .collect::<Vec<_>>();
    serde_json::to_string_pretty(&items).unwrap_or_else(|_| "[]".to_string())
}

// ---------------------------------------------------------------------------
// 交互编辑：读 → 本地编辑 → 带 sha 写回
// ---------------------------------------------------------------------------

struct RemoteSession {
    path: String,
    sha: String,
}

/// 远程模式的编辑会话：打开时按路径读全文与 sha；保存时调 `rewrite_document`，服务端在一个事务里
/// 核对 sha 并按同一份规则改写（正文没变不写）；期间被别处改过（409）就把这次的修改存进临时文件，
/// 绝不覆盖。保存成功后只重读这一篇刷新列表，不重新下载整个资料库。
pub struct RemoteStore {
    remote: Remote,
    sessions: HashMap<String, RemoteSession>,
    saved: Option<FragmentEntry>,
}

impl RemoteStore {
    pub fn new(remote: Remote) -> Self {
        Self { remote, sessions: HashMap::new(), saved: None }
    }
}

impl Store for RemoteStore {
    fn open(&mut self, entry: &FragmentEntry) -> Result<String, String> {
        let target = if entry.path.is_empty() { &entry.id } else { &entry.path };
        let document = read_document(&self.remote, target).map_err(|error| error.message)?;
        let body = document.body.clone();
        self.sessions.insert(entry.id.clone(), RemoteSession { path: document.path, sha: document.sha });
        Ok(body)
    }

    fn save(&mut self, id: &str, body: &str) -> Result<SaveReport, SaveError> {
        let session = self
            .sessions
            .get_mut(id)
            .ok_or_else(|| SaveError::Invalid("编辑会话已失效，请重新打开碎片".into()))?;
        let next = normalize_body(body).to_string();
        let saved = self.remote.write(
            "rewrite_document",
            json!({ "target": session.path, "body": next, "expectedSha": session.sha }),
        );
        let report: RewriteReport = match saved {
            Ok(value) => decode(value, "改写结果").map_err(|error| SaveError::Invalid(error.message))?,
            Err(error) if error.is("STALE_BASE") => return Err(edit::conflict_draft(id, &next)),
            Err(error) => return Err(SaveError::Invalid(error.into_cli().message)),
        };
        session.sha = report.sha;
        session.path = report.path.clone();
        self.saved = read_document(&self.remote, &report.path).ok().map(entry_from_document);
        Ok(SaveReport)
    }

    fn reload(&mut self) -> Result<Vec<FragmentEntry>, String> {
        load_entries(&self.remote).map_err(|error| error.message)
    }

    fn after_save(&mut self, entries: &[FragmentEntry], id: &str) -> Result<Vec<FragmentEntry>, String> {
        let Some(saved) = self.saved.take() else {
            return self.reload();
        };
        let mut entries = entries.to_vec();
        match entries.iter_mut().find(|entry| entry.id == id) {
            Some(entry) => *entry = saved,
            None => entries.push(saved),
        }
        Ok(entries)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        remote::RemoteConfig,
        tui::{app::App, terminal::Event},
    };
    use ratatui::crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
    use shard_server::{app, commands, config::Config, rpc::base_registry, state::AppState};
    use std::{net::SocketAddr, path::PathBuf};

    const MEMO_ID: &str = "20261025-221500-b2c3d4e5-1a1b1c";

    struct Server {
        remote: Remote,
        _data: tempfile::TempDir,
        _runtime: tokio::runtime::Runtime,
    }

    /// 起一个导入示例资料库的 shard-server，直接在认证库里登记一台 CLI 设备拿到令牌。
    fn server() -> Server {
        let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let data = tempfile::tempdir().unwrap();
        let config = Config::new(data.path().to_path_buf(), &format!("http://localhost:{port}"), None, false).unwrap();
        let mut registry = base_registry();
        commands::register(&mut registry);
        let state = AppState::open(config, registry).unwrap();
        let golden = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/vault-golden");
        shard_store::transfer::import_vault(&state.store, &golden).unwrap();
        commands::ensure_layout(&state.store).unwrap();
        let token = shard_server::auth::tokens::device_token();
        state.auth.create_device("dev_tui", "测试", "cli", &token, "vault").unwrap();
        let router = app::build(state);
        runtime.spawn(async move {
            let listener = tokio::net::TcpListener::from_std(listener).unwrap();
            axum::serve(listener, router.into_make_service_with_connect_info::<SocketAddr>()).await.unwrap();
        });
        let remote = Remote::connect(
            RemoteConfig {
                server: format!("http://127.0.0.1:{port}"),
                device_id: "dev_tui".into(),
                name: "测试".into(),
            },
            token,
        )
        .unwrap();
        Server { remote, _data: data, _runtime: runtime }
    }

    fn key(code: KeyCode, modifiers: KeyModifiers) -> Event {
        Event::Key(KeyEvent::new(code, modifiers))
    }

    #[test]
    fn tui_saves_through_remote_store_and_refreshes_only_that_entry() {
        let server = server();
        let remote = &server.remote;
        let entries = load_entries(remote).unwrap();
        let before = entries.len();
        let mut app = App::new(entries, Box::new(RemoteStore::new(remote.clone())));
        app.handle(Event::Paste("给车换链条".into()));
        assert_eq!(app.hits.len(), 1);
        app.handle(key(KeyCode::Enter, KeyModifiers::NONE));
        app.handle(key(KeyCode::End, KeyModifiers::CONTROL));
        app.handle(Event::Paste("\n- [ ] 买牛奶 #生活".into()));
        app.handle(key(KeyCode::Char('s'), KeyModifiers::CONTROL));
        assert!(app.error.is_none(), "{:?}", app.error);
        assert!(!app.editor.as_ref().unwrap().is_dirty());

        let document = read_document(remote, MEMO_ID).unwrap();
        assert!(document.body.ends_with("- [ ] 给车换链条 #备忘\n- [ ] 买牛奶 #生活"), "{}", document.body);
        assert_eq!(document.tags, ["inbox", "备忘", "生活"]);
        // 列表只刷新这一篇：条数不变，这一篇的正文、标签与修改时间是服务器上的新值。
        assert_eq!(app.entries.len(), before);
        let refreshed = app.entries.iter().find(|entry| entry.id == MEMO_ID).unwrap();
        assert_eq!(refreshed.body, document.body);
        assert_eq!(refreshed.tags, document.tags);
        assert_eq!(refreshed.updated_at, document.updated_at);

        // 第二次保存用的是新基线，不会误判冲突。
        app.handle(Event::Paste("\n- [ ] 再买面包".into()));
        app.handle(key(KeyCode::Char('s'), KeyModifiers::CONTROL));
        assert!(app.error.is_none(), "{:?}", app.error);
        assert!(read_document(remote, MEMO_ID).unwrap().body.ends_with("再买面包"));

        // 期间被别处改过：不覆盖，修改另存为草稿。
        remote
            .write("append_document", json!({ "target": MEMO_ID, "text": "别处追加" }))
            .unwrap();
        app.handle(Event::Paste("\n- [ ] 不该覆盖".into()));
        app.handle(key(KeyCode::Char('s'), KeyModifiers::CONTROL));
        assert_eq!(app.draft_paths.len(), 1);
        let draft = std::fs::read_to_string(&app.draft_paths[0]).unwrap();
        assert!(draft.ends_with("不该覆盖\n"));
        assert!(read_document(remote, MEMO_ID).unwrap().body.ends_with("别处追加"));
        std::fs::remove_file(&app.draft_paths[0]).unwrap();
    }

    #[test]
    fn quick_entry_resolves_ids_without_downloading_and_defers_keywords() {
        let server = server();
        let remote = &server.remote;
        let by_id = quick_entry(remote, &[MEMO_ID.to_string()]).unwrap().unwrap();
        assert_eq!(by_id.title, "- [ ] 买咖啡豆 ⏰ 2026-10-28 09:00");
        assert_eq!(quick_entry(remote, &["b2c3d4e5".to_string()]).unwrap().unwrap().id, MEMO_ID);
        assert_eq!(quick_entry(remote, &[]).unwrap().unwrap().title, "周报 10-26");
        // 路径、关键词、歧义的片段与多个词：交给全量选择（与本地 select 一致）。
        assert!(quick_entry(remote, &["notes/读书/书单.md".to_string()]).unwrap().is_none());
        assert!(quick_entry(remote, &["咖啡".to_string()]).unwrap().is_none());
        assert!(quick_entry(remote, &["2026".to_string()]).unwrap().is_none());
        assert!(quick_entry(remote, &["买".to_string(), "咖啡".to_string()]).unwrap().is_none());
    }
}
