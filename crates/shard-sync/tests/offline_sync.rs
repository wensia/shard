//! S8b 验收（`docs/dev/server-and-sync-plan.md` §十一，第 9 条换成「从快照恢复后 epoch 变化，客户端全量对账
//! 并找回恢复点之后写下的数据」）：进程内起真的 shard-server，两台设备的同步引擎各用独立临时目录，各自经一个
//! 可开关的代理连服务器（断网 = 代理拒绝连接）。密匣场景本版不做（密匣离线只读，写入需要联网）。

mod support;

use serde_json::{json, Value};
use shard_sync::SyncEvent;
use support::*;

fn setup() -> (tempfile::TempDir, Server, shard_remote::Client) {
    let root = tempfile::tempdir().unwrap();
    let server = start_server(&root.path().join("server"), true);
    let admin = admin(&server, &issue_token(&server, "admin"));
    (root, server, admin)
}

fn server_list(admin: &shard_remote::Client) -> Value {
    admin.read("list_fragments", json!({})).unwrap()
}

/// ① 收敛：两端离线各写（新建 + 改不同的条目）→ 上线 → 两端与服务器一致。
#[test]
fn offline_writes_on_two_devices_converge() {
    let (root, server, admin) = setup();
    let a = Device::new(&server, root.path(), "a");
    let b = Device::new(&server, root.path(), "b");
    assert!(a.sync().error.is_none());
    assert!(b.sync().error.is_none());
    let ride = fragment(&a.local("list_fragments", json!({})), RIDE).unwrap();
    let memo = fragment(&b.local("list_fragments", json!({})), MEMO).unwrap();

    a.offline();
    b.offline();
    let from_a = a.call("create_fragment", json!({ "content": "A 离线记的一条 #通勤", "tags": [] }));
    a.call("update_fragment", update_args(&ride, "A 离线改了骑行：其实是 35 公里。"));
    let from_b = b.call("create_fragment", json!({ "content": "B 离线记的一条" }));
    b.call("update_fragment", update_args(&memo, "B 离线改了备忘。"));
    // 离线时本机看得到自己写的，状态是离线、待上传 2 条。
    assert!(fragment(&a.local("list_fragments", json!({})), from_a["id"].as_str().unwrap()).is_some());
    let status = a.engine.status();
    assert_eq!((status.state, status.pending), ("offline", 2));
    // 服务器上还没有。
    assert!(fragment(&server_list(&admin), from_a["id"].as_str().unwrap()).is_none());

    a.online();
    b.online();
    for device in [&a, &b, &a] {
        let report = device.sync();
        assert!(report.error.is_none(), "{report:?}");
    }
    let truth = server_list(&admin);
    assert_eq!(fragments(&a.local("list_fragments", json!({}))), fragments(&truth));
    assert_eq!(fragments(&b.local("list_fragments", json!({}))), fragments(&truth));
    // 离线显示的 id 补交后不变；内容都在。
    assert_eq!(text(&fragment(&truth, from_a["id"].as_str().unwrap()).unwrap()), "A 离线记的一条 #通勤");
    assert_eq!(text(&fragment(&truth, from_b["id"].as_str().unwrap()).unwrap()), "B 离线记的一条");
    assert_eq!(text(&fragment(&truth, RIDE).unwrap()), "A 离线改了骑行：其实是 35 公里。");
    assert_eq!(text(&fragment(&truth, MEMO).unwrap()), "B 离线改了备忘。");
    for device in [&a, &b] {
        let status = device.engine.status();
        assert_eq!((status.state, status.pending, status.conflicts, status.failed), ("online", 0, 0, 0));
    }
}

