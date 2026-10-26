//! 网页密匣会话（`session.rs`，与 wasm 里跑的是同一份代码）的原生测试：
//! - 前后比较：新建、改写、归档 / 恢复（同 id 换路径）、manifest 写入、移入密匣的 seal；
//! - 锁着用公钥写入、解锁后读出、上锁清密钥、网页解锁开关；
//! - 409 基线冲突后重取快照；搜索与读取；方言迁移；
//! - 与桌面互通：会话写出的信封由桌面函数（`FsVfs` 上的 `shard_vault::lockbox`）解开，反之亦然。
//!
//! `FakeServer` 照 crates/shard-server/src/lockbox.rs 的语义（CAS、整批成败、put 缺省路径沿用原来的）。

use std::{
    collections::{BTreeMap, HashSet},
    path::Path,
};


use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use shard_core::{FsVfs, Vfs};
use shard_lockbox::{Envelope, WriteKey};
use shard_lockbox_wasm::session::{effective_path, CallError, Session, WEB_UNLOCK_DISABLED};
use shard_vault::{lockbox as desktop, Fragment, NoHooks, VaultCtx};

const PASSWORD: &str = "correct horse battery";
const OFFSET_MINUTES: i64 = 480;

fn sha(text: &str) -> String {
    Sha256::digest(text.as_bytes()).iter().map(|byte| format!("{byte:02x}")).collect()
}

#[derive(Clone)]
struct ServerItem {
    envelope: String,
    sha: String,
    path: Option<String>,
}

#[derive(Default)]
struct FakeServer {
    manifest: Option<(String, String)>,
    items: BTreeMap<String, ServerItem>,
    public: BTreeMap<String, (String, String)>,
    web_unlock: bool,
}

impl FakeServer {
    fn new() -> Self {
        Self { web_unlock: true, ..Self::default() }
    }

    fn snapshot(&self) -> Value {
        let withheld = !self.web_unlock;
        let items: Vec<Value> = if withheld {
            Vec::new()
        } else {
            self.items
                .iter()
                .map(|(id, item)| json!({ "id": id, "envelope": item.envelope, "sha": item.sha, "path": item.path, "revision": 1 }))
                .collect()
        };
        json!({
            "configured": self.manifest.is_some(),
            "manifest": self.manifest.as_ref().map(|(body, sha)| json!({ "body": body, "sha": sha, "revision": 1 })),
            "items": items,
            "itemsWithheld": withheld,
            "webUnlock": self.web_unlock,
        })
    }

    /// `lockbox_apply`：任何一条基线不符整批不写，返回 409。
    fn apply(&mut self, args: &Value) -> Result<Value, &'static str> {
        let mut manifest = self.manifest.clone();
        let mut items = self.items.clone();
        let mut out_manifest = Value::Null;
        if let Some(write) = args.get("manifest").filter(|value| !value.is_null()) {
            let expected = write["expectedSha"].as_str();
            if manifest.as_ref().map(|(_, sha)| sha.as_str()) != expected {
                return Err("STALE_BASE");
            }
            let body = write["body"].as_str().unwrap().to_string();
            let body_sha = sha(&body);
            manifest = Some((body, body_sha.clone()));
            out_manifest = json!({ "sha": body_sha, "revision": 2 });
        }
        let mut out_items = Vec::new();
        for item in args["items"].as_array().cloned().unwrap_or_default() {
            let id = item["id"].as_str().unwrap().to_string();
            let current = items.get(&id).map(|item| item.sha.clone());
            match item["op"].as_str().unwrap() {
                "put" => {
                    if current.as_deref() != item["expectedSha"].as_str() {
                        return Err("STALE_BASE");
                    }
                    let envelope = item["envelope"].as_str().unwrap().to_string();
                    let envelope_id = Envelope::parse(&envelope).unwrap().id;
                    assert_eq!(envelope_id, id, "信封 id 与条目 id 必须一致");
                    let path = item["path"].as_str().map(str::to_string).or_else(|| items.get(&id).and_then(|item| item.path.clone()));
                    let item_sha = sha(&envelope);
                    items.insert(id.clone(), ServerItem { envelope, sha: item_sha.clone(), path: path.clone() });
                    out_items.push(json!({ "id": id, "sha": item_sha, "revision": 2, "path": path }));
                }
                "delete" => {
                    if current.as_deref() != item["expectedSha"].as_str() {
                        return Err("STALE_BASE");
                    }
                    items.remove(&id);
                    out_items.push(json!({ "id": id, "sha": Value::Null }));
                }
                other => panic!("未知操作 {other}"),
            }
        }
        self.manifest = manifest;
        self.items = items;
        Ok(json!({ "manifest": out_manifest, "items": out_items }))
    }

    /// `seal_fragment_into_lockbox`：核对公开原文的 sha，删公开文件，写信封。
    fn seal(&mut self, args: &Value) -> Result<Value, &'static str> {
        let id = args["fragmentId"].as_str().unwrap();
        assert_eq!(args["item"]["id"].as_str().unwrap(), id);
        let (path, (_, public_sha)) = self
            .public
            .iter()
            .find(|(_, (fragment_id, _))| fragment_id == id)
            .map(|(path, value)| (path.clone(), value.clone()))
            .ok_or("NOT_FOUND")?;
        if args["expectedFileSha"].as_str() != Some(public_sha.as_str()) {
            return Err("STALE_BASE");
        }
        if self.items.contains_key(id) {
            return Err("LOCKBOX_ID_TAKEN");
        }
        self.public.remove(&path);
        let envelope = args["item"]["envelope"].as_str().unwrap().to_string();
        let item_sha = sha(&envelope);
        let item_path = args["item"]["path"].as_str().unwrap().to_string();
        self.items.insert(id.to_string(), ServerItem { envelope, sha: item_sha.clone(), path: Some(item_path.clone()) });
        Ok(json!({ "removedPath": path, "item": { "id": id, "sha": item_sha, "revision": 1, "path": item_path } }))
    }

    /// 导出成桌面能直接打开的目录：manifest 与信封按路径落盘。
    fn export(&self, dir: &Path) {
        if let Some((body, _)) = &self.manifest {
            std::fs::create_dir_all(dir.join(".shard")).unwrap();
            std::fs::write(dir.join(".shard/lockbox.json"), body).unwrap();
        }
        for (id, item) in &self.items {
            let path = dir.join(effective_path(id, item.path.as_deref()).unwrap());
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, &item.envelope).unwrap();
        }
    }
}

