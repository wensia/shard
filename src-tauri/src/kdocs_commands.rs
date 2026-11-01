//! Personal Kdocs storage. CLI credentials stay in its system keychain.
use base64::{engine::general_purpose::STANDARD, Engine as _};
use chrono::{Local, NaiveDateTime, TimeZone};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};
use tauri::Manager;

static WRITE_GATE: Mutex<()> = Mutex::new(());
const MAX_ATTACHMENT_BYTES: u64 = 20 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 50 * 1024 * 1024;
const MAX_ATTACHMENTS: usize = 10;
const MAX_OUTPUT_BYTES: u64 = 16 * 1024 * 1024;
const CLI_TIMEOUT: Duration = Duration::from_secs(55);
const CONTENT: &str = "内容";
const TAGS: &str = "标签";
const ATTACHMENTS: &str = "附件";
const CREATED_AT: &str = "创建时间";
const SHARD_ID: &str = "Shard ID";
const UNKNOWN_SAVE: &str = "保存结果尚未确认，草稿已保留。再次保存会先核对云端记录。";

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KdocsConnection {
    file_id: String,
    sheet_id: String,
    url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KdocsStatus {
    cli_available: bool,
    authenticated: bool,
    connection: Option<KdocsConnection>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KdocsAttachment {
    object_id: String,
    name: String,
    size: u64,
    #[serde(rename = "type")]
    attachment_type: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KdocsRecord {
    id: String,
    shard_id: String,
    content: String,
    tags: Vec<String>,
    created_at: String,
    attachments: Vec<KdocsAttachment>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KdocsPage {
    records: Vec<KdocsRecord>,
    has_more: bool,
    next_cursor: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KdocsSaveInput {
    request_id: String,
    content: String,
    tags: Vec<String>,
    attachment_paths: Vec<String>,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
struct Config {
    connection: Option<KdocsConnection>,
    initialization_pending: bool,
    pending_requests: BTreeMap<String, PendingRequest>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PendingRequest {
    fingerprint: String,
    #[serde(default)]
    input_fingerprint: String,
    // Persist before non-idempotent operations. An uncertain write is read back,
    // never blindly repeated (also after an app restart).
    phase: String,
    attachments: Vec<KdocsAttachment>,
    #[serde(default)]
    attachment_hashes: Vec<String>,
    #[serde(default)]
    confirmed_at: Option<i64>,
}

struct LocalAttachment {
    path: PathBuf,
    name: String,
    size: u64,
    attachment_type: String,
    content_type: String,
    sha256: String,
}

struct CliReply {
    value: Value,
    successful: bool,
}

struct MutationError {
    message: String,
    definitive: bool,
}

fn config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|_| "无法读取应用配置目录")?
        .join("kdocs.json"))
}

fn read_config(path: &Path) -> Result<Config, String> {
    if !path.exists() {
        return Ok(Config::default());
    }
    let bytes = fs::read(path).map_err(|_| "无法读取金山文档配置")?;
    serde_json::from_slice(&bytes).map_err(|_| "金山文档配置无效，请检查 kdocs.json".into())
}

fn write_config(path: &Path, config: &Config) -> Result<(), String> {
    fs::create_dir_all(path.parent().ok_or("配置路径无效")?).map_err(|_| "无法创建配置目录")?;
    let text = serde_json::to_string_pretty(config).map_err(|_| "无法保存金山文档配置")?;
    shard_core::write_text_atomically(path, &text)
}

fn find_cli(app: &tauri::AppHandle) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(home) = app.path().home_dir() {
        candidates.push(home.join(".local/bin/kdocs-cli"));
    }
    candidates.extend([
        PathBuf::from("/opt/homebrew/bin/kdocs-cli"),
        PathBuf::from("/usr/local/bin/kdocs-cli"),
    ]);
    if let Some(paths) = std::env::var_os("PATH") {
        candidates.extend(std::env::split_paths(&paths).map(|path| path.join("kdocs-cli")));
    }
    candidates.into_iter().find(|path| path.is_file())
}

fn require_cli(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    find_cli(app).ok_or_else(|| "未找到 kdocs-cli，请先安装金山文档 Skill 的配套 CLI。".into())
}

// No shell, token arguments, request logging, or temporary payload files.
fn cli_reply(cli: &Path, args: &[&str], payload: Option<&Value>) -> Result<CliReply, String> {
    let mut child = Command::new(cli)
        .args(args)
        .stdin(if payload.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| "无法启动 kdocs-cli，请检查安装和执行权限。")?;
    let input = payload.map(|value| serde_json::to_vec(value).expect("JSON value serialization"));
    let writer = input.map(|bytes| {
        let mut stdin = child.stdin.take().expect("piped stdin");
        thread::spawn(move || stdin.write_all(&bytes))
    });
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    let output_reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout
            .take(MAX_OUTPUT_BYTES + 1)
            .read_to_end(&mut bytes)
            .map(|_| bytes)
    });
    let error_reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        stderr
            .take(MAX_OUTPUT_BYTES + 1)
            .read_to_end(&mut bytes)
            .map(|_| bytes)
    });
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) if started.elapsed() < CLI_TIMEOUT => thread::sleep(Duration::from_millis(25)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break Err("金山文档请求超时，操作结果需要核对。".to_string());
            }
        }
    };
    if let Some(writer) = writer {
        let _ = writer.join();
    }
    let output = output_reader
        .join()
        .map_err(|_| "无法读取金山文档响应")?
        .map_err(|_| "无法读取金山文档响应")?;
    let errors = error_reader
        .join()
        .map_err(|_| "无法读取金山文档响应")?
        .map_err(|_| "无法读取金山文档响应")?;
    let status = status?;
    if output.len() as u64 > MAX_OUTPUT_BYTES || errors.len() as u64 > MAX_OUTPUT_BYTES {
        return Err("金山文档响应过大，请缩小查询范围。".into());
    }
    let value = serde_json::from_slice(&output)
        .or_else(|_| serde_json::from_slice(&errors))
        .map_err(|_| "金山文档返回了无法解析的响应，请检查 CLI 版本和登录状态。")?;
    Ok(CliReply {
        value,
        successful: status.success(),
    })
}