/// ② 冲突：同一条两端离线各改 → 先上线的成功，后上线的另存冲突副本，两份内容都在。
#[test]
fn concurrent_edits_keep_both_versions() {
    let (root, server, admin) = setup();
    let a = Device::new(&server, root.path(), "a");
    let b = Device::new(&server, root.path(), "b");
    a.sync();
    b.sync();
    let ride = fragment(&a.local("list_fragments", json!({})), RIDE).unwrap();
    a.offline();
    b.offline();
    a.call("update_fragment", update_args(&ride, "A 的版本"));
    b.call("update_fragment", update_args(&ride, "B 的版本"));

    a.online();
    let first = a.sync();
    assert_eq!((first.acked, first.conflicts), (1, 0), "{first:?}");
    b.online();
    let second = b.sync();
    assert_eq!(second.conflicts, 1, "{second:?}");

    let truth = server_list(&admin);
    assert_eq!(text(&fragment(&truth, RIDE).unwrap()), "A 的版本", "先到的成功，没被覆盖");
    let copies = by_content(&truth, "B 的版本");
    assert_eq!(copies.len(), 1, "后到的另存一份副本");
    assert_eq!(copies[0]["conflictOf"], RIDE);
    let conflicts = b.conflicts();
    assert_eq!(conflicts.len(), 1);
    assert_eq!(conflicts[0].0, RIDE);
    assert_eq!(conflicts[0].1.as_deref(), copies[0]["id"].as_str());
    assert_eq!(conflicts[0].2, "stale");
    // B 本机收敛到服务器的样子；冲突计数等用户看过再清。
    assert_eq!(fragments(&b.local("list_fragments", json!({}))), fragments(&truth));
    assert_eq!(b.engine.status().conflicts, 1);
    b.engine.dismiss_notices();
    assert_eq!(b.engine.status().conflicts, 0);
    // 冲突副本重试不会重复：再跑一轮，服务器上仍只有一份。
    b.sync();
    assert_eq!(by_content(&server_list(&admin), "B 的版本").len(), 1);
}

/// ③ 幽灵复活：A 删除（移入回收站 / 彻底删除），B 离线编辑同一条 → B 上线后不复活，内容另存副本。
#[test]
fn deleted_entries_are_not_resurrected() {
    let (root, server, admin) = setup();
    let a = Device::new(&server, root.path(), "a");
    let b = Device::new(&server, root.path(), "b");
    a.sync();
    b.sync();
    let listed = b.local("list_fragments", json!({}));
    let ride = fragment(&listed, RIDE).unwrap();
    let memo = fragment(&listed, MEMO).unwrap();
    b.offline();
    b.call("update_fragment", update_args(&ride, "B 离线写进骑行的话"));
    b.call("update_fragment", update_args(&memo, "B 离线写进备忘的话"));

    // A 在线：骑行移入回收站；备忘移入回收站后彻底删除。
    a.call("set_fragment_archived", json!({ "id": RIDE, "archived": true }));
    let trashed = a.call("set_fragment_archived", json!({ "id": MEMO, "archived": true }));
    a.call("purge_from_trash", json!({ "path": trashed["path"] }));

    b.online();
    let report = b.sync();
    assert_eq!(report.conflicts, 2, "{report:?}");
    let truth = server_list(&admin);
    let ride_now = fragment(&truth, RIDE).unwrap();
    assert_eq!(ride_now["archived"], true, "仍在回收站");
    assert_eq!(ride_now["content"], ride["content"], "回收站里的那份没被改");
    assert!(fragment(&truth, MEMO).is_none(), "彻底删除的没有复活");
    for (id, text) in [(RIDE, "B 离线写进骑行的话"), (MEMO, "B 离线写进备忘的话")] {
        let copies = by_content(&truth, text);
        assert_eq!(copies.len(), 1, "{text}");
        assert_eq!(copies[0]["conflictOf"], id);
        assert_eq!(copies[0]["archived"], false, "副本在回收站外，看得见");
    }
    assert!(b.conflicts().iter().all(|(_, copy, reason)| copy.is_some() && reason == "deleted"));
    assert_eq!(fragments(&b.local("list_fragments", json!({}))), fragments(&truth));
}

fn png(tag: &str) -> Vec<u8> {
    let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
    bytes.extend_from_slice(format!("shard-offline-image-{tag}").as_bytes());
    bytes
}