fn clock() -> Value {
    json!({ "nowMs": 1_793_000_000_000u64, "utcOffsetMinutes": OFFSET_MINUTES })
}

fn call(session: &mut Session, method: &str, mut args: Value) -> Result<Value, CallError> {
    args["clock"] = clock();
    session.call(method, args)
}

fn ok(session: &mut Session, method: &str, args: Value) -> Value {
    call(session, method, args).unwrap_or_else(|error| panic!("{method} 失败：{error:?}"))
}

fn message(result: Result<Value, CallError>) -> String {
    match result {
        Err(CallError::Message(message)) => message,
        other => panic!("应当报错，实际：{other:?}"),
    }
}

/// 照前端的做法：执行写命令，把载荷交给服务器，确认后 commit；冲突时回滚。
fn write(session: &mut Session, server: &mut FakeServer, method: &str, args: Value) -> Result<Value, String> {
    let response = call(session, method, args).map_err(|error| format!("{error:?}"))?;
    if response.get("forward").is_some() {
        return Ok(response);
    }
    let payload = response["write"].clone();
    if !payload.is_null() {
        let apply = if payload["apply"].is_null() { Ok(Value::Null) } else { server.apply(&payload["apply"]) };
        let seal = apply.and_then(|apply| {
            let seal = if payload["seal"].is_null() { Value::Null } else { server.seal(&payload["seal"])? };
            Ok((apply, seal))
        });
        match seal {
            Ok((apply, seal)) => {
                ok(session, "commit", json!({ "apply": apply, "seal": seal }));
            }
            Err(code) => {
                ok(session, "rollback", json!({}));
                return Err(code.to_string());
            }
        }
    }
    Ok(response["result"].clone())
}

fn load(session: &mut Session, server: &FakeServer) -> Value {
    ok(session, "load", json!({ "snapshot": server.snapshot() }))
}

fn setup() -> (Session, FakeServer, String) {
    let mut server = FakeServer::new();
    let mut session = Session::new();
    load(&mut session, &server);
    let result = write(&mut session, &mut server, "setup", json!({ "password": PASSWORD })).unwrap();
    let recovery_key = result["recoveryKey"].as_str().unwrap().to_string();
    (session, server, recovery_key)
}

fn create(session: &mut Session, server: &mut FakeServer, content: &str, tags: &[&str]) -> Value {
    write(session, server, "create", json!({ "content": content, "tags": tags })).unwrap()
}

fn list(session: &mut Session) -> Vec<Fragment> {
    serde_json::from_value(ok(session, "list", json!({}))).unwrap()
}

#[test]
fn setup_writes_only_the_manifest_with_null_base() {
    let mut server = FakeServer::new();
    let mut session = Session::new();
    load(&mut session, &server);
    let response = ok(&mut session, "setup", json!({ "password": PASSWORD }));
    assert!(response["result"]["recoveryKey"].as_str().unwrap().len() > 20);
    let apply = &response["write"]["apply"];
    assert!(apply["manifest"]["expectedSha"].is_null());
    assert_eq!(apply["items"], json!([]));
    assert!(response["write"]["seal"].is_null());
    let committed = server.apply(apply).unwrap();
    let state = ok(&mut session, "commit", json!({ "apply": committed }));
    assert_eq!(state["configured"], true);
    assert_eq!(state["unlocked"], true);
    // 再设置一次：桌面同一句报错。
    assert_eq!(message(call(&mut session, "setup", json!({ "password": PASSWORD }))), "密匣已经设置。");
}

#[test]
fn writes_are_diffed_by_envelope_id_and_archive_is_a_path_change() {
    let (mut session, mut server, _) = setup();
    let created = ok(&mut session, "create", json!({ "content": "第一条私密", "tags": ["密匣", "日记"] }));
    let fragment = &created["result"];
    let id = fragment["id"].as_str().unwrap().to_string();
    assert_eq!(fragment["lockbox"], true);
    assert_eq!(fragment["content"], "第一条私密");
    assert_eq!(fragment["tags"], json!(["日记"]));
    let items = created["write"]["apply"]["items"].as_array().unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["op"], "put");
    assert!(items[0]["expectedSha"].is_null());
    let path = items[0]["path"].as_str().unwrap();
    // 碎片 id 与月份目录按客户端时区（+08:00）。
    assert!(path.starts_with(&format!("lockbox/fragments/{}/{}/", &id[..4], &id[4..6])), "{path}");
    assert!(created["write"]["apply"].get("manifest").is_none());
    let committed = server.apply(&created["write"]["apply"]).unwrap();
    ok(&mut session, "commit", json!({ "apply": committed }));
    let first_sha = server.items[&id].sha.clone();
    assert_eq!(fragment["fileSha"], first_sha.as_str());

    // 改正文：同路径一条 put，基线是上一次的 sha，不带路径。
    let updated = ok(&mut session, "update", json!({ "id": id, "content": "改过的私密", "tags": ["密匣", "日记"], "expectedFileSha": first_sha }));
    let items = updated["write"]["apply"]["items"].as_array().unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["expectedSha"], first_sha.as_str());
    assert!(items[0].get("path").is_none());
    let committed = server.apply(&updated["write"]["apply"]).unwrap();
    ok(&mut session, "commit", json!({ "apply": committed }));

    // 基线过期：与桌面同一句 STALE_BASE。
    let stale = message(call(&mut session, "update", json!({ "id": id, "content": "x", "tags": [], "expectedFileSha": first_sha })));
    assert!(stale.starts_with("STALE_BASE"), "{stale}");

    // 归档：同 id 换路径，一条 put 带新路径，不是一删一增。
    let archived = ok(&mut session, "set_archived", json!({ "id": id, "archived": true }));
    let items = archived["write"]["apply"]["items"].as_array().unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["op"], "put");
    assert!(items[0]["path"].as_str().unwrap().starts_with("lockbox/archive/"));
    assert_eq!(archived["result"]["archived"], true);
    let committed = server.apply(&archived["write"]["apply"]).unwrap();
    ok(&mut session, "commit", json!({ "apply": committed }));
    assert!(server.items[&id].path.as_deref().unwrap().starts_with("lockbox/archive/"));
    assert_eq!(message(call(&mut session, "set_pinned", json!({ "id": id, "pinned": true }))), "密匣中已删除的片段不能置顶。");

    // 恢复：路径换回来。
    let restored = write(&mut session, &mut server, "set_archived", json!({ "id": id, "archived": false })).unwrap();
    assert_eq!(restored["archived"], false);
    assert!(server.items[&id].path.as_deref().unwrap().starts_with("lockbox/fragments/"));

    // 置顶、属性、标签：都是同路径 put。
    write(&mut session, &mut server, "set_pinned", json!({ "id": id, "pinned": true })).unwrap();
    let with_property = write(
        &mut session,
        &mut server,
        "set_property",
        json!({ "id": id, "key": "心情", "value": { "type": "text", "value": "平静" } }),
    )
    .unwrap();
    assert_eq!(with_property["properties"][0]["key"], "心情");
    let retagged = write(&mut session, &mut server, "update_tags", json!({ "id": id, "tags": ["密匣", "旅行"] })).unwrap();
    assert_eq!(retagged["tags"], json!(["旅行"]));
    let removed = write(&mut session, &mut server, "remove_property", json!({ "id": id, "key": "心情" })).unwrap();
    assert_eq!(removed["properties"], json!([]));

    let listed = list(&mut session);
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].content, "改过的私密");
    assert!(listed[0].pinned);
    assert_eq!(listed[0].file_sha, server.items[&id].sha);
}