fn response_code(value: &Value) -> Option<i64> {
    [
        value.get("code"),
        value.pointer("/error/code"),
        value.pointer("/error/status"),
    ]
    .into_iter()
    .flatten()
    .find_map(|code| {
        code.as_i64()
            .or_else(|| code.as_str().and_then(|code| code.parse().ok()))
    })
}

fn checked(reply: CliReply) -> Result<Value, String> {
    if !reply.successful
        || response_code(&reply.value).is_some_and(|code| code != 0)
        || reply
            .value
            .get("result")
            .and_then(Value::as_str)
            .is_some_and(|result| result != "ok")
        || reply.value.get("error").is_some()
    {
        let code = response_code(&reply.value);
        return Err(match code {
            Some(400006) => "金山文档登录已失效，请运行 kdocs-cli auth login 重新登录。".into(),
            Some(403 | 403001) => "当前账号无权访问这份多维表格。".into(),
            Some(429001 | 429002) => "金山文档请求过于频繁，请按服务端限频时间稍后重试。".into(),
            Some(code) => format!("金山文档请求失败（代码 {code}），请核对账号权限与表格结构。"),
            None => "金山文档请求失败，请检查登录状态或稍后重试。".into(),
        });
    }
    // 2.8 unwraps data; accept wrapped responses too, without exposing raw output.
    Ok(reply.value.get("data").cloned().unwrap_or(reply.value))
}

fn mutation(
    cli: &Path,
    service: &str,
    action: &str,
    payload: Value,
) -> Result<Value, MutationError> {
    let reply = cli_reply(
        cli,
        &["--timeout", "45000", service, action, "-"],
        Some(&payload),
    )
    .map_err(|message| MutationError {
        message,
        definitive: false,
    })?;
    let definitive = response_code(&reply.value).is_some_and(|code| {
        (400000..429000).contains(&code) || matches!(code, 400 | 401 | 403 | 404 | 409 | 422)
    });
    checked(reply).map_err(|message| MutationError {
        message,
        definitive,
    })
}

fn call(cli: &Path, service: &str, action: &str, payload: Value) -> Result<Value, String> {
    checked(cli_reply(
        cli,
        &["--timeout", "45000", service, action, "-"],
        Some(&payload),
    )?)
}

fn authenticated(cli: &Path) -> bool {
    // auth status includes a token. Return only the explicit boolean.
    cli_reply(cli, &["auth", "status"], None)
        .ok()
        .filter(|reply| reply.successful)
        .and_then(|reply| reply.value.get("authenticated").and_then(Value::as_bool))
        .unwrap_or(false)
}

fn sheet_id(connection: &KdocsConnection) -> Result<i64, String> {
    connection
        .sheet_id
        .parse()
        .map_err(|_| "金山文档数据表 ID 无效".into())
}

fn schema(cli: &Path, connection: &KdocsConnection) -> Result<Value, String> {
    let id = sheet_id(connection)?;
    let response = call(
        cli,
        "dbsheet",
        "get-schema",
        json!({"file_id": connection.file_id, "sheet_id": id}),
    )?;
    let sheets = response
        .pointer("/detail/sheets")
        .or_else(|| response.get("sheets"))
        .and_then(Value::as_array)
        .ok_or("金山文档返回的表格结构无效")?;
    let sheet = sheets
        .iter()
        .find(|sheet| sheet.get("id").and_then(Value::as_i64) == Some(id))
        .ok_or("未找到已连接的数据表")?;
    let fields = sheet
        .get("fields")
        .and_then(Value::as_array)
        .ok_or("数据表缺少字段定义")?;
    for (name, expected) in [
        (CONTENT, "MultiLineText"),
        (TAGS, "MultipleSelect"),
        (ATTACHMENTS, "Attachment"),
        (SHARD_ID, "MultiLineText"),
    ] {
        if !fields.iter().any(|field| {
            field.get("name").and_then(Value::as_str) == Some(name)
                && field.get("type").and_then(Value::as_str) == Some(expected)
        }) {
            return Err(format!("多维表格缺少「{name}」字段或字段类型不匹配。"));
        }
    }
    Ok(sheet.clone())
}

fn record_fields(value: &Value) -> Result<Value, String> {
    let fields = value.get("fields").ok_or("记录缺少字段")?;
    if let Some(text) = fields.as_str() {
        serde_json::from_str(text).map_err(|_| "记录字段格式无效".into())
    } else if fields.is_object() {
        Ok(fields.clone())
    } else {
        Err("记录字段格式无效".into())
    }
}