/// ④ 附件：A 离线粘贴图片 → 上线后 B 拉取能读到；同一张图重复上传只传一份。
#[test]
fn offline_images_reach_the_other_device_once() {
    let (root, server, admin) = setup();
    let a = Device::new(&server, root.path(), "a");
    let b = Device::new(&server, root.path(), "b");
    a.sync();
    b.sync();
    let bytes = png("a");
    let sha = shard_core::sha256_hex(&bytes);

    a.offline();
    // 与前端一致：先上传字节拿 sha（离线时暂存本机），再用 sha 登记。
    assert_eq!(a.engine.upload_blob(&bytes).unwrap(), sha);
    let path = a.call("save_fragment_image", json!({ "fileName": "江边.png", "blobSha": sha }));
    let path = path.as_str().unwrap().to_string();
    assert_eq!(path, format!("assets/{}/{sha}.png", &sha[..2]));
    // 同一张图再粘贴一次：同一个路径，不多记一条。
    a.engine.upload_blob(&bytes).unwrap();
    assert_eq!(a.call("save_fragment_image", json!({ "fileName": "江边.png", "blobSha": sha })), json!(path));
    let note = a.call("create_fragment", json!({ "content": format!("离线配图 ![江边]({path})") }));
    assert_eq!(a.engine.unsettled(), 2);
    // 离线时本机就能显示这张图。
    let local = a.local("read_fragment_image", json!({ "path": path }));
    assert!(local.as_str().unwrap().starts_with("data:image/png;base64,"));
    assert_eq!(a.engine.local_file(&path).as_deref(), Some(&bytes[..]));

    a.online();
    let report = a.sync();
    assert_eq!((report.acked, report.failed), (2, 0), "{report:?}");
    assert_eq!(a.proxy.count("PUT", &format!("/api/blobs/{sha}")), 1, "字节只上传一次");
    assert_eq!(a.proxy.count("POST", "/api/rpc/save_fragment_image"), 1);

    b.sync();
    let seen = b.local("read_fragment_image", json!({ "path": path }));
    assert_eq!(seen, local, "B 读到的是同一张图");
    assert!(fragment(&b.local("list_fragments", json!({})), note["id"].as_str().unwrap()).is_some());
    // B 也粘贴同一张图：服务器已有，探测后不再上传。
    b.engine.upload_blob(&bytes).unwrap();
    assert_eq!(b.proxy.count("HEAD", &format!("/api/blobs/{sha}")), 1);
    assert_eq!(b.proxy.count("PUT", &format!("/api/blobs/{sha}")), 0);
    let stored = admin.get_bytes(&format!("api/blobs/{sha}")).unwrap();
    assert_eq!(stored.bytes, bytes);
}

/// ⑤ 补交中途断网：请求送达、响应丢失 → 恢复后用同一个 op_id 重试，服务器只有一条。
#[test]
fn lost_responses_are_retried_without_duplicates() {
    let (root, server, admin) = setup();
    let a = Device::new(&server, root.path(), "a");
    a.sync();
    a.offline();
    let created = a.call("create_fragment", json!({ "content": "断网补交只该有一条" }));
    let id = created["id"].as_str().unwrap().to_string();

    a.proxy.set_offline(false);
    a.proxy.drop_next_response("/api/rpc/create_fragment");
    let lost = a.sync();
    assert!(lost.offline, "响应丢了、网络断了：{lost:?}");
    assert_eq!(a.engine.unsettled(), 1, "还没确认，留在 outbox");
    assert_eq!(by_content(&server_list(&admin), "断网补交只该有一条").len(), 1, "其实服务器已经提交了");

    a.online();
    let report = a.sync();
    assert_eq!(report.acked, 1, "{report:?}");
    let sends: Vec<_> = a.proxy.log().into_iter().filter(|entry| entry.path == "/api/rpc/create_fragment").collect();
    assert!(sends.len() >= 2, "{sends:?}");
    assert!(sends.iter().all(|entry| entry.key == sends[0].key), "重试用同一个 op_id：{sends:?}");
    assert!(sends.last().unwrap().replayed, "服务器按幂等键回放第一次的结果");
    let truth = server_list(&admin);
    assert_eq!(by_content(&truth, "断网补交只该有一条").len(), 1, "没有重复行");
    assert!(fragment(&truth, &id).is_some(), "离线时的 id 不变");
    assert_eq!(a.engine.unsettled(), 0);
}