#[test]
fn locked_create_uses_the_public_key_and_unlock_reads_it_back() {
    let (mut session, mut server, _) = setup();
    ok(&mut session, "lock", json!({}));
    assert_eq!(ok(&mut session, "state", json!({}))["unlocked"], false);
    assert_eq!(list(&mut session).len(), 0);

    let created = create(&mut session, &mut server, "锁着记下的", &["#密匣"]);
    let id = created["id"].as_str().unwrap().to_string();
    // 锁着：返回不含正文的投影。
    assert_eq!(created["content"], "");
    assert_eq!(created["lockbox"], true);
    let envelope = Envelope::parse(&server.items[&id].envelope).unwrap();
    assert_eq!(envelope.key_algorithm.as_deref(), Some(shard_lockbox::FRAGMENT_KEY_ALGORITHM));

    // 锁着不能读改。
    assert_eq!(message(call(&mut session, "update", json!({ "id": id, "content": "x", "tags": [] }))), "lockbox_locked");
    assert_eq!(message(call(&mut session, "set_pinned", json!({ "id": id, "pinned": true }))), "lockbox_locked");

    assert_eq!(message(call(&mut session, "unlock", json!({ "password": "wrong password" }))), "密码不正确。");
    write(&mut session, &mut server, "unlock", json!({ "password": PASSWORD })).unwrap();
    let listed = list(&mut session);
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].content, "锁着记下的");
    assert_eq!(listed[0].id, id);

    // 上锁清掉密钥：列表为空，搜索报 locked。
    ok(&mut session, "lock", json!({}));
    assert!(list(&mut session).is_empty());
    let search = call(&mut session, "search", search_args("锁着", None));
    assert_eq!(search, Err(CallError::Search(shard_vault::search::SearchError::Locked)));
}

#[test]
fn create_without_lockbox_tag_is_forwarded_and_protected_types_are_rejected() {
    let (mut session, _server, _) = setup();
    assert_eq!(ok(&mut session, "create", json!({ "content": "公开的", "tags": ["日记"] })), json!({ "forward": true }));
    assert_eq!(message(call(&mut session, "create", json!({ "content": "  ", "tags": ["密匣"] }))), "片段内容不能为空");
    assert_eq!(message(call(&mut session, "create", json!({ "content": "x", "tags": ["密匣", "outline"] }))), "大纲与流程图不能放入密匣。");
    assert_eq!(
        message(call(&mut session, "create", json!({ "content": "![a](assets/a.png)", "tags": ["密匣"] }))),
        "密匣暂不支持图片附件。请先移除图片，再保存到密匣。"
    );
    // 不是密匣条目的 id：交回服务器。
    for (method, args) in [
        ("update", json!({ "id": "public-1", "content": "x", "tags": [] })),
        ("update_tags", json!({ "id": "public-1", "tags": [] })),
        ("set_pinned", json!({ "id": "public-1", "pinned": true })),
        ("set_archived", json!({ "id": "public-1", "archived": true })),
        ("set_property", json!({ "id": "public-1", "key": "k", "value": { "type": "text", "value": "v" } })),
        ("remove_property", json!({ "id": "public-1", "key": "k" })),
    ] {
        assert_eq!(ok(&mut session, method, args), json!({ "forward": true }), "{method}");
    }
}

#[test]
fn not_configured_errors_match_the_desktop() {
    let mut session = Session::new();
    load(&mut session, &FakeServer::new());
    assert_eq!(message(call(&mut session, "create", json!({ "content": "x", "tags": ["密匣"] }))), "密匣尚未设置。");
    assert_eq!(message(call(&mut session, "unlock", json!({ "password": PASSWORD }))), "密匣尚未设置。");
    assert_eq!(message(call(&mut session, "setup", json!({ "password": "short" }))), "密匣密码至少需要 8 个字符。");
}

#[test]
fn moving_a_public_fragment_produces_a_single_seal() {
    let (mut session, mut server, _) = setup();
    let id = "20261026-073012-a1b2c3d4-0a0b0c";
    let text = format!(
        "---\nid: {id}\ncreated_at: 2026-10-26T07:30:12+08:00\nupdated_at: 2026-10-26T07:30:12+08:00\ntags:\n- 骑行\nsource: desktop\n心情: 好\n---\n\n公开的正文\n"
    );
    let path = "fragments/2026/10/20261026-073012-a1b2c3d4-0a0b0c.md";
    server.public.insert(path.to_string(), (id.to_string(), sha(&text)));

    let response = ok(&mut session, "move_public", json!({ "id": id, "path": path, "text": text }));
    assert!(response["write"]["apply"].is_null());
    let seal = &response["write"]["seal"];
    assert_eq!(seal["fragmentId"], id);
    assert_eq!(seal["expectedFileSha"], sha(&text).as_str());
    assert_eq!(seal["item"]["path"], "lockbox/fragments/2026/10/20261026-073012-a1b2c3d4-0a0b0c.shard");
    assert_eq!(response["result"]["content"], "公开的正文");
    // 自定义属性原样保留（frontmatter 保真）。
    assert_eq!(response["result"]["properties"][0]["key"], "心情");
    let sealed = server.seal(seal).unwrap();
    let state = ok(&mut session, "commit", json!({ "apply": Value::Null, "seal": sealed }));
    assert_eq!(state["itemIds"], json!([id]));
    assert!(server.public.is_empty());
    let listed = list(&mut session);
    assert_eq!(listed[0].content, "公开的正文");
    assert_eq!(listed[0].path, "lockbox/fragments/2026/10/20261026-073012-a1b2c3d4-0a0b0c.shard");

    // 公开原文对不上 id：与桌面同一句报错，内存资料库退回基线。
    assert_eq!(
        message(call(&mut session, "move_public", json!({ "id": "missing", "path": "notes/a.md", "text": "---\nid: other\n---\n" }))),
        "找不到片段 missing"
    );
    assert_eq!(list(&mut session).len(), 1);
}