fn string(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn parse_record(value: &Value) -> Result<KdocsRecord, String> {
    let fields = record_fields(value)?;
    let created = string(fields.get(CREATED_AT));
    let created_at = NaiveDateTime::parse_from_str(&created, "%Y/%m/%d %H:%M:%S")
        .ok()
        .and_then(|date| Local.from_local_datetime(&date).single())
        .map(|date| date.to_rfc3339())
        .unwrap_or(created);
    let tags = fields
        .get(TAGS)
        .and_then(Value::as_array)
        .map(|tags| {
            tags.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    let attachments = fields
        .get(ATTACHMENTS)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let object_id = item.get("uploadId").and_then(Value::as_str)?;
                    Some(KdocsAttachment {
                        object_id: object_id.into(),
                        name: string(item.get("fileName")),
                        size: item.get("size").and_then(Value::as_u64).unwrap_or_default(),
                        attachment_type: string(item.get("type")),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(KdocsRecord {
        id: string(value.get("id")),
        shard_id: string(fields.get(SHARD_ID)),
        content: string(fields.get(CONTENT)),
        tags,
        created_at,
        attachments,
    })
}

fn list_page(
    cli: &Path,
    connection: &KdocsConnection,
    cursor: Option<String>,
    filter: Option<Value>,
) -> Result<KdocsPage, String> {
    if cursor.as_ref().is_some_and(|cursor| cursor.len() > 4096) {
        return Err("分页游标无效".into());
    }
    let mut payload = json!({"file_id": connection.file_id, "sheet_id": sheet_id(connection)?, "page_size":100,"offset":cursor.unwrap_or_default(),"show_record_extra_info":true});
    if let Some(filter) = filter {
        payload["filter"] = filter;
    }
    let response = call(cli, "dbsheet", "list-records", payload)?;
    let detail = response.get("detail").unwrap_or(&response);
    let records = parse_records(detail)?;
    let next_cursor = detail
        .get("offset")
        .and_then(Value::as_str)
        .filter(|cursor| !cursor.is_empty())
        .map(str::to_owned);
    Ok(KdocsPage {
        records,
        has_more: next_cursor.is_some(),
        next_cursor,
    })
}

fn parse_records(detail: &Value) -> Result<Vec<KdocsRecord>, String> {
    match detail.get("records") {
        None | Some(Value::Null) => Ok(vec![]),
        Some(Value::Array(records)) => records.iter().map(parse_record).collect(),
        _ => Err("金山文档返回的记录列表无效".into()),
    }
}

fn find_request(
    cli: &Path,
    connection: &KdocsConnection,
    request_id: &str,
) -> Result<Option<KdocsRecord>, String> {
    let page = list_page(
        cli,
        connection,
        None,
        Some(
            json!({"mode":"AND","criteria":[{"field":SHARD_ID,"op":"Equals","values":[request_id]}]}),
        ),
    )?;
    if page.records.len() > 1 || page.has_more {
        return Err("发现重复 Shard ID，请先在金山文档中核对记录。".into());
    }
    Ok(page.records.into_iter().next())
}

fn protected_tag(tag: &str) -> bool {
    tag.split('/')
        .any(|part| part.eq_ignore_ascii_case("lockbox") || part == "密匣")
}

fn normalize_input(mut input: KdocsSaveInput) -> Result<KdocsSaveInput, String> {
    if !(8..=128).contains(&input.request_id.len())
        || !input
            .request_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("录入请求 ID 无效".into());
    }
    input.content = input.content.trim().to_string();
    if input.content.chars().count() > 20_000 {
        return Err("正文不能超过 20,000 字符".into());
    }
    if input.content.is_empty() && input.attachment_paths.is_empty() {
        return Err("请输入内容或添加附件".into());
    }
    let mut seen = HashSet::new();
    input.tags = input
        .tags
        .into_iter()
        .filter_map(|tag| shard_core::normalize_tag(&tag))
        .filter(|tag| seen.insert(tag.clone()))
        .collect();
    if input.tags.len() > 30 || input.tags.iter().any(|tag| tag.chars().count() > 64) {
        return Err("最多添加 30 个标签，每个标签不超过 64 字符".into());
    }
    if input.tags.iter().any(|tag| protected_tag(tag))
        || input.content.to_ascii_lowercase().contains("#lockbox")
        || input.content.contains("#密匣")
    {
        return Err("密匣内容不能保存到普通云端表格，请使用本地密匣。".into());
    }
    if input.attachment_paths.len() > MAX_ATTACHMENTS {
        return Err("一次最多添加 10 个附件".into());
    }
    Ok(input)
}

fn protected_path(path: &Path) -> bool {
    path.components().any(|part| {
        let name = part.as_os_str().to_string_lossy();
        name == "密匣"
            || ["lockbox", ".lockbox", ".shard", ".git"]
                .iter()
                .any(|blocked| name.eq_ignore_ascii_case(blocked))
    })
}

fn attachment_type(path: &Path) -> (String, String) {
    let extension = path
        .extension()
        .and_then(|part| part.to_str())
        .unwrap_or("file")
        .to_ascii_lowercase();
    let mime = match extension.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "heic" => "image/heic",
        "avif" => "image/avif",
        _ => "application/octet-stream",
    };
    (
        if mime.starts_with("image/") {
            mime.to_string()
        } else {
            extension
        },
        mime.into(),
    )
}

fn local_attachments(paths: &[String]) -> Result<Vec<LocalAttachment>, String> {
    let mut total = 0;
    let mut seen = HashSet::new();
    paths
        .iter()
        .map(|raw| {
            let path = Path::new(raw);
            if !path.is_absolute() || protected_path(path) {
                return Err("附件不能来自密匣或应用内部目录。".into());
            }
            let metadata = fs::symlink_metadata(path).map_err(|_| "附件不存在或无法读取")?;
            if !metadata.is_file() || metadata.file_type().is_symlink() {
                return Err("附件必须是普通文件，不能是目录或符号链接。".into());
            }
            let path = path.canonicalize().map_err(|_| "无法解析附件路径")?;
            if protected_path(&path) {
                return Err("附件不能来自密匣或应用内部目录。".into());
            }
            if !seen.insert(path.clone()) {
                return Err("请勿重复添加同一个附件".into());
            }
            let size = metadata.len();
            total += size;
            if size > MAX_ATTACHMENT_BYTES || total > MAX_TOTAL_BYTES {
                return Err("单个附件最多 20 MiB，全部附件合计最多 50 MiB。".into());
            }
            let name = path
                .file_name()
                .and_then(|name| name.to_str())
                .ok_or("附件名称无效")?
                .to_string();
            let (attachment_type, content_type) = attachment_type(&path);
            let bytes = read_attachment(&path, size)?;
            let sha256 = format!("{:x}", Sha256::digest(&bytes));
            Ok(LocalAttachment {
                path,
                name,
                size,
                attachment_type,
                content_type,
                sha256,
            })
        })
        .collect()
}

fn read_attachment(path: &Path, expected_size: u64) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|_| "无法读取附件")?
        .take(MAX_ATTACHMENT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "无法读取附件")?;
    if bytes.len() as u64 != expected_size {
        return Err("附件在选择后发生变化，请重新添加。".into());
    }
    Ok(bytes)
}

fn upload(
    cli: &Path,
    connection: &KdocsConnection,
    file: &LocalAttachment,
) -> Result<KdocsAttachment, MutationError> {
    let local_error = |message| MutationError {
        message,
        definitive: true,
    };
    let bytes = read_attachment(&file.path, file.size).map_err(local_error)?;
    if format!("{:x}", Sha256::digest(&bytes)) != file.sha256 {
        return Err(local_error("附件在选择后发生变化，请重新添加。".into()));
    }
    let result = mutation(
        cli,
        "drive",
        "upload-attachment",
        json!({"file_id":connection.file_id,"filename":file.name,"content_base64":STANDARD.encode(bytes),"content_type":file.content_type}),
    )?;
    let object_id = result
        .get("object_id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| MutationError {
            message: "附件上传结果缺少资源 ID".into(),
            definitive: false,
        })?;
    Ok(KdocsAttachment {
        object_id: object_id.into(),
        name: file.name.clone(),
        size: file.size,
        attachment_type: file.attachment_type.clone(),
    })
}