/// ⑥ 从快照恢复：服务器换成旧快照并轮换 epoch → 客户端全量对账，恢复点之后写下的条目推回。
#[test]
fn restoring_a_snapshot_brings_back_later_writes() {
    let (root, server, admin_before) = setup();
    let admin_token = issue_token(&server, "admin2");
    let a = Device::new(&server, root.path(), "a");
    a.sync();
    let snapshot = root.path().join("snapshot");
    server.state.store.snapshot_into(&snapshot).unwrap();

    // 恢复点之后：新建一条、改一条，都已同步到服务器与本机副本。
    let later = a.call("create_fragment", json!({ "content": "恢复点之后写下的" }));
    let ride = fragment(&server_list(&admin_before), RIDE).unwrap();
    a.call("update_fragment", update_args(&ride, "恢复点之后改的骑行"));
    a.sync();

    // 从快照恢复：内容回到恢复点，认证库不回滚（设备令牌照常可用），epoch 轮换。
    let restored = root.path().join("restored");
    std::fs::create_dir_all(&restored).unwrap();
    for name in ["shard.db", "blobs.db"] {
        std::fs::copy(snapshot.join(name), restored.join(name)).unwrap();
    }
    server.state.auth.snapshot_into(&restored.join("auth.db")).unwrap();
    let server2 = start_server(&restored, false);
    server2.state.store.rotate_epoch().unwrap();
    a.proxy.set_backend(&server2.url);
    let admin = admin(&server2, &admin_token);
    assert!(fragment(&server_list(&admin), later["id"].as_str().unwrap()).is_none(), "快照里没有它");

    let report = a.sync();
    assert!(report.reconciled, "{report:?}");
    assert_eq!(report.recovered, 2, "{report:?}");
    let truth = server_list(&admin);
    let back = fragment(&truth, later["id"].as_str().unwrap()).expect("同一个 id 推回了");
    assert_eq!(text(&back), "恢复点之后写下的");
    assert_eq!(back["createdAt"], later["createdAt"]);
    assert_eq!(fragment(&truth, RIDE).unwrap()["content"], ride["content"], "服务器上的旧版本没被覆盖");
    let copies = by_content(&truth, "恢复点之后改的骑行");
    assert_eq!(copies.len(), 1, "较新的本地版本另存为副本");
    assert_eq!(copies[0]["conflictOf"], RIDE);
    assert_eq!(fragments(&a.local("list_fragments", json!({}))), fragments(&truth));
    let recovered = a.events.lock().unwrap().iter().find_map(|event| match event {
        SyncEvent::Recovered { pushed, saved, dir } => Some((*pushed, *saved, dir.clone())),
        _ => None,
    });
    let (pushed, saved, dir) = recovered.expect("通知了找回");
    assert_eq!((pushed, saved), (2, 0));
    // 原文另存一份（不随副本删除）。
    let dir = dir.unwrap();
    assert!(dir.join(later["path"].as_str().unwrap()).is_file());
    // 恢复点之前就有、没变的条目不推回；再同步一轮什么也不发生。
    let again = a.sync();
    assert_eq!((again.acked, again.recovered, again.reconciled), (0, 0, false), "{again:?}");
    assert_eq!(server_list(&admin)["fragments"].as_array().unwrap().len(), truth["fragments"].as_array().unwrap().len());
}

/// ⑦ outbox 合并：离线连续改同一条 10 次只补交一次；新建后再改折进新建。
#[test]
fn consecutive_offline_edits_are_sent_once() {
    let (root, server, admin) = setup();
    let a = Device::new(&server, root.path(), "a");
    a.sync();
    let mut ride = fragment(&a.local("list_fragments", json!({})), RIDE).unwrap();
    a.offline();
    for round in 1..=10 {
        ride = a.call("update_fragment", update_args(&ride, &format!("第 {round} 次改")));
    }
    assert_eq!(a.engine.unsettled(), 1);
    let mut created = a.call("create_fragment", json!({ "content": "新建后又改" }));
    for round in 1..=3 {
        created = a.call("update_fragment", update_args(&created, &format!("新建后又改 v{round}")));
    }
    a.call("set_fragment_pinned", json!({ "id": RIDE, "pinned": true }));
    a.call("set_fragment_pinned", json!({ "id": RIDE, "pinned": false }));
    a.call("set_fragment_pinned", json!({ "id": RIDE, "pinned": true }));
    assert_eq!(a.engine.unsettled(), 3, "改正文 1 条 + 新建 1 条 + 置顶 1 条");

    a.online();
    a.proxy.clear_log();
    let report = a.sync();
    assert_eq!((report.acked, report.conflicts), (3, 0), "{report:?}");
    assert_eq!(a.proxy.count("POST", "/api/rpc/update_fragment"), 1, "十次修改只补交一次");
    assert_eq!(a.proxy.count("POST", "/api/rpc/create_fragment"), 1);
    assert_eq!(a.proxy.count("POST", "/api/rpc/set_fragment_pinned"), 1);
    let truth = server_list(&admin);
    let ride_now = fragment(&truth, RIDE).unwrap();
    assert_eq!(text(&ride_now), "第 10 次改");
    assert_eq!(ride_now["pinned"], true);
    assert_eq!(text(&fragment(&truth, created["id"].as_str().unwrap()).unwrap()), "新建后又改 v3");
}