#[test]
fn saving_a_public_fragment_with_the_lockbox_tag_moves_it_and_other_saves_are_forwarded() {
    let (mut session, mut server, _) = setup();
    ok(&mut session, "lock", json!({}));
    let id = "20261027-080000-aaaaaaaa-000001";
    let text = format!("---\nid: {id}\ncreated_at: 2026-10-27T08:00:00+08:00\nupdated_at: 2026-10-27T08:00:00+08:00\ntags:\n- inbox\nsource: web\n---\n\n旧正文\n");
    let path = "fragments/2026/10/20261027-080000-aaaaaaaa-000001.md";
    server.public.insert(path.to_string(), (id.to_string(), sha(&text)));

    // 新标签里没有密匣：交回服务器。
    let forward = ok(
        &mut session,
        "update_public",
        json!({ "id": id, "path": path, "text": text, "content": "提到密匣两个字", "tags": ["日记"], "expectedFileSha": sha(&text) }),
    );
    assert_eq!(forward, json!({ "forward": true }));
    // 基线不对：桌面同一句。
    let stale = message(call(
        &mut session,
        "update_public",
        json!({ "id": id, "path": path, "text": text, "content": "新正文", "tags": ["密匣"], "expectedFileSha": "0" }),
    ));
    assert!(stale.starts_with("STALE_BASE"), "{stale}");

    // 锁着也能移入（公钥）。
    let moved = write(
        &mut session,
        &mut server,
        "update_public",
        json!({ "id": id, "path": path, "text": text, "content": "新正文", "tags": ["密匣", "日记"], "expectedFileSha": sha(&text) }),
    )
    .unwrap();
    assert_eq!(moved["lockbox"], true);
    assert_eq!(moved["content"], "");
    assert!(server.public.is_empty());
    write(&mut session, &mut server, "unlock", json!({ "password": PASSWORD })).unwrap();
    let listed = list(&mut session);
    assert_eq!(listed[0].content, "新正文");
    assert_eq!(listed[0].tags, vec!["日记".to_string()]);

    // 只改标签加上密匣：用原正文移入。
    let other = "20261027-090000-bbbbbbbb-000002";
    let other_text = format!("---\nid: {other}\ncreated_at: 2026-10-27T09:00:00+08:00\nupdated_at: 2026-10-27T09:00:00+08:00\ntags: []\nsource: web\n---\n\n只改标签\n");
    let other_path = "notes/随笔.md";
    server.public.insert(other_path.to_string(), (other.to_string(), sha(&other_text)));
    let moved = write(
        &mut session,
        &mut server,
        "update_public",
        json!({ "id": other, "path": other_path, "text": other_text, "tags": ["密匣"], "tagsOnly": true }),
    )
    .unwrap();
    assert_eq!(moved["content"], "只改标签");
    assert_eq!(moved["path"], "lockbox/notes/随笔.shard");
    // 服务器上只有按 id 推出的路径，标题在加密载荷里。
    assert_eq!(server.items[other].path.as_deref(), Some(&*format!("lockbox/notes/{other}.shard")));
}

#[test]
fn stale_base_rolls_back_and_a_fresh_snapshot_shows_the_other_write() {
    let (mut first, mut server, _) = setup();
    let created = create(&mut first, &mut server, "两边都在改", &["密匣"]);
    let id = created["id"].as_str().unwrap().to_string();

    let mut second = Session::new();
    load(&mut second, &server);
    write(&mut second, &mut server, "unlock", json!({ "password": PASSWORD })).unwrap();
    write(&mut second, &mut server, "update", json!({ "id": id, "content": "第二个标签页改的", "tags": ["密匣"] })).unwrap();

    // 第一个标签页基线过期：服务器 409，回滚，基线不变。
    let conflict = write(&mut first, &mut server, "update", json!({ "id": id, "content": "第一个标签页改的", "tags": ["密匣"] }));
    assert_eq!(conflict, Err("STALE_BASE".to_string()));
    assert_eq!(list(&mut first)[0].content, "两边都在改");
    // 重取快照：看到另一边的改动，密钥保留，变化以 vault-changed 同形报告。
    let reloaded = load(&mut first, &server);
    assert_eq!(reloaded["state"]["unlocked"], true);
    let changes = reloaded["changes"].as_array().unwrap();
    assert_eq!(changes.len(), 1);
    assert_eq!(changes[0]["exists"], true);
    assert_eq!(changes[0]["sha"], server.items[&id].sha.as_str());
    assert_eq!(list(&mut first)[0].content, "第二个标签页改的");
}

#[test]
fn turning_off_web_unlock_locks_and_blocks_unlocking_but_not_capture() {
    let (mut session, mut server, recovery_key) = setup();
    create(&mut session, &mut server, "已有的", &["密匣"]);
    server.web_unlock = false;
    let reloaded = load(&mut session, &server);
    assert_eq!(reloaded["state"]["unlocked"], false);
    assert_eq!(reloaded["state"]["itemsWithheld"], true);
    for (method, args) in [
        ("unlock", json!({ "password": PASSWORD })),
        ("setup", json!({ "password": PASSWORD })),
        ("change_password", json!({ "currentPassword": PASSWORD, "newPassword": "another password" })),
        ("reset_password", json!({ "recoveryKey": recovery_key, "newPassword": "another password" })),
    ] {
        assert_eq!(message(call(&mut session, method, args)), WEB_UNLOCK_DISABLED, "{method}");
    }
    // 锁着用公钥记入密匣照常可用。
    let created = create(&mut session, &mut server, "关掉网页解锁后记的", &["密匣"]);
    assert_eq!(created["content"], "");
    assert_eq!(server.items.len(), 2);
}