fn matches_input(
    record: &KdocsRecord,
    input: &KdocsSaveInput,
    attachments: &[LocalAttachment],
) -> bool {
    matches_text(record, input)
        && record.attachments.len() == attachments.len()
        && record
            .attachments
            .iter()
            .zip(attachments)
            .all(|(saved, local)| saved.name == local.name && saved.size == local.size)
}

fn matches_text(record: &KdocsRecord, input: &KdocsSaveInput) -> bool {
    let mut tags = record.tags.clone();
    tags.sort();
    let mut wanted = input.tags.clone();
    wanted.sort();
    record.shard_id == input.request_id && record.content == input.content && tags == wanted
}

fn confirm_save(
    config: &mut Config,
    path: &Path,
    input: &KdocsSaveInput,
    input_fingerprint: String,
    record: &KdocsRecord,
) -> Result<(), String> {
    let pending = config
        .pending_requests
        .entry(input.request_id.clone())
        .or_insert(PendingRequest {
            fingerprint: String::new(),
            input_fingerprint: input_fingerprint.clone(),
            phase: "complete".into(),
            attachments: vec![],
            attachment_hashes: vec![],
            confirmed_at: None,
        });
    pending.phase = "complete".into();
    pending.input_fingerprint = input_fingerprint;
    pending.attachments = record.attachments.clone();
    pending.confirmed_at = Some(Local::now().timestamp_millis());
    // Keep recent successful receipts too: the UI response itself can be lost.
    let mut completed = config
        .pending_requests
        .iter()
        .filter_map(|(id, pending)| pending.confirmed_at.map(|at| (id.clone(), at)))
        .collect::<Vec<_>>();
    completed.sort_by_key(|(_, at)| *at);
    let remove = completed.len().saturating_sub(500);
    for (id, _) in completed.into_iter().take(remove) {
        config.pending_requests.remove(&id);
    }
    write_config(path, config)
}