/// ⑧ 离线禁止的命令报「需要联网」，什么也不记、什么也不改。
#[test]
fn structural_commands_need_the_network() {
    let (root, server, admin) = setup();
    let a = Device::new(&server, root.path(), "a");
    a.sync();
    let before = server_list(&admin);
    a.offline();
    let refused = [
        ("create_library_note", json!({ "title": "离线新建的笔记" })),
        ("create_library_directory", json!({ "name": "离线目录" })),
        ("rename_library_entry", json!({ "path": "notes/读书/书单.md", "newName": "书单2" })),
        ("move_library_entry", json!({ "path": "notes/读书/书单.md", "destinationDirectory": "notes" })),
        ("delete_library_entry", json!({ "path": "notes/读书/书单.md" })),
        ("set_fragment_archived", json!({ "id": RIDE, "archived": true })),
        ("restore_from_trash", json!({ "path": ".trash/fragments/2026/09/20260915-180000-e5f6a7b8-4a4b4c.md" })),
        ("empty_trash", json!({})),
        ("convert_fragment_to_note", json!({ "id": RIDE })),
        ("import_library_blobs", json!({ "files": [] })),
        ("write_mind_map", json!({ "id": "x", "file": {}, "expectedRevision": 1, "lastSavedHash": "x" })),
        ("write_canvas", json!({ "path": "notes/x.shardflow.json" })),
        ("apply_dataset_ops", json!({ "path": "datasets/阅读记录.csv", "expectedSha": "x", "ops": [] })),
        ("register_property_type", json!({ "key": "k", "propertyType": "text", "expectedSha": "x" })),
        ("lockbox_apply", json!({ "puts": [] })),
        ("seal_fragment_into_lockbox", json!({ "fragmentId": RIDE })),
        ("list_revisions", json!({ "path": "notes/读书/书单.md" })),
        // 锁着速记（带密匣标签的新建）离线也拒绝。
        ("create_fragment", json!({ "content": "要放进密匣的", "tags": ["密匣"] })),
    ];
    for (command, args) in refused {
        let error = a.try_call(command, args).expect_err(command);
        assert_eq!(error.status, None, "{command}：{error:?}");
        assert!(error.message.starts_with("需要联网："), "{command}：{}", error.message);
    }
    assert_eq!(a.engine.unsettled(), 0, "被拒绝的命令不进 outbox");
    // 允许的照常离线完成。
    a.call("set_fragment_pinned", json!({ "id": RIDE, "pinned": true }));
    assert_eq!(a.engine.unsettled(), 1);
    a.online();
    a.sync();
    let after = server_list(&admin);
    assert_eq!(after["fragments"].as_array().unwrap().len(), before["fragments"].as_array().unwrap().len());
    assert_eq!(fragment(&after, RIDE).unwrap()["pinned"], true);
}