#[test]
fn web_unlock_switch_only_matters_when_the_server_withholds_envelopes() {
    // 桌面连服务器：开关关着，服务器照常下发信封（itemsWithheld = false），照常能解锁。
    let (mut session, mut server, _) = setup();
    create(&mut session, &mut server, "桌面照常能看", &["密匣"]);
    let mut snapshot = server.snapshot();
    snapshot["webUnlock"] = json!(false);
    let reloaded = ok(&mut session, "load", json!({ "snapshot": snapshot.clone() }));
    assert_eq!(reloaded["state"]["unlocked"], true);
    ok(&mut session, "lock", json!({}));
    write(&mut session, &mut server, "unlock", json!({ "password": PASSWORD })).unwrap();
    assert_eq!(list(&mut session)[0].content, "桌面照常能看");
}

#[test]
fn change_and_reset_password_rewrap_only_the_manifest() {
    let (mut session, mut server, recovery_key) = setup();
    let created = create(&mut session, &mut server, "口令换了内容还在", &["密匣"]);
    let id = created["id"].as_str().unwrap().to_string();
    let envelope_before = server.items[&id].envelope.clone();

    let response = ok(&mut session, "change_password", json!({ "currentPassword": PASSWORD, "newPassword": "a new password" }));
    let apply = &response["write"]["apply"];
    assert_eq!(apply["items"], json!([]));
    assert_eq!(apply["manifest"]["expectedSha"], server.manifest.as_ref().unwrap().1.as_str());
    let committed = server.apply(apply).unwrap();
    ok(&mut session, "commit", json!({ "apply": committed }));
    assert_eq!(server.items[&id].envelope, envelope_before);

    ok(&mut session, "lock", json!({}));
    assert_eq!(message(call(&mut session, "unlock", json!({ "password": PASSWORD }))), "密码不正确。");
    write(&mut session, &mut server, "unlock", json!({ "password": "a new password" })).unwrap();
    assert_eq!(list(&mut session)[0].content, "口令换了内容还在");

    ok(&mut session, "lock", json!({}));
    let reset = write(&mut session, &mut server, "reset_password", json!({ "recoveryKey": recovery_key, "newPassword": "third password" })).unwrap();
    assert_ne!(reset["recoveryKey"].as_str().unwrap(), recovery_key);
    assert_eq!(ok(&mut session, "state", json!({}))["unlocked"], true);
    assert_eq!(list(&mut session)[0].content, "口令换了内容还在");
}

fn search_args(query: &str, context: Option<Value>) -> Value {
    json!({
        "vaultPath": "vault-web",
        "request": {
            "clientRequestId": "r1",
            "expectedVaultPath": "vault-web",
            "context": context,
            "scope": "lockbox",
            "includeTrash": false,
            "queryVersion": 1,
            "projectionVersion": 1,
            "query": query,
            "limit": 50,
            "refresh": "auto",
        },
    })
}

#[test]
fn lockbox_search_runs_in_memory_and_reads_targets() {
    let (mut session, mut server, _) = setup();
    create(&mut session, &mut server, "周末去骑行，记下路线", &["密匣", "骑行"]);
    create(&mut session, &mut server, "另一条无关的", &["密匣"]);
    let response = ok(&mut session, "search", search_args("骑行", None));
    assert_eq!(response["total"], 1);
    let hit = &response["hits"][0];
    assert_eq!(hit["target"]["scope"], "lockbox");
    let context = response["context"].clone();

    let read = ok(
        &mut session,
        "read_search_target",
        json!({
            "vaultPath": "vault-web",
            "request": { "clientRequestId": "r2", "expectedVaultPath": "vault-web", "context": context, "target": hit["target"], "expectedRevision": null },
        }),
    );
    assert_eq!(read["fragment"]["content"], "周末去骑行，记下路线");
    assert_eq!(read["fragment"]["lockbox"], true);

    // 上锁再解锁：隐私代次变了，旧上下文过期。
    ok(&mut session, "lock", json!({}));
    write(&mut session, &mut server, "unlock", json!({ "password": PASSWORD })).unwrap();
    let expired = call(&mut session, "search", search_args("骑行", Some(context)));
    assert_eq!(expired, Err(CallError::Search(shard_vault::search::SearchError::ContextExpired)));
    let wrong_vault = call(&mut session, "search", json!({ "vaultPath": "other", "request": search_args("骑行", None)["request"] }));
    assert_eq!(wrong_vault, Err(CallError::Search(shard_vault::search::SearchError::VaultChanged)));
}

#[test]
fn dialect_migration_rewrites_v1_payloads() {
    let (mut session, mut server, _) = setup();
    // 旧桌面写出的 v1 载荷：没有 markdown_dialect 字段。
    let manifest = shard_lockbox::Manifest::parse(&server.manifest.as_ref().unwrap().0).unwrap();
    let id = "20250101-090000-cccccccc-000003";
    let payload = json!({
        "frontmatter": { "id": id, "created_at": "2025-01-01T09:00:00+08:00", "updated_at": "2025-01-01T09:00:00+08:00", "tags": [], "source": "desktop-lockbox" },
        "body": "第一段\n第二段",
    });
    let envelope = Envelope::seal(&WriteKey::Public(manifest.write_public_key().unwrap().unwrap()), id, payload.to_string().as_bytes())
        .unwrap()
        .to_text()
        .unwrap();
    server.items.insert(id.to_string(), ServerItem { sha: sha(&envelope), envelope, path: None });
    load(&mut session, &server);

    let sources = ok(&mut session, "dialect_list", json!({}));
    let sources = sources.as_array().unwrap();
    assert_eq!(sources.len(), 1);
    assert_eq!(sources[0]["path"], "lockbox/fragments/2025/01/20250101-090000-cccccccc-000003.shard");
    let written = write(
        &mut session,
        &mut server,
        "dialect_apply",
        json!({ "files": [{ "path": sources[0]["path"], "expectedSha": sources[0]["sha"], "body": "第一段\n\n第二段" }] }),
    )
    .unwrap();
    assert_eq!(written, 1);
    // 路径没变：服务器上的导出路径仍为空，不泄露任何东西。
    assert!(server.items[id].path.is_none());
    assert!(ok(&mut session, "dialect_list", json!({})).as_array().unwrap().is_empty());
}