fn save(cli: &Path, path: &Path, input: KdocsSaveInput) -> Result<KdocsRecord, String> {
    let input = normalize_input(input)?;
    let input_bytes = serde_json::to_vec(&input).map_err(|_| "录入内容无效")?;
    let input_fingerprint = format!("{:x}", Sha256::digest(&input_bytes));
    let mut config = read_config(path)?;
    let connection = config
        .connection
        .clone()
        .ok_or("请先连接金山文档多维表格")?;
    if let Some(pending) = config.pending_requests.get(&input.request_id) {
        if pending.phase != "prepared" && pending.input_fingerprint != input_fingerprint {
            return Err(if pending.phase == "complete" {
                "该录入请求 ID 已用于不同内容，请核对云端记录。".into()
            } else {
                "上次保存结果尚未确认，请先恢复原提交内容核对，再保存修改后的草稿。".into()
            });
        }
    }
    schema(cli, &connection)?;
    // Resolve an uncertain write before touching the original local files.
    // Attachments can have moved or been removed since the initial submission.
    if let Some(record) = find_request(cli, &connection, &input.request_id)? {
        let matches = if let Some(pending) = config
            .pending_requests
            .get(&input.request_id)
            .filter(|pending| pending.input_fingerprint == input_fingerprint)
        {
            matches_text(&record, &input) && record.attachments == pending.attachments
        } else {
            matches_input(
                &record,
                &input,
                &local_attachments(&input.attachment_paths)?,
            )
        };
        if !matches {
            return Err("该录入请求 ID 已用于不同内容，请核对云端记录。".into());
        }
        confirm_save(&mut config, path, &input, input_fingerprint, &record)?;
        return Ok(record);
    }
    if let Some(pending) = config
        .pending_requests
        .get(&input.request_id)
        .filter(|pending| pending.phase != "prepared")
    {
        return Err(match pending.phase.as_str() {
            "uploading" => "附件上传结果尚未确认，请检查云端后重新录入。".into(),
            "complete" => "原云端记录已不存在，请核对后新建草稿。".into(),
            _ => UNKNOWN_SAVE.into(),
        });
    }
    let files = local_attachments(&input.attachment_paths)?;
    let mut digest = Sha256::new();
    digest.update(&input_bytes);
    for file in &files {
        digest.update(file.sha256.as_bytes());
    }
    let fingerprint = format!("{:x}", digest.finalize());
    if let Some(pending) = config.pending_requests.get_mut(&input.request_id) {
        if pending.fingerprint != fingerprint {
            if pending.phase != "prepared" {
                return Err(
                    "上次保存结果尚未确认，请先恢复原提交内容核对，再保存修改后的草稿。".into(),
                );
            }
            // A definitively rejected record may be corrected with the same ID.
            // Reuse the known uploaded prefix only when its content still matches.
            let keep = files
                .iter()
                .zip(&pending.attachments)
                .zip(&pending.attachment_hashes)
                .take_while(|((file, uploaded), hash)| {
                    file.sha256 == **hash
                        && file.name == uploaded.name
                        && file.size == uploaded.size
                })
                .count();
            pending.attachments.truncate(keep);
            pending.attachment_hashes.truncate(keep);
            pending.fingerprint = fingerprint.clone();
            pending.input_fingerprint = input_fingerprint.clone();
        }
    }
    if config.pending_requests.len() >= 1000 {
        return Err("待核对的保存请求过多，请先检查云端记录。".into());
    }
    config
        .pending_requests
        .entry(input.request_id.clone())
        .or_insert(PendingRequest {
            fingerprint,
            input_fingerprint: input_fingerprint.clone(),
            phase: "prepared".into(),
            attachments: vec![],
            attachment_hashes: vec![],
            confirmed_at: None,
        });
    write_config(path, &config)?;
    let mut uploaded = config.pending_requests[&input.request_id]
        .attachments
        .clone();
    for file in files.iter().skip(uploaded.len()) {
        config
            .pending_requests
            .get_mut(&input.request_id)
            .expect("pending request")
            .phase = "uploading".into();
        write_config(path, &config)?;
        match upload(cli, &connection, file) {
            Ok(attachment) => uploaded.push(attachment),
            Err(error) => {
                if error.definitive {
                    config
                        .pending_requests
                        .get_mut(&input.request_id)
                        .expect("pending request")
                        .phase = "prepared".into();
                    write_config(path, &config)?;
                    return Err(error.message);
                }
                return Err(
                    "附件上传结果尚未确认，草稿已保留。请先核对云端，避免重复上传。".into(),
                );
            }
        }
        let pending = config
            .pending_requests
            .get_mut(&input.request_id)
            .expect("pending request");
        pending.attachments = uploaded.clone();
        pending.attachment_hashes = files
            .iter()
            .take(uploaded.len())
            .map(|file| file.sha256.clone())
            .collect();
        pending.phase = "prepared".into();
        write_config(path, &config)?;
    }
    // Reuse only a completely empty user row (the initial dbt creation placeholder).
    let blank = list_page(cli, &connection, None, Some(json!({"mode":"AND","criteria":[{"field":SHARD_ID,"op":"Empty"},{"field":CONTENT,"op":"Empty"},{"field":ATTACHMENTS,"op":"Empty"},{"field":TAGS,"op":"Empty"}]})))?
        .records.into_iter().find(|record| record.shard_id.is_empty() && record.content.is_empty() && record.tags.is_empty() && record.attachments.is_empty());
    let fields = json!({CONTENT:input.content,TAGS:input.tags,SHARD_ID:input.request_id,ATTACHMENTS:uploaded.iter().map(|item| json!({"uploadId":item.object_id,"fileName":item.name,"size":item.size,"source":"upload_ks3","type":item.attachment_type})).collect::<Vec<_>>()});
    config
        .pending_requests
        .get_mut(&input.request_id)
        .expect("pending request")
        .phase = "writing".into();
    write_config(path, &config)?;
    let (action, records) = match blank {
        Some(blank) => ("update-records", json!([{"id":blank.id,"fields":fields}])),
        None => ("create-records", json!([{"fields":fields}])),
    };
    let write = mutation(
        cli,
        "dbsheet",
        action,
        json!({"file_id":connection.file_id,"sheet_id":sheet_id(&connection)?,"add_select_item":true,"records":records}),
    );
    // Even a transport failure may have committed. Resolve by Shard ID, once.
    match find_request(cli, &connection, &input.request_id) {
        Ok(Some(record))
            if matches_input(&record, &input, &files)
                && record
                    .attachments
                    .iter()
                    .zip(&uploaded)
                    .all(|(read, written)| read.object_id == written.object_id) =>
        {
            confirm_save(&mut config, path, &input, input_fingerprint, &record)?;
            Ok(record)
        }
        _ => {
            if let Err(error) = write {
                if error.definitive {
                    config
                        .pending_requests
                        .get_mut(&input.request_id)
                        .expect("pending request")
                        .phase = "prepared".into();
                    write_config(path, &config)?;
                    return Err(error.message);
                }
            }
            Err(UNKNOWN_SAVE.into())
        }
    }
}

fn status(cli: Option<&Path>, path: &Path) -> Result<KdocsStatus, String> {
    let config = read_config(path)?;
    Ok(KdocsStatus {
        cli_available: cli.is_some(),
        authenticated: cli.is_some_and(authenticated),
        connection: if config.initialization_pending {
            None
        } else {
            config.connection
        },
    })
}

#[tauri::command]
pub async fn kdocs_status(app: tauri::AppHandle) -> Result<KdocsStatus, String> {
    crate::run_blocking(move || status(find_cli(&app).as_deref(), &config_path(&app)?)).await
}

fn creation_payload() -> Value {
    json!({
        "name":"Shard", "file_extension":"dbt", "sheet_name":"碎片",
        "fields":[
            {"name":CONTENT,"type":"MultiLineText"},
            {"name":TAGS,"type":"MultipleSelect","allowAddItemWhenInputting":true,"autoAddItem":true},
            {"name":ATTACHMENTS,"type":"Attachment"},
            {"name":CREATED_AT,"type":"CreatedTime","numberFormat":"yyyy/mm/dd hh:mm:ss"},
            {"name":SHARD_ID,"type":"MultiLineText"}
        ],
        "records":[{"fields":{}}]
    })
}

fn complete_connection(cli: &Path, connection: &mut KdocsConnection) -> Result<(), String> {
    if connection.sheet_id.is_empty() {
        let response = call(
            cli,
            "dbsheet",
            "get-schema",
            json!({"file_id":connection.file_id}),
        )?;
        connection.sheet_id = response
            .pointer("/detail/sheets/0/id")
            .and_then(Value::as_i64)
            .ok_or("创建结果缺少数据表 ID")?
            .to_string();
    }
    if connection.url.is_empty() {
        let response = call(
            cli,
            "drive",
            "get-file-link",
            json!({"file_id":connection.file_id}),
        )?;
        connection.url = response
            .get("link_url")
            .and_then(Value::as_str)
            .ok_or("无法获取多维表格链接")?
            .to_string();
    }
    schema(cli, connection)?;
    Ok(())
}