/// ⑨ 离线读：列表、资料库树、搜索、读文档在断网时返回副本内容，与在线时服务器给的同形同值。
#[test]
fn offline_reads_match_the_server() {
    let (root, server, _admin) = setup();
    let a = Device::new(&server, root.path(), "a");
    a.sync();
    let vault = a.call("list_fragments", json!({}))["vaultPath"].clone();
    let search = |query: &str| {
        json!({ "request": {
            "clientRequestId": format!("search-{query}"), "expectedVaultPath": vault,
            "context": null, "scope": "public", "includeTrash": false, "queryVersion": 1, "projectionVersion": 1,
            "query": query, "limit": 50, "refresh": "auto"
        } })
    };
    // 在线：经引擎直发服务器（顺带缓存了 vaultPath 等离线要用的信息）。
    let reads = [
        ("list_fragments", json!({})),
        ("list_library_tree", json!({})),
        ("list_mind_maps", json!({})),
        ("list_csv_files", json!({})),
        ("read_csv_file", json!({ "path": "datasets/阅读记录.csv" })),
        ("read_dataset", json!({ "path": "datasets/阅读记录.csv" })),
        ("read_property_registry", json!({})),
        ("list_diagram_documents", json!({})),
        ("read_fragment_image", json!({ "path": "notes/证件/营业执照（示例）.png" })),
    ];
    let online: Vec<Value> = reads.iter().map(|(command, args)| a.call(command, args.clone())).collect();
    let online_search = a.call("search_vault", search("骑行"));
    let maps = a.call("list_mind_maps", json!({}));
    let map_id = maps[0]["id"].clone();
    let online_map = a.call("read_mind_map", json!({ "id": map_id }));
    assert!(online_search["hits"].as_array().is_some_and(|hits| !hits.is_empty()));

    a.offline();
    for ((command, args), expected) in reads.iter().zip(&online) {
        assert_eq!(&a.call(command, args.clone()), expected, "离线 {command} 与在线不同");
    }
    let offline_search = a.call("search_vault", search("骑行"));
    assert_eq!(offline_search["hits"], online_search["hits"]);
    assert_eq!(offline_search["context"], online_search["context"]);
    let hit = &offline_search["hits"][0];
    let target = a.call(
        "read_search_target",
        json!({ "request": {
            "clientRequestId": "read-1", "expectedVaultPath": offline_search["context"]["vaultPath"],
            "context": offline_search["context"], "target": hit["target"], "expectedRevision": hit["revision"]
        } }),
    );
    assert_eq!(target["target"], hit["target"]);
    assert_eq!(a.call("read_mind_map", json!({ "id": map_id })), online_map);
    assert_eq!(a.engine.status().state, "offline");

    // 离线写下的也能离线读到、搜到。
    let created = a.call("create_fragment", json!({ "content": "离线记下的独特词：山茶花" }));
    let listed = a.call("list_fragments", json!({}));
    assert_eq!(fragment(&listed, created["id"].as_str().unwrap()).unwrap()["fileSha"], created["fileSha"]);
    let found = a.call("search_vault", search("山茶花"));
    assert_eq!(found["hits"][0]["target"]["objectId"], created["id"]);
}

/// 服务器抹除（彻底删除后立即抹除 / 移入密匣）推进了保留下限：增量拉取得到 410，全量对账后本地不再有该路径，
/// 也不当作「恢复备份后丢失的新建」推回；本地还有没补交的修改的，另存冲突副本。
#[test]
fn erased_entries_trigger_resync_without_resurrection() {
    let (root, server, admin) = setup();
    let a = Device::new(&server, root.path(), "a");
    let kept = admin.write("create_library_note", json!({ "title": "要被抹除的笔记" })).unwrap();
    let edited = admin.write("create_library_note", json!({ "title": "离线改过又被抹除的笔记" })).unwrap();
    let kept = kept["fragment"].clone();
    let edited = edited["fragment"].clone();
    a.sync();
    let local = a.local("list_fragments", json!({}));
    assert!(fragment(&local, kept["id"].as_str().unwrap()).is_some());
    let edited_local = fragment(&local, edited["id"].as_str().unwrap()).unwrap();

    a.offline();
    a.call("update_fragment", update_args(&edited_local, "离线写进这篇笔记的话"));

    // 服务器上：两篇都删除、彻底删除，再立即抹除。
    for note in [&kept, &edited] {
        let trashed = admin.write("delete_library_entry", json!({ "path": note["path"] })).unwrap();
        let _ = trashed;
        let trash_path = format!(".trash/{}", note["path"].as_str().unwrap());
        admin.write("purge_from_trash", json!({ "path": trash_path })).unwrap();
    }
    let node_ids: Vec<i64> = server.state.store.list_deleted().unwrap().iter().map(|entry| entry.node_id).collect();
    server.state.store.erase_purged(&node_ids).unwrap();

    a.online();
    a.proxy.clear_log();
    let report = a.sync();
    assert!(report.reconciled, "游标早于保留下限：全量对账 {report:?}");
    assert_eq!(report.recovered, 0, "同一个 epoch：不是恢复备份，不推回");
    assert!(a.proxy.log().iter().any(|entry| entry.path.starts_with("/api/sync/changes") && entry.status == Some(410)));
    let truth = server_list(&admin);
    for note in [&kept, &edited] {
        assert!(fragment(&truth, note["id"].as_str().unwrap()).is_none(), "没有复活");
    }
    // 没改过的：副本里删掉；改过的：本地版本另存冲突副本。
    let copies = by_content(&truth, "离线写进这篇笔记的话");
    assert_eq!(copies.len(), 1);
    assert_eq!(copies[0]["conflictOf"], edited["id"]);
    assert_eq!(a.proxy.count("POST", "/api/rpc/create_fragment"), 1, "只推了冲突副本");
    assert_eq!(fragments(&a.local("list_fragments", json!({}))), fragments(&truth));
    let tree = a.local("list_library_tree", json!({}));
    assert!(!tree.to_string().contains("要被抹除的笔记"), "本地树里也没有了");
}