// ---------------------------------------------------------------------------
// 与桌面互通
// ---------------------------------------------------------------------------

/// 只比较内容相关字段（`gitStatus` 桌面有 Git、网页没有，不比）。
fn essence(fragments: &[Fragment]) -> BTreeMap<String, Value> {
    fragments
        .iter()
        .map(|fragment| {
            (
                fragment.id.clone(),
                json!({
                    "content": fragment.content,
                    "tags": fragment.tags,
                    "pinned": fragment.pinned,
                    "archived": fragment.archived,
                    "path": fragment.path,
                    "fileSha": fragment.file_sha,
                    "createdAt": fragment.created_at,
                    "properties": fragment.properties,
                    "lockbox": fragment.lockbox,
                }),
            )
        })
        .collect()
}

fn desktop_list(dir: &Path, password: &str) -> Vec<Fragment> {
    let vfs = FsVfs::new(dir);
    let cx = VaultCtx::local(&vfs, &NoHooks);
    let master_key = desktop::unlock_lockbox(&cx, password).unwrap();
    let keys = desktop::read_lockbox_manifest(&vfs).unwrap().read_keys(&master_key).unwrap();
    desktop::list_lockbox_fragments(&cx, &HashSet::new(), &keys).unwrap()
}

#[test]
fn desktop_opens_what_the_web_session_wrote() {
    let (mut session, mut server, _) = setup();
    let unlocked = create(&mut session, &mut server, "网页解锁时写的", &["密匣", "日记"]);
    let archived_id = create(&mut session, &mut server, "网页写了又归档", &["密匣"])["id"].as_str().unwrap().to_string();
    write(&mut session, &mut server, "set_archived", json!({ "id": archived_id, "archived": true })).unwrap();
    write(
        &mut session,
        &mut server,
        "set_property",
        json!({ "id": unlocked["id"], "key": "地点", "value": { "type": "text", "value": "杭州" } }),
    )
    .unwrap();
    ok(&mut session, "lock", json!({}));
    create(&mut session, &mut server, "网页锁着写的", &["密匣"]);
    write(&mut session, &mut server, "unlock", json!({ "password": PASSWORD })).unwrap();

    let dir = tempfile::tempdir().unwrap();
    server.export(dir.path());
    let from_desktop = desktop_list(dir.path(), PASSWORD);
    assert_eq!(from_desktop.len(), 3);
    assert_eq!(essence(&from_desktop), essence(&list(&mut session)));
    let contents: Vec<_> = from_desktop.iter().map(|fragment| fragment.content.as_str()).collect();
    assert!(contents.contains(&"网页锁着写的"));

    // 桌面接着在同一个目录里改，网页重新载入后读得出来。
    let vfs = FsVfs::new(dir.path());
    let cx = VaultCtx::local(&vfs, &NoHooks);
    let master_key = desktop::unlock_lockbox(&cx, PASSWORD).unwrap();
    let keys = desktop::read_lockbox_manifest(&vfs).unwrap().read_keys(&master_key).unwrap();
    let path = shard_vault::find_lockbox_fragment_path(&vfs, unlocked["id"].as_str().unwrap()).unwrap().unwrap();
    desktop::update_lockbox_fragment_in_vault(&cx, &path, &keys, "桌面改过", vec!["日记".into()], None).unwrap();
    let mut session = Session::new();
    ok(&mut session, "load", json!({ "snapshot": snapshot_of_directory(dir.path()) }));
    write(&mut session, &mut FakeServer::new(), "unlock", json!({ "password": PASSWORD })).unwrap();
    let listed = list(&mut session);
    assert!(listed.iter().any(|fragment| fragment.content == "桌面改过"));
}

/// 把一个桌面密匣目录读成服务器快照的样子（导入器做的就是这件事）。
fn snapshot_of_directory(dir: &Path) -> Value {
    let manifest = std::fs::read_to_string(dir.join(".shard/lockbox.json")).unwrap();
    let mut items = Vec::new();
    let vfs = FsVfs::new(dir);
    let mut files = Vec::new();
    shard_vault::collect_lockbox_files(&vfs, &dir.join("lockbox"), &mut files).unwrap();
    for path in files {
        let envelope = vfs.read_to_string(&path).unwrap();
        let id = Envelope::parse(&envelope).unwrap().id;
        let relative = path.strip_prefix(dir).unwrap().to_string_lossy().replace('\\', "/");
        items.push(json!({ "id": id, "sha": sha(&envelope), "envelope": envelope, "path": relative }));
    }
    json!({ "configured": true, "manifest": { "body": manifest, "sha": sha(&manifest) }, "items": items, "itemsWithheld": false, "webUnlock": true })
}

#[test]
fn web_session_opens_what_the_desktop_wrote() {
    let dir = tempfile::tempdir().unwrap();
    let vfs = FsVfs::new(dir.path());
    let cx = VaultCtx::local(&vfs, &NoHooks);
    let setup = desktop::setup_lockbox(&cx, PASSWORD).unwrap();
    let keys = desktop::read_lockbox_manifest(&vfs).unwrap().read_keys(&setup.master_key).unwrap();
    let unlocked = desktop::create_lockbox_fragment(&cx, Some(&keys), "桌面解锁时写的", vec!["读书".into()]).unwrap();
    let locked = desktop::create_lockbox_fragment(&cx, None, "桌面锁着写的", vec![]).unwrap();
    let path = shard_vault::find_lockbox_fragment_path(&vfs, &locked.id).unwrap().unwrap();
    desktop::set_lockbox_fragment_archived_in_vault(&cx, &path, &keys, true).unwrap();
    let path = shard_vault::find_lockbox_fragment_path(&vfs, &unlocked.id).unwrap().unwrap();
    desktop::mutate_lockbox_fragment_property_in_vault(&cx, &path, &keys, "评分", Some(&serde_yaml::Value::from(5))).unwrap();
    // 桌面的笔记（移入密匣的公开笔记）也在 lockbox/notes。
    std::fs::create_dir_all(dir.path().join("notes")).unwrap();
    std::fs::write(
        dir.path().join("notes/私人.md"),
        "---\nid: note-1\ncreated_at: 2026-01-01T00:00:00+08:00\nupdated_at: 2026-01-01T00:00:00+08:00\ntags: []\nsource: desktop\n---\n\n一篇笔记\n",
    )
    .unwrap();
    desktop::move_public_fragment_to_lockbox(&cx, Some(&keys), &dir.path().join("notes/私人.md")).unwrap();
    let from_desktop = desktop_list(dir.path(), PASSWORD);
    assert_eq!(from_desktop.len(), 3);

    let mut session = Session::new();
    ok(&mut session, "load", json!({ "snapshot": snapshot_of_directory(dir.path()) }));
    write(&mut session, &mut FakeServer::new(), "unlock", json!({ "password": PASSWORD })).unwrap();
    assert_eq!(essence(&list(&mut session)), essence(&from_desktop));
}