fn initialize(cli: &Path, path: &Path) -> Result<KdocsStatus, String> {
    let mut config = read_config(path)?;
    if !authenticated(cli) {
        return Err("请先运行 kdocs-cli auth login 登录金山文档。".into());
    }
    if config.connection.is_none() {
        if config.initialization_pending {
            return Err(
                "上次创建结果尚未确认，请先在金山文档中核对 Shard 多维表格，避免重复创建。".into(),
            );
        }
        config.initialization_pending = true;
        write_config(path, &config)?;
        let reply = cli_reply(
            cli,
            &[
                "--timeout",
                "45000",
                "drive",
                "create-file-with-content",
                "-",
            ],
            Some(&creation_payload()),
        )?;
        let data = reply.value.get("data").unwrap_or(&reply.value);
        if let Some(file_id) = data.get("file_id").and_then(Value::as_str) {
            config.connection = Some(KdocsConnection {
                file_id: file_id.into(),
                sheet_id: data
                    .get("sheet_id")
                    .and_then(Value::as_i64)
                    .map(|id| id.to_string())
                    .unwrap_or_default(),
                url: string(data.get("link_url")),
            });
            // Preserve partial success before any subsequent request can fail.
            write_config(path, &config)?;
        }
        let definitive = response_code(&reply.value).is_some_and(|code| {
            (400000..429000).contains(&code) || matches!(code, 400 | 401 | 403 | 404 | 409 | 422)
        });
        if let Err(error) = checked(reply) {
            if definitive && config.connection.is_none() {
                config.initialization_pending = false;
                write_config(path, &config)?;
            }
            return Err(error);
        }
    }
    let connection = config
        .connection
        .as_mut()
        .ok_or("创建结果缺少文件 ID，请先在金山文档中核对。")?;
    complete_connection(cli, connection)?;
    config.initialization_pending = false;
    write_config(path, &config)?;
    Ok(KdocsStatus {
        cli_available: true,
        authenticated: true,
        connection: config.connection,
    })
}

#[tauri::command]
pub async fn kdocs_initialize(app: tauri::AppHandle) -> Result<KdocsStatus, String> {
    crate::run_blocking(move || {
        let _guard = WRITE_GATE.lock().map_err(|_| "金山文档写入锁不可用")?;
        initialize(&require_cli(&app)?, &config_path(&app)?)
    })
    .await
}

#[tauri::command]
pub async fn kdocs_list_records(
    app: tauri::AppHandle,
    cursor: Option<String>,
) -> Result<KdocsPage, String> {
    crate::run_blocking(move || {
        let cli = require_cli(&app)?;
        let connection = read_config(&config_path(&app)?)?
            .connection
            .ok_or("请先连接金山文档多维表格")?;
        schema(&cli, &connection)?;
        let mut page = list_page(&cli, &connection, cursor, None)?;
        page.records
            .retain(|record| !record.content.is_empty() || !record.attachments.is_empty());
        Ok(page)
    })
    .await
}

#[tauri::command]
pub async fn kdocs_save_record(
    app: tauri::AppHandle,
    input: KdocsSaveInput,
) -> Result<KdocsRecord, String> {
    crate::run_blocking(move || {
        let _guard = WRITE_GATE.lock().map_err(|_| "金山文档写入锁不可用")?;
        let path = config_path(&app)?;
        let id = input.request_id.clone();
        let cli = require_cli(&app).map_err(|error| format!("KDOCS_EDITABLE: {error}"))?;
        save(&cli, &path, input).map_err(|error| {
            let uncertain = read_config(&path)
                .ok()
                .and_then(|config| config.pending_requests.get(&id).cloned())
                .is_some_and(|pending| pending.phase == "writing" || pending.phase == "uploading");
            if uncertain || error.contains("请求 ID 已用于不同内容") {
                error
            } else {
                format!("KDOCS_EDITABLE: {error}")
            }
        })
    })
    .await
}