/// 前一条已经发出过（服务器可能已提交，响应丢了）、之后又离线改了同一条：后一条的基线是本地结果，
/// 补交时换成前一条的服务器结果，不会误判冲突。
#[test]
fn chained_edits_after_a_lost_response_do_not_conflict() {
    let (root, server, admin) = setup();
    let a = Device::new(&server, root.path(), "a");
    a.sync();
    let ride = fragment(&a.local("list_fragments", json!({})), RIDE).unwrap();
    a.offline();
    let first = a.call("update_fragment", update_args(&ride, "第一版"));

    a.proxy.set_offline(false);
    a.proxy.drop_next_response("/api/rpc/update_fragment");
    assert!(a.sync().offline);
    assert_eq!(text(&fragment(&server_list(&admin), RIDE).unwrap()), "第一版", "服务器其实已提交");
    // 还离线：基于本地的第一版再改（前一条发出过，不能再合并）。
    a.call("update_fragment", update_args(&first, "第二版"));
    assert_eq!(a.engine.unsettled(), 2);

    a.online();
    let report = a.sync();
    assert_eq!((report.acked, report.conflicts, report.failed), (2, 0, 0), "{report:?}");
    let truth = server_list(&admin);
    assert_eq!(text(&fragment(&truth, RIDE).unwrap()), "第二版");
    assert!(by_content(&truth, "第一版").is_empty(), "没有多出冲突副本");
    assert_eq!(fragments(&a.local("list_fragments", json!({}))), fragments(&truth));
}

/// 在线直发的写，请求送达后响应丢了：同一个 op_id、同一个请求体转进 outbox，本机照常显示，
/// 联网后服务器按幂等键回放，只有一条，id 与本机显示的一致。
#[test]
fn online_writes_fall_back_to_the_outbox_with_the_same_key() {
    let (root, server, admin) = setup();
    let a = Device::new(&server, root.path(), "a");
    a.sync();
    a.proxy.drop_next_response("/api/rpc/create_fragment");
    let created = a.call("create_fragment", json!({ "content": "在线发出、响应丢了的一条" }));
    assert_eq!(a.engine.status().state, "offline");
    assert_eq!(a.engine.unsettled(), 1);
    let id = created["id"].as_str().unwrap();
    assert!(fragment(&a.local("list_fragments", json!({})), id).is_some(), "本机照常显示");

    a.online();
    let report = a.sync();
    assert_eq!(report.acked, 1, "{report:?}");
    let keys: Vec<_> = a.proxy.log().into_iter().filter(|entry| entry.path == "/api/rpc/create_fragment").map(|entry| entry.key).collect();
    assert!(keys.len() >= 2 && keys.iter().all(|key| key == &keys[0]), "{keys:?}");
    let truth = server_list(&admin);
    assert_eq!(by_content(&truth, "在线发出、响应丢了的一条").len(), 1);
    assert!(fragment(&truth, id).is_some());
}