// ---------------------------------------------------------------------------
// 服务器上的路径不含标题
// ---------------------------------------------------------------------------

fn note_text(id: &str, body: &str) -> String {
    format!("---\nid: {id}\ncreated_at: 2026-10-27T09:00:00+08:00\nupdated_at: 2026-10-27T09:00:00+08:00\ntags:\n- note\nsource: web\n---\n\n{body}\n")
}

fn decrypted_location(server: &FakeServer, id: &str, password: &str) -> Option<String> {
    let manifest = shard_lockbox::Manifest::parse(&server.manifest.as_ref().unwrap().0).unwrap();
    let keys = manifest.read_keys(&manifest.unwrap_with_password(password).unwrap()).unwrap();
    let plain: Value = serde_json::from_slice(&shard_lockbox::open_text(&server.items[id].envelope, &keys).unwrap()).unwrap();
    plain["location"].as_str().map(str::to_string)
}

#[test]
fn moved_notes_keep_their_title_only_inside_the_payload() {
    for locked in [false, true] {
        let (mut session, mut server, _) = setup();
        if locked {
            ok(&mut session, "lock", json!({}));
        }
        let id = "20261027-090000-cccccccc-000003";
        let text = note_text(id, "项目周报正文");
        let path = "notes/项目/周报.md";
        server.public.insert(path.to_string(), (id.to_string(), sha(&text)));
        let moved = write(&mut session, &mut server, "move_public", json!({ "id": id, "path": path, "text": text })).unwrap();
        // 界面拿到的是真实路径；服务器只拿到按 id 推出的路径。
        assert_eq!(moved["path"], "lockbox/notes/项目/周报.shard", "locked={locked}");
        assert_eq!(server.items[id].path.as_deref(), Some(&*format!("lockbox/notes/{id}.shard")), "locked={locked}");
        assert_eq!(moved["fileSha"], server.items[id].sha.as_str(), "locked={locked}");
        let envelope = Envelope::parse(&server.items[id].envelope).unwrap();
        // 锁着时借临时密钥加密后又用 manifest 的公钥重新加密：解锁后用真密钥解得开。
        assert!(envelope.key_algorithm.is_some(), "locked={locked}");
        assert_eq!(decrypted_location(&server, id, PASSWORD).as_deref(), Some("lockbox/notes/项目/周报.shard"));

        // 新会话：锁着时只知道服务器路径；解锁后按载荷还原到真实路径。
        let mut fresh = Session::new();
        load(&mut fresh, &server);
        write(&mut fresh, &mut server, "unlock", json!({ "password": PASSWORD })).unwrap();
        let listed = list(&mut fresh);
        let note = listed.iter().find(|fragment| fragment.id == id).unwrap();
        assert_eq!(note.path, "lockbox/notes/项目/周报.shard");
        assert_eq!(note.content, "项目周报正文");

        // 解锁后改正文：领域函数写回的载荷不带 location，会话补上；服务器路径不变。
        write(&mut fresh, &mut server, "update", json!({ "id": id, "content": "改过的周报", "tags": ["note"] })).unwrap();
        assert_eq!(server.items[id].path.as_deref(), Some(&*format!("lockbox/notes/{id}.shard")));
        assert_eq!(decrypted_location(&server, id, PASSWORD).as_deref(), Some("lockbox/notes/项目/周报.shard"));
        let mut again = Session::new();
        load(&mut again, &server);
        write(&mut again, &mut server, "unlock", json!({ "password": PASSWORD })).unwrap();
        assert_eq!(list(&mut again).iter().find(|fragment| fragment.id == id).unwrap().path, "lockbox/notes/项目/周报.shard");
    }
}

#[test]
fn renamed_fragments_are_concealed_too_and_archiving_moves_the_location() {
    let (mut session, mut server, _) = setup();
    let id = "20261020-080000-dddddddd-000004";
    let text = format!("---\nid: {id}\ncreated_at: 2026-10-20T08:00:00+08:00\nupdated_at: 2026-10-20T08:00:00+08:00\ntags: []\nsource: web\n---\n\n改过名的碎片\n");
    let path = "fragments/2026/10/我的标题.md";
    server.public.insert(path.to_string(), (id.to_string(), sha(&text)));
    let moved = write(&mut session, &mut server, "move_public", json!({ "id": id, "path": path, "text": text })).unwrap();
    assert_eq!(moved["path"], "lockbox/fragments/2026/10/我的标题.shard");
    assert_eq!(server.items[id].path.as_deref(), Some(&*format!("lockbox/fragments/2026/10/{id}.shard")));
    let archived = write(&mut session, &mut server, "set_archived", json!({ "id": id, "archived": true })).unwrap();
    assert_eq!(archived["path"], "lockbox/archive/2026/10/我的标题.shard");
    assert_eq!(server.items[id].path.as_deref(), Some(&*format!("lockbox/archive/2026/10/{id}.shard")));
    assert_eq!(decrypted_location(&server, id, PASSWORD).as_deref(), Some("lockbox/archive/2026/10/我的标题.shard"));
    for item in server.items.values() {
        assert!(!item.path.as_deref().unwrap_or_default().contains("标题"));
    }
}