#[tauri::command]
pub async fn kdocs_attachment_url(
    app: tauri::AppHandle,
    object_id: String,
) -> Result<String, String> {
    crate::run_blocking(move || {
        if object_id.is_empty() || object_id.len() > 512 {
            return Err("附件资源 ID 无效".into());
        }
        let cli = require_cli(&app)?;
        let connection = read_config(&config_path(&app)?)?
            .connection
            .ok_or("请先连接金山文档多维表格")?;
        let data = call(
            &cli,
            "drive",
            "download-attachment",
            json!({"file_id":connection.file_id,"attachment_id":object_id}),
        )?;
        let url = data
            .get("download_url")
            .and_then(Value::as_str)
            .ok_or("无法获取附件下载链接")?;
        let parsed = tauri::Url::parse(url).map_err(|_| "附件下载链接无效")?;
        if parsed.scheme() != "https"
            || !parsed.username().is_empty()
            || parsed.password().is_some()
        {
            return Err("附件下载链接无效".into());
        }
        Ok(url.into())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(content: &str, tags: &[&str]) -> KdocsSaveInput {
        KdocsSaveInput {
            request_id: "draft-12345678".into(),
            content: content.into(),
            tags: tags.iter().map(|tag| tag.to_string()).collect(),
            attachment_paths: vec![],
        }
    }

    #[test]
    fn cloud_input_keeps_tags_unique_and_rejects_lockbox_markers() {
        assert_eq!(
            normalize_input(input(" note ", &["#工作", "工作", " #旅行 "]))
                .unwrap()
                .tags,
            vec!["工作", "旅行"]
        );
        for text in ["秘密 #密匣", "#LOCKBOX private", "#密匣/生活"] {
            assert!(normalize_input(input(text, &[])).is_err());
        }
        assert!(normalize_input(input("note", &["lockbox"])).is_err());
        let mut attachment_only = input("", &[]);
        attachment_only
            .attachment_paths
            .push("/tmp/file.pdf".into());
        assert!(normalize_input(attachment_only).is_ok());
        assert!(normalize_input(input(" ", &[])).is_err());
    }

    #[test]
    fn attachments_reject_private_paths_directories_symlinks_and_overflow() {
        let dir = tempfile::tempdir().unwrap();
        let ordinary = dir.path().join("附件.PDF");
        fs::write(&ordinary, b"pdf").unwrap();
        let files = local_attachments(&[ordinary.to_string_lossy().into_owned()]).unwrap();
        assert_eq!(files[0].attachment_type, "pdf");
        assert!(local_attachments(&[dir.path().to_string_lossy().into_owned()]).is_err());
        let lockbox = dir.path().join("lockbox");
        fs::create_dir(&lockbox).unwrap();
        let private = lockbox.join("a.txt");
        fs::write(&private, b"secret").unwrap();
        assert!(local_attachments(&[private.to_string_lossy().into_owned()]).is_err());
        let large = dir.path().join("large.bin");
        fs::File::create(&large)
            .unwrap()
            .set_len(MAX_ATTACHMENT_BYTES + 1)
            .unwrap();
        assert!(local_attachments(&[large.to_string_lossy().into_owned()]).is_err());
        #[cfg(unix)]
        {
            let link = dir.path().join("link.pdf");
            std::os::unix::fs::symlink(&ordinary, &link).unwrap();
            assert!(local_attachments(&[link.to_string_lossy().into_owned()]).is_err());
            let parent_link = dir.path().join("alias");
            std::os::unix::fs::symlink(&lockbox, &parent_link).unwrap();
            assert!(
                local_attachments(&[parent_link.join("a.txt").to_string_lossy().into_owned()])
                    .is_err()
            );
        }
    }

    #[test]
    fn records_parse_both_json_shapes_without_losing_attachment_ids() {
        let fields = json!({CONTENT:"note",TAGS:["work"],SHARD_ID:"draft-12345678",ATTACHMENTS:[{"uploadId":"asset-1","fileName":"file.pdf","size":42,"type":"pdf"}]});
        for fields in [fields.clone(), Value::String(fields.to_string())] {
            let record = parse_record(&json!({"id":"A","fields":fields})).unwrap();
            assert_eq!(record.content, "note");
            assert_eq!(record.attachments[0].object_id, "asset-1");
        }
    }

    #[test]
    fn empty_cloud_record_results_accept_null_and_missing_but_reject_other_types() {
        // Actual Kdocs 2.8.2 response for a new table or unmatched filter.
        let response = json!({"detail":{"records":null},"result":"ok"});
        assert!(parse_records(&response["detail"]).unwrap().is_empty());
        assert!(parse_records(&json!({})).unwrap().is_empty());
        assert!(parse_records(&json!({"records":[]})).unwrap().is_empty());
        for invalid in [json!({}), json!(""), json!(0), json!(false)] {
            assert!(parse_records(&json!({"records":invalid})).is_err());
        }
    }

    #[test]
    fn error_responses_never_return_credentials_or_remote_details() {
        let secret = "secret-token-never-forward";
        let error = checked(CliReply {
            value: json!({"code":400006,"message":secret,"token":secret}),
            successful: false,
        })
        .unwrap_err();
        assert!(!error.contains(secret));
        assert!(error.contains("登录"));
    }

    #[cfg(unix)]
    fn fake_cli(directory: &Path, mode: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = directory.join("kdocs-cli");
        fs::write(&path,r#"#!/usr/bin/env python3
import json, pathlib, sys
path=pathlib.Path(__file__+'.state.json')
state=json.loads(path.read_text())
args=sys.argv[1:]
if args[:2]==['auth','status']:
 print(json.dumps({'authenticated':True,'token':'must-never-leave-backend'}));sys.exit(0)
action=args[-2]
payload=json.load(sys.stdin)
def done(result, exit_code=0):
 path.write_text(json.dumps(state));print(json.dumps(result));sys.exit(exit_code)
if action=='get-schema':
 done({'detail':{'sheets':[{'id':1,'fields':[{'name':n,'type':t} for n,t in [('内容','MultiLineText'),('标签','MultipleSelect'),('附件','Attachment'),('Shard ID','MultiLineText')]]}]},'result':'ok'})
if action=='list-records':
 record=state.get('record')
 criteria=payload.get('filter',{}).get('criteria',[])
 if criteria and criteria[0]['op']=='Equals':
  records=[record] if record and record['fields']['Shard ID']==criteria[0]['values'][0] else []
 elif criteria:
  records=[] if record else [{'id':'blank-A','fields':{}}]
 else:records=[record] if record else []
 done({'detail':{'records':records},'result':'ok'})
if action=='upload-attachment':
 state['uploads']=state.get('uploads',0)+1
 done({'result':'ok','object_id':'asset-'+str(state['uploads'])})
if action in ['create-records','update-records']:
 state['writes']=state.get('writes',0)+1
 state['last_action']=action
 record={'id':payload['records'][0].get('id','new-A'),'fields':payload['records'][0]['fields']}
 record['fields']['创建时间']='2026/10/31 16:00:00'
 state['attempted_record']=record
 if state['mode']=='unknown':done({'code':500,'message':'request result unknown'},1)
 if state['mode']=='reject':done({'code':400001,'message':'known rejection'},1)
 state['record']=record
 done({'records':[record]})
done({'code':400001,'message':'unexpected action'},1)
"#).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        fs::write(
            path.with_file_name("kdocs-cli.state.json"),
            json!({"mode":mode}).to_string(),
        )
        .unwrap();
        path
    }

    #[cfg(unix)]
    fn fake_config(path: &Path) {
        let mut config = Config::default();
        config.connection = Some(KdocsConnection {
            file_id: "file-test".into(),
            sheet_id: "1".into(),
            url: "https://www.kdocs.cn/l/test".into(),
        });
        write_config(path, &config).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn uncertain_save_retries_only_read_and_can_recover_after_local_attachment_is_gone() {
        let directory = tempfile::tempdir().unwrap();
        let cli = fake_cli(directory.path(), "unknown");
        let config = directory.path().join("kdocs.json");
        fake_config(&config);
        let attachment = directory.path().join("attachment.txt");
        fs::write(&attachment, b"attachment").unwrap();
        let make = || {
            let mut input = input("note", &["work"]);
            input.attachment_paths = vec![attachment.to_string_lossy().into_owned()];
            input
        };
        assert!(save(&cli, &config, make())
            .unwrap_err()
            .contains("尚未确认"));
        assert!(save(&cli, &config, make())
            .unwrap_err()
            .contains("尚未确认"));
        let state_path = directory.path().join("kdocs-cli.state.json");
        let mut state: Value = serde_json::from_slice(&fs::read(&state_path).unwrap()).unwrap();
        assert_eq!(state["writes"], 1);
        assert_eq!(state["uploads"], 1);
        assert_eq!(
            state["last_action"], "update-records",
            "reuse the completely empty initial row"
        );
        // Server-side completion becomes visible after the timeout; the local
        // source can disappear and must not prevent receipt reconciliation.
        state["record"] = state["attempted_record"].clone();
        fs::write(&state_path, state.to_string()).unwrap();
        fs::remove_file(&attachment).unwrap();
        let record = save(&cli, &config, make()).unwrap();
        assert_eq!(record.id, "blank-A");
        assert_eq!(
            save(&cli, &config, make()).unwrap().id,
            record.id,
            "successful receipt survives a lost UI response"
        );
        let state: Value = serde_json::from_slice(&fs::read(&state_path).unwrap()).unwrap();
        assert_eq!(state["writes"], 1);
        assert_eq!(state["uploads"], 1);
        let mut changed = make();
        changed.content = "changed".into();
        assert!(save(&cli, &config, changed)
            .unwrap_err()
            .contains("已用于不同内容"));
    }

    #[cfg(unix)]
    #[test]
    fn rejected_save_can_be_corrected_with_same_id_and_reuses_known_uploaded_attachment() {
        let directory = tempfile::tempdir().unwrap();
        let cli = fake_cli(directory.path(), "reject");
        let config = directory.path().join("kdocs.json");
        fake_config(&config);
        let attachment = directory.path().join("attachment.txt");
        fs::write(&attachment, b"attachment").unwrap();
        let make = |content: &str| {
            let mut input = input(content, &["work"]);
            input.attachment_paths = vec![attachment.to_string_lossy().into_owned()];
            input
        };
        assert!(save(&cli, &config, make("original"))
            .unwrap_err()
            .contains("400001"));
        assert_eq!(
            read_config(&config).unwrap().pending_requests["draft-12345678"].phase,
            "prepared"
        );
        let state_path = directory.path().join("kdocs-cli.state.json");
        let mut state: Value = serde_json::from_slice(&fs::read(&state_path).unwrap()).unwrap();
        state["mode"] = json!("success");
        fs::write(&state_path, state.to_string()).unwrap();
        assert_eq!(
            save(&cli, &config, make("corrected")).unwrap().content,
            "corrected"
        );
        let state: Value = serde_json::from_slice(&fs::read(&state_path).unwrap()).unwrap();
        assert_eq!(state["writes"], 2);
        assert_eq!(state["uploads"], 1);
    }

    /// Explicit, opt-in integration check: creates a real Shard dbt and one
    /// named record/attachment, keeping both for inspection. Never runs normally.
    #[test]
    #[ignore = "writes a real personal Kdocs table; requires SHARD_KDOCS_LIVE=1"]
    fn kdocs_live_storage_smoke() {
        assert_eq!(std::env::var("SHARD_KDOCS_LIVE").as_deref(), Ok("1"));
        let _guard = WRITE_GATE.lock().unwrap();
        let home = PathBuf::from(std::env::var_os("HOME").expect("HOME"));
        let cli = home.join(".local/bin/kdocs-cli");
        let directory = home.join("Library/Application Support/dev.shard.desktop");
        let config = directory.join("kdocs.json");
        let state = initialize(&cli, &config).expect("initialize real cloud storage");
        assert!(state.authenticated);
        let connection = state.connection.expect("connection");
        schema(&cli, &connection).expect("real schema");
        let attachment_dir = directory.join("kdocs-smoke");
        fs::create_dir_all(&attachment_dir).unwrap();
        let file = attachment_dir.join("Shard-connection-check.txt");
        fs::write(&file, b"Shard cloud attachment smoke check.\n").unwrap();
        let make_input = || KdocsSaveInput {
            request_id: "shard-cloud-connection-check-v1".into(),
            content: "Shard 连接验证：快速录入与附件上传".into(),
            tags: vec!["连接验证".into()],
            attachment_paths: vec![file.to_string_lossy().into_owned()],
        };
        let record = save(&cli, &config, make_input()).expect("real save + readback");
        assert_eq!(record.attachments.len(), 1);
        let again = save(&cli, &config, make_input()).expect("same request readback");
        assert_eq!(record.id, again.id, "retry must reuse the saved record");
        let download = call(
            &cli,
            "drive",
            "download-attachment",
            json!({
                "file_id": connection.file_id,
                "attachment_id": record.attachments[0].object_id,
            }),
        )
        .expect("real attachment download info");
        assert!(download
            .get("download_url")
            .and_then(Value::as_str)
            .is_some_and(|url| url.starts_with("https://")));
        let first_page = list_page(&cli, &connection, None, None).expect("real pagination");
        assert!(first_page.records.iter().any(|item| item.id == record.id));
        println!("Cloud schema, attachment, pagination and same-request deduplication verified.");
        println!("Connection persisted at {}", config.display());
    }
}