/// 后台同步线程：本地写触发补交，断网时退避，联网（实时通道恢复）后自动收敛；与前台的读写并发不死锁。
#[test]
fn the_background_runner_converges_on_its_own() {
    use std::time::{Duration, Instant};
    let (root, server, admin) = setup();
    let a = Device::new(&server, root.path(), "a");
    let runner = shard_sync::SyncRunner::start(a.engine.clone());
    let wait_until = |what: &str, check: &dyn Fn() -> bool| {
        let deadline = Instant::now() + Duration::from_secs(20);
        while !check() {
            assert!(Instant::now() < deadline, "等不到：{what}");
            std::thread::sleep(Duration::from_millis(20));
        }
    };
    wait_until("首轮同步", &|| a.engine.replica_ready());
    a.offline();
    a.engine.note_link(false);
    let mut written = Vec::new();
    for round in 0..5 {
        let created = a.call("create_fragment", json!({ "content": format!("后台补交 {round}") }));
        written.push(created["id"].as_str().unwrap().to_string());
        let _ = a.call("list_fragments", json!({}));
    }
    assert_eq!(a.engine.status().state, "offline");
    a.proxy.set_offline(false);
    a.engine.note_link(true);
    wait_until("补交完成", &|| a.engine.unsettled() == 0);
    wait_until("服务器上都有", &|| {
        let truth = server_list(&admin);
        written.iter().all(|id| fragment(&truth, id).is_some())
    });
    runner.stop();
}

/// 合并的其余几条：改标签后改正文 → 一条 update（基线取改标签之前）；同一个属性改两次 → 一条；
/// 不同属性各自一条。
#[test]
fn field_edits_merge_by_field() {
    let (root, server, admin) = setup();
    let a = Device::new(&server, root.path(), "a");
    a.sync();
    let ride = fragment(&a.local("list_fragments", json!({})), RIDE).unwrap();
    a.offline();
    let tagged = a.call("update_fragment_tags", json!({ "id": RIDE, "tags": ["inbox", "骑行", "周末"] }));
    a.call("update_fragment", update_args(&tagged, "改完标签又改正文"));
    a.call("set_fragment_property", json!({ "id": RIDE, "key": "里程", "value": { "type": "number", "value": "32" } }));
    a.call("set_fragment_property", json!({ "id": RIDE, "key": "里程", "value": { "type": "number", "value": "35" } }));
    assert_eq!(a.engine.unsettled(), 2, "标签+正文一条，属性一条");
    let _ = ride;
    a.online();
    a.proxy.clear_log();
    let report = a.sync();
    assert_eq!((report.acked, report.conflicts, report.failed), (2, 0, 0), "{report:?}");
    assert_eq!(a.proxy.count("POST", "/api/rpc/update_fragment"), 1);
    assert_eq!(a.proxy.count("POST", "/api/rpc/update_fragment_tags"), 0);
    assert_eq!(a.proxy.count("POST", "/api/rpc/set_fragment_property"), 1);
    let now = fragment(&server_list(&admin), RIDE).unwrap();
    assert_eq!(text(&now), "改完标签又改正文");
    assert!(now["tags"].as_array().unwrap().iter().any(|tag| tag == "周末"), "{now}");
    assert!(now["properties"].to_string().contains("35"), "{}", now["properties"]);
}

/// 密匣（本版离线只读）：在线时快照照常问服务器并缓存密文；断网时给缓存的快照（列表与解锁只读可用），
/// 有待补交的公开修改时也仍问服务器（密匣不在本机层里）；密匣写入离线一律需要联网。
#[test]
fn lockbox_snapshots_are_cached_for_offline_reading_only() {
    let (root, server, _admin) = setup();
    let a = Device::new(&server, root.path(), "a");
    a.sync();
    let online = a.call("lockbox_snapshot", json!({}));
    a.offline();
    assert_eq!(a.call("lockbox_snapshot", json!({})), online, "断网：缓存的快照");
    a.call("set_fragment_pinned", json!({ "id": RIDE, "pinned": true }));
    let refused = a.try_call("lockbox_apply", json!({ "puts": [] })).unwrap_err();
    assert!(refused.message.starts_with("需要联网：密匣"), "{}", refused.message);
    // 联网但还没补交：快照仍然问服务器。
    a.proxy.set_offline(false);
    a.engine.note_link(true);
    a.proxy.clear_log();
    a.call("lockbox_snapshot", json!({}));
    assert_eq!(a.proxy.count("POST", "/api/rpc/lockbox_snapshot"), 1);
    assert_eq!(a.engine.unsettled(), 1, "还没同步，修改仍待补交");
}