#[test]
fn legacy_titled_paths_are_migrated_after_unlock() {
    // 桌面（或旧网页）写出的密匣笔记：服务器路径带标题、载荷没有 location。
    let dir = tempfile::tempdir().unwrap();
    let vfs = FsVfs::new(dir.path());
    let cx = VaultCtx::local(&vfs, &NoHooks);
    let setup = desktop::setup_lockbox(&cx, PASSWORD).unwrap();
    let keys = desktop::read_lockbox_manifest(&vfs).unwrap().read_keys(&setup.master_key).unwrap();
    std::fs::create_dir_all(dir.path().join("notes/私人")).unwrap();
    std::fs::write(dir.path().join("notes/私人/日记.md"), note_text("note-legacy", "旧笔记正文")).unwrap();
    desktop::move_public_fragment_to_lockbox(&cx, Some(&keys), &dir.path().join("notes/私人/日记.md")).unwrap();
    desktop::create_lockbox_fragment(&cx, Some(&keys), "普通碎片", vec![]).unwrap();

    let mut server = FakeServer::new();
    let snapshot = snapshot_of_directory(dir.path());
    server.manifest = Some((snapshot["manifest"]["body"].as_str().unwrap().to_string(), snapshot["manifest"]["sha"].as_str().unwrap().to_string()));
    for item in snapshot["items"].as_array().unwrap() {
        server.items.insert(
            item["id"].as_str().unwrap().to_string(),
            ServerItem {
                envelope: item["envelope"].as_str().unwrap().to_string(),
                sha: item["sha"].as_str().unwrap().to_string(),
                path: item["path"].as_str().map(str::to_string),
            },
        );
    }
    assert_eq!(server.items["note-legacy"].path.as_deref(), Some("lockbox/notes/私人/日记.shard"));
    let untouched: Vec<_> = server.items.iter().filter(|(id, _)| *id != "note-legacy").map(|(id, item)| (id.clone(), item.sha.clone())).collect();

    let mut session = Session::new();
    load(&mut session, &server);
    // 锁着不能迁移。
    assert_eq!(message(call(&mut session, "conceal", json!({}))), "lockbox_locked");
    write(&mut session, &mut server, "unlock", json!({ "password": PASSWORD })).unwrap();
    assert_eq!(list(&mut session).iter().find(|f| f.id == "note-legacy").unwrap().path, "lockbox/notes/私人/日记.shard");
    let migrated = write(&mut session, &mut server, "conceal", json!({})).unwrap();
    assert_eq!(migrated, 1);
    assert_eq!(server.items["note-legacy"].path.as_deref(), Some("lockbox/notes/note-legacy.shard"));
    for (id, sha) in untouched {
        assert_eq!(server.items[&id].sha, sha, "不带标题的条目不用动");
    }
    // 再迁移一次：没有要写的。
    assert_eq!(write(&mut session, &mut server, "conceal", json!({})).unwrap(), 0);

    let mut fresh = Session::new();
    load(&mut fresh, &server);
    write(&mut fresh, &mut server, "unlock", json!({ "password": PASSWORD })).unwrap();
    let note = list(&mut fresh).into_iter().find(|f| f.id == "note-legacy").unwrap();
    assert_eq!(note.path, "lockbox/notes/私人/日记.shard");
    assert_eq!(note.content, "旧笔记正文");
}

#[test]
fn update_public_forwards_only_when_it_is_sure_there_is_no_lockbox_tag() {
    let (mut session, _server, _) = setup();
    let id = "20261027-080000-aaaaaaaa-000001";
    let text = format!("---\nid: {id}\ncreated_at: 2026-10-27T08:00:00+08:00\nupdated_at: 2026-10-27T08:00:00+08:00\ntags: []\nsource: web\n---\n\n旧正文\n");
    let path = "fragments/2026/10/20261027-080000-aaaaaaaa-000001.md";
    // 原文里没有这个 id（调用方给错了文件）：报错，不交回服务器。
    assert_eq!(
        message(call(&mut session, "update_public", json!({ "id": "other", "path": path, "text": text, "content": "x #密匣", "tags": ["密匣"] }))),
        "找不到片段 other"
    );
    // 原文解析不了：报错。
    assert!(call(&mut session, "update_public", json!({ "id": id, "path": path, "text": "不是 frontmatter", "content": "x", "tags": ["密匣"] })).is_err());
    // 路径不是公开文档：报错。
    assert!(call(&mut session, "update_public", json!({ "id": id, "path": "lockbox/x.md", "text": text, "content": "x", "tags": ["密匣"] })).is_err());
    // 标签规整后确实没有密匣（「密匣子」不是密匣标签）：交回服务器。
    assert_eq!(
        ok(&mut session, "update_public", json!({ "id": id, "path": path, "text": text, "content": "x", "tags": ["密匣子"] })),
        json!({ "forward": true })
    );
    // 内存资料库没有残留公开文件。
    assert!(list(&mut session).is_empty());
}

#[test]
fn unlock_still_unlocks_when_the_manifest_upgrade_is_rejected() {
    // 旧桌面写出的 manifest（旧派生参数）：解锁时顺带升级口令包裹，要写回 manifest。
    let fixture: Value = serde_json::from_str(
        &std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../shard-lockbox/tests/fixtures/lockbox-desktop-v1.json")).unwrap(),
    )
    .unwrap();
    let password = fixture["password"].as_str().unwrap();
    let manifest = fixture["manifest"].as_str().unwrap();
    let items: Vec<Value> = fixture["envelopes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|envelope| json!({ "id": envelope["id"], "envelope": envelope["text"], "sha": sha(envelope["text"].as_str().unwrap()) }))
        .collect();
    let snapshot = json!({ "configured": true, "manifest": { "body": manifest, "sha": sha(manifest) }, "items": items, "itemsWithheld": false, "webUnlock": true });
    let mut session = Session::new();
    ok(&mut session, "load", json!({ "snapshot": snapshot }));
    let unlocked = ok(&mut session, "unlock", json!({ "password": password }));
    assert!(unlocked["write"]["apply"]["manifest"]["body"].is_string(), "旧参数应当升级");
    // 服务器拒绝（例如浏览器会话没验证通行密钥）：回滚，仍然解锁，内容照常读出。
    let state = ok(&mut session, "rollback", json!({}));
    assert_eq!(state["unlocked"], true);
    let listed = list(&mut session);
    assert_eq!(listed.len(), 2);
    let bodies: Vec<_> = fixture["envelopes"].as_array().unwrap().iter().map(|envelope| envelope["body"].as_str().unwrap()).collect();
    for fragment in &listed {
        assert!(bodies.contains(&fragment.content.as_str()));
    }
    // 下次解锁再升级。
    ok(&mut session, "lock", json!({}));
    assert!(ok(&mut session, "unlock", json!({ "password": password }))["write"]["apply"]["manifest"].is_object());
}
