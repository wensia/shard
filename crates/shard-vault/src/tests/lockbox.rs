//! 密匣领域函数（[`crate::lockbox`]）的双实现测试：同一组用例在本地目录（FsVfs）与内存资料库
//! （MemVfs，浏览器里要用的那个）上各跑一遍，断言在两边都成立，并比对两边归一化后的结果
//! （随机 id、年月目录、时间与密文哈希抹掉）。
//!
//! RSA 密钥对在调试构建里生成很慢：除了专门测设置与旧 manifest 升级的用例，其余共用一份预先生成的 manifest。

use super::*;
use crate::lockbox::*;
use crate::search::{SearchError, SearchScope};
use shard_core::{MemVfs, MARKDOWN_DIALECT};
use shard_lockbox::{normalize_recovery_key, Envelope, Manifest, ReadKeys, WriteKey, FRAGMENT_KEY_ALGORITHM};

const PASSWORD: &str = "correct horse";
const LOCKBOX_IMAGE_ERROR: &str = "密匣暂不支持图片附件。请先移除图片，再保存到密匣。";

/// 预先设置好的密匣：manifest 原文与主密钥。
struct Fixture {
    manifest_text: String,
    master_key: Vec<u8>,
}

fn fixture() -> &'static Fixture {
    static FIXTURE: OnceLock<Fixture> = OnceLock::new();
    FIXTURE.get_or_init(|| {
        let vfs = MemVfs::new("/fixture");
        let setup = setup_lockbox(&VaultCtx::local(&vfs, &NoHooks), PASSWORD).unwrap();
        Fixture {
            manifest_text: vfs.read_to_string(&lockbox_manifest_path(vfs.root())).unwrap(),
            master_key: setup.master_key,
        }
    })
}

fn fixture_keys() -> ReadKeys {
    Manifest::parse(&fixture().manifest_text)
        .unwrap()
        .read_keys(&fixture().master_key)
        .unwrap()
}

enum Store {
    Fs { vfs: FsVfs, _dir: tempfile::TempDir },
    Mem(MemVfs),
}

struct Bench {
    store: Store,
    hooks: NoHooks,
}

impl Bench {
    fn fs() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let vfs = FsVfs::new(dir.path());
        Self::prepared(Store::Fs { vfs, _dir: dir })
    }

    fn mem() -> Self {
        Self::prepared(Store::Mem(MemVfs::new("/vault")))
    }

    fn prepared(store: Store) -> Self {
        let bench = Self { store, hooks: NoHooks };
        ensure_vault_layout(bench.vfs()).unwrap();
        bench
    }

    fn name(&self) -> &'static str {
        match self.store {
            Store::Fs { .. } => "FsVfs",
            Store::Mem(_) => "MemVfs",
        }
    }

    fn vfs(&self) -> &dyn Vfs {
        match &self.store {
            Store::Fs { vfs, .. } => vfs,
            Store::Mem(vfs) => vfs,
        }
    }

    fn cx(&self) -> VaultCtx<'_> {
        VaultCtx::local(self.vfs(), &self.hooks)
    }

    fn path(&self, rel: &str) -> PathBuf {
        self.vfs().root().join(rel)
    }

    fn read(&self, rel: &str) -> String {
        self.vfs().read_to_string(&self.path(rel)).unwrap()
    }

    fn exists(&self, rel: &str) -> bool {
        self.vfs().exists(&self.path(rel))
    }

    /// 放进共用的 manifest：已设置、会话由测试自己用 [`fixture_keys`] 模拟。
    fn with_lockbox(self) -> Self {
        ensure_lockbox_layout(self.vfs()).unwrap();
        self.vfs()
            .write_atomic(&lockbox_manifest_path(self.vfs().root()), fixture().manifest_text.as_bytes())
            .unwrap();
        self
    }

    fn payload(&self, rel: &str, keys: &ReadKeys) -> LockboxFragmentPayload {
        read_lockbox_payload(self.vfs(), &self.path(rel), keys).unwrap()
    }

    /// 全部文件的相对路径（经 Vfs 遍历，两边同一套代码），id 与年月目录归一化。
    fn files(&self, ids: &[&str]) -> Vec<String> {
        fn walk(vfs: &dyn Vfs, dir: &Path, root: &Path, out: &mut Vec<String>) {
            for entry in vfs.read_dir(dir).unwrap() {
                let path = entry.path();
                if entry.file_type().unwrap().is_dir() {
                    walk(vfs, &path, root, out);
                } else {
                    out.push(relative_path(root, &path).unwrap());
                }
            }
        }
        let mut out = Vec::new();
        walk(self.vfs(), self.vfs().root(), self.vfs().root(), &mut out);
        let mut out = out.into_iter().map(|path| norm_path(&path, ids)).collect::<Vec<_>>();
        out.sort();
        out
    }
}

/// 把 id 换成 `<id>`，把纯数字的年 / 月目录换成 `<n>`：两次运行的时刻不同。
fn norm_path(path: &str, ids: &[&str]) -> String {
    let mut path = path.to_string();
    for id in ids {
        path = path.replace(id, "<id>");
    }
    path.split('/')
        .map(|part| {
            if (part.len() == 4 || part.len() == 2) && part.chars().all(|c| c.is_ascii_digit()) {
                "<n>"
            } else {
                part
            }
        })
        .collect::<Vec<_>>()
        .join("/")
}

/// 碎片 DTO 里与运行时刻无关的部分。
fn summary(fragment: &Fragment) -> String {
    let properties = fragment
        .properties
        .iter()
        .map(|property| property.key.as_str())
        .collect::<Vec<_>>();
    format!(
        "{} content={:?} tags={:?} pinned={} archived={} lockbox={} git={} error={:?} props={properties:?}",
        norm_path(&fragment.path, &[&fragment.id]),
        fragment.content,
        fragment.tags,
        fragment.pinned,
        fragment.archived,
        fragment.lockbox,
        fragment.git_status,
        fragment.error,
    )
}

/// 同一个场景在两种存储上各跑一遍（各自从空资料库开始），两边的摘要必须相同。
fn on_both(scenario: impl Fn(&Bench) -> Vec<String>) {
    let local = scenario(&Bench::fs());
    let memory = scenario(&Bench::mem());
    assert_eq!(local, memory, "FsVfs 与 MemVfs 的结果不同");
}

/// 同 [`on_both`]，资料库里先放好共用的 manifest（密匣已设置）。
fn on_both_with_lockbox(scenario: impl Fn(&Bench) -> Vec<String>) {
    let local = scenario(&Bench::fs().with_lockbox());
    let memory = scenario(&Bench::mem().with_lockbox());
    assert_eq!(local, memory, "FsVfs 与 MemVfs 的结果不同");
}

fn envelope_algorithm(bench: &Bench, rel: &str) -> Option<String> {
    Envelope::parse(&bench.read(rel)).unwrap().key_algorithm
}

#[test]
fn setup_unlock_change_and_reset_password() {
    on_both(|bench| {
        let cx = bench.cx();
        let name = bench.name();
        assert_eq!(setup_lockbox(&cx, "short").err().unwrap(), "密匣密码至少需要 8 个字符。");
        assert!(!bench.exists(".shard/lockbox.json"));

        let setup = setup_lockbox(&cx, PASSWORD).unwrap();
        assert!(setup.recovery_key.starts_with("shard-"), "{name}");
        assert!(bench.vfs().is_dir(&bench.path("lockbox/fragments")));
        assert!(bench.vfs().is_dir(&bench.path("lockbox/archive")));
        assert_eq!(setup_lockbox(&cx, PASSWORD).err().unwrap(), "密匣已经设置。");

        assert_eq!(unlock_lockbox(&cx, "wrong password").unwrap_err(), "密码不正确。");
        assert_eq!(unlock_lockbox(&cx, PASSWORD).unwrap(), setup.master_key);

        assert_eq!(
            change_lockbox_password(&cx, "wrong password", "new password").unwrap_err(),
            "密码不正确。"
        );
        assert_eq!(
            change_lockbox_password(&cx, PASSWORD, "short").unwrap_err(),
            "密匣密码至少需要 8 个字符。"
        );
        assert_eq!(change_lockbox_password(&cx, PASSWORD, "new password").unwrap(), setup.master_key);
        assert!(unlock_lockbox(&cx, PASSWORD).is_err());
        assert_eq!(unlock_lockbox(&cx, "new password").unwrap(), setup.master_key);

        let reset = reset_lockbox_password(&cx, &setup.recovery_key, "reset password").unwrap();
        assert_ne!(normalize_recovery_key(&reset.recovery_key), normalize_recovery_key(&setup.recovery_key));
        assert_eq!(reset.master_key, setup.master_key);
        assert_eq!(
            reset_lockbox_password(&cx, &setup.recovery_key, "another password").err().unwrap(),
            "恢复密钥不正确。"
        );
        assert!(unlock_lockbox(&cx, "new password").is_err());
        assert_eq!(unlock_lockbox(&cx, "reset password").unwrap(), setup.master_key);
        bench.files(&[])
    });
}

#[test]
fn create_while_locked_uses_the_public_key_and_reads_back_after_unlock() {
    on_both_with_lockbox(|bench| {
        let keys = fixture_keys();
        let name = bench.name();
        let cx = bench.cx();
        let before = bench.files(&[]);

        let locked = create_lockbox_fragment(
            &cx,
            None,
            "锁着写的 #甲",
            vec!["inbox".into(), LOCKBOX_TAG.into(), "work".into()],
        )
        .unwrap();
        assert_eq!(locked.content, "", "{name}：锁着时只返回投影");
        assert!(locked.lockbox && !locked.archived);
        assert!(locked.path.starts_with("lockbox/fragments/"), "{}", locked.path);
        assert_eq!(locked.file_sha, content_sha256_hex(&bench.read(&locked.path)));
        assert_eq!(envelope_algorithm(bench, &locked.path).as_deref(), Some(FRAGMENT_KEY_ALGORITHM));
        let read = read_lockbox_fragment(&cx, &bench.path(&locked.path), &HashSet::new(), &keys, None).unwrap();
        assert_eq!(read.content, "锁着写的 #甲");
        let payload = bench.payload(&locked.path, &keys);
        assert_eq!(payload.frontmatter.source, "desktop-lockbox");
        assert_eq!(payload.markdown_dialect, Some(MARKDOWN_DIALECT));

        // 网页端：来源记为 web-lockbox，时间按调用方时区。
        let offset = FixedOffset::east_opt(14 * 3600).unwrap();
        let web = cx.with_clock(offset, "web");
        let unlocked = create_lockbox_fragment(&web, Some(&keys), "网页写的", vec![]).unwrap();
        assert_eq!(unlocked.content, "网页写的", "{name}：解锁后读回明文");
        assert!(unlocked.created_at.ends_with("+14:00"), "{}", unlocked.created_at);
        assert_eq!(bench.payload(&unlocked.path, &keys).frontmatter.source, "web-lockbox");

        // 拒绝图片与受保护类型，不留文件。
        let after_creates = bench.files(&[&locked.id, &unlocked.id]);
        assert_eq!(
            create_lockbox_fragment(&cx, Some(&keys), "![图](assets/a.png)", vec![]).unwrap_err(),
            LOCKBOX_IMAGE_ERROR
        );
        assert_eq!(
            create_lockbox_fragment(&cx, None, "受保护", vec!["outline".into()]).unwrap_err(),
            LOCKBOX_TYPE_ERROR
        );
        assert_eq!(bench.files(&[&locked.id, &unlocked.id]), after_creates);

        assert_eq!(list_lockbox_fragments(&cx, &HashSet::new(), &keys).unwrap().len(), 2);
        assert_eq!(
            find_lockbox_fragment_path(cx.vfs, &locked.id).unwrap(),
            Some(bench.path(&locked.path))
        );

        let mut out = before;
        out.extend([summary(&locked), summary(&read), summary(&unlocked)]);
        out.extend(after_creates);
        out
    });
}

#[test]
fn legacy_manifest_gets_a_write_key_only_when_unlocked() {
    // 纯函数：有密钥对直接用公钥；没有时必须给主密钥，补上后报告需要回写。
    let mut manifest = Manifest::parse(&fixture().manifest_text).unwrap();
    let (key, upgraded) = lockbox_write_key(&mut manifest, None).unwrap();
    assert!(matches!(key, WriteKey::Public(_)) && !upgraded);
    manifest.write_public_key = None;
    manifest.write_private_key_nonce = None;
    manifest.write_private_key_ciphertext = None;
    let legacy_text = manifest.to_text().unwrap();
    assert_eq!(
        lockbox_write_key(&mut manifest.clone(), None).err().unwrap(),
        "密匣需要先解锁一次以启用免密码写入。"
    );

    on_both(|bench| {
        let cx = bench.cx();
        ensure_lockbox_layout(bench.vfs()).unwrap();
        bench.vfs().write_atomic(&bench.path(".shard/lockbox.json"), legacy_text.as_bytes()).unwrap();
        let before = bench.files(&[]);

        assert_eq!(
            create_lockbox_fragment(&cx, None, "锁着写不进去", vec![]).unwrap_err(),
            "密匣需要先解锁一次以启用免密码写入。"
        );
        assert_eq!(bench.files(&[]), before);
        assert_eq!(bench.read(".shard/lockbox.json"), legacy_text);

        // 解锁态的读取密钥来自旧 manifest，还没有写入私钥；补上密钥对后必须按新 manifest 读回。
        let legacy_keys = Manifest::parse(&legacy_text).unwrap().read_keys(&fixture().master_key).unwrap();
        assert!(legacy_keys.write_private_key.is_none());
        let created = create_lockbox_fragment(&cx, Some(&legacy_keys), "补上密钥后写入", vec![]).unwrap();
        assert_eq!(created.content, "补上密钥后写入", "{}", bench.name());
        assert!(read_lockbox_manifest(cx.vfs).unwrap().has_write_key());
        assert_eq!(envelope_algorithm(bench, &created.path).as_deref(), Some(FRAGMENT_KEY_ALGORITHM));

        let mut out = vec![summary(&created)];
        out.extend(bench.files(&[&created.id]));
        out
    });
}

#[test]
fn updates_check_the_encrypted_file_as_the_save_baseline() {
    on_both_with_lockbox(|bench| {
        let cx = bench.cx();
        let keys = fixture_keys();
        let created = create_lockbox_fragment(&cx, Some(&keys), "第一版正文", vec![]).unwrap();
        let path = bench.path(&created.path);
        let stale_sha = content_sha256_hex(&bench.read(&created.path));

        // 外部（例如同步）改写了信封：旧基线保存必须拒绝，文件不动。
        let mut payload = bench.payload(&created.path, &keys);
        payload.frontmatter_raw = Some(format!("{}\nexternal: true\n", payload.frontmatter_raw.as_deref().unwrap()));
        write_lockbox_payload(cx.vfs, &path, &WriteKey::Master(keys.master_key.clone()), &payload).unwrap();
        let before = bench.read(&created.path);
        assert_eq!(
            update_lockbox_fragment_in_vault(&cx, &path, &keys, "第二版正文", vec![], Some(&stale_sha)).unwrap_err(),
            STALE_BASE_ERROR
        );
        assert_eq!(bench.read(&created.path), before);
        assert_eq!(
            update_lockbox_fragment_in_vault(&cx, &path, &keys, "![图](a.png)", vec![], None).unwrap_err(),
            LOCKBOX_IMAGE_ERROR
        );
        assert_eq!(bench.read(&created.path), before);

        let fresh_sha = content_sha256_hex(&before);
        let updated = update_lockbox_fragment_in_vault(
            &cx,
            &path,
            &keys,
            "第二版正文",
            vec![LOCKBOX_TAG.into(), "新标签".into()],
            Some(&fresh_sha),
        )
        .unwrap();
        assert_eq!(updated.content, "第二版正文");
        assert_eq!(updated.tags, vec!["新标签"]);
        assert_eq!(updated.file_sha, content_sha256_hex(&bench.read(&created.path)));
        // 解锁后的写入直接用主密钥；外部加的未知键保留。
        assert_eq!(envelope_algorithm(bench, &created.path), None);
        let payload = bench.payload(&created.path, &keys);
        assert!(payload.frontmatter_raw.as_deref().unwrap().contains("external: true"));
        assert_eq!(payload.markdown_dialect, Some(MARKDOWN_DIALECT));

        let unbased = update_lockbox_fragment_in_vault(&cx, &path, &keys, "无基线保存", vec!["新标签".into()], None).unwrap();
        assert_eq!(unbased.content, "无基线保存");
        vec![summary(&created), summary(&updated), summary(&unbased)]
    });
}

#[test]
fn tags_pin_and_archive_round_trip() {
    on_both_with_lockbox(|bench| {
        let cx = bench.cx();
        let keys = fixture_keys();
        let created = create_lockbox_fragment(&cx, None, "归档往返", vec![]).unwrap();
        let path = bench.path(&created.path);

        let tagged = update_lockbox_fragment_tags_in_vault(
            &cx,
            &path,
            &keys,
            vec![LOCKBOX_TAG.into(), "private".into(), "#x".into(), "inbox".into()],
        )
        .unwrap();
        assert_eq!(tagged.tags, vec!["private", "x"]);
        assert_eq!(tagged.content, "归档往返");

        let pinned = set_lockbox_fragment_pinned_in_vault(&cx, &path, &keys, true).unwrap();
        assert!(pinned.pinned);

        let archived = set_lockbox_fragment_archived_in_vault(&cx, &path, &keys, true).unwrap();
        assert!(archived.archived && archived.pinned);
        assert!(archived.path.starts_with("lockbox/archive/"), "{}", archived.path);
        assert!(!cx.vfs.exists(&path));
        let archived_path = bench.path(&archived.path);
        assert_eq!(
            set_lockbox_fragment_pinned_in_vault(&cx, &archived_path, &keys, true).unwrap_err(),
            "密匣中已删除的片段不能置顶。"
        );
        let unpinned = set_lockbox_fragment_pinned_in_vault(&cx, &archived_path, &keys, false).unwrap();
        assert!(!unpinned.pinned);
        // 已在目标状态：原样读回，不移动。
        let same = set_lockbox_fragment_archived_in_vault(&cx, &archived_path, &keys, true).unwrap();
        assert_eq!(same.path, archived.path);

        let restored = set_lockbox_fragment_archived_in_vault(&cx, &archived_path, &keys, false).unwrap();
        assert!(!restored.archived);
        assert_eq!(restored.path, created.path);
        assert!(!cx.vfs.exists(&archived_path));
        assert_eq!(list_lockbox_fragments(&cx, &HashSet::new(), &keys).unwrap().len(), 1);

        let mut out = [&created, &tagged, &pinned, &archived, &unpinned, &same, &restored]
            .into_iter()
            .map(summary)
            .collect::<Vec<_>>();
        out.extend(bench.files(&[&created.id]));
        out
    });
}

#[test]
fn properties_are_set_and_removed() {
    on_both_with_lockbox(|bench| {
        let cx = bench.cx();
        let keys = fixture_keys();
        let created = create_lockbox_fragment(&cx, Some(&keys), "有属性", vec![]).unwrap();
        let path = bench.path(&created.path);

        let status = serde_yaml::Value::String("进行中".into());
        let first = mutate_lockbox_fragment_property_in_vault(&cx, &path, &keys, "状态", Some(&status)).unwrap();
        assert_eq!(first.properties.len(), 1);
        assert_eq!(first.properties[0].key, "状态");
        let rating = serde_yaml::Value::Number(5.into());
        let second = mutate_lockbox_fragment_property_in_vault(&cx, &path, &keys, "评分", Some(&rating)).unwrap();
        assert_eq!(second.properties.len(), 2);
        assert!(bench.payload(&created.path, &keys).frontmatter_raw.unwrap().contains("评分: 5"));

        let removed = mutate_lockbox_fragment_property_in_vault(&cx, &path, &keys, "状态", None).unwrap();
        assert_eq!(removed.properties.iter().map(|property| property.key.as_str()).collect::<Vec<_>>(), vec!["评分"]);
        assert_eq!(removed.content, "有属性");

        let archived = set_lockbox_fragment_archived_in_vault(&cx, &path, &keys, true).unwrap();
        let before = bench.read(&archived.path);
        assert_eq!(
            mutate_lockbox_fragment_property_in_vault(&cx, &bench.path(&archived.path), &keys, "状态", Some(&status))
                .unwrap_err(),
            "密匣中已删除的片段不能修改属性。"
        );
        assert_eq!(bench.read(&archived.path), before);
        vec![summary(&first), summary(&second), summary(&removed), summary(&archived)]
    });
}

#[test]
fn public_fragments_and_notes_move_into_the_lockbox() {
    on_both_with_lockbox(|bench| {
        let cx = bench.cx();
        let keys = fixture_keys();

        // 公开碎片：原样移入，正文与未知 frontmatter 保留，关系清空。
        let public = create_public_fragment(&cx, "公开碎片 #keep", vec!["keep".into()]).unwrap();
        let moved = move_public_fragment_to_lockbox(&cx, Some(&keys), &bench.path(&public.path)).unwrap();
        assert!(!bench.exists(&public.path));
        assert_eq!(moved.path, public.path.replacen("fragments/", "lockbox/fragments/", 1).replace(".md", ".shard"));
        assert_eq!(moved.content, "公开碎片 #keep");
        assert_eq!(moved.tags, vec!["keep"]);
        assert_eq!(moved.git_status, "saved");
        assert_eq!(bench.payload(&moved.path, &keys).frontmatter.source, "desktop-lockbox");

        // 笔记（锁着、带新正文与新标签）：进 lockbox/notes，保留子目录。
        let note = create_library_note_in_vault(&cx, "读书笔记", None).unwrap();
        let moved_note = move_public_fragment_content_to_lockbox(
            &cx,
            None,
            &bench.path(&note.path),
            "改过的正文",
            vec![LOCKBOX_TAG.into(), "书".into()],
        )
        .unwrap();
        assert_eq!(moved_note.path, "lockbox/notes/读书笔记.shard");
        assert_eq!(moved_note.content, "", "锁着时只返回投影");
        assert_eq!(moved_note.tags, vec!["书"]);
        assert_eq!(envelope_algorithm(bench, &moved_note.path).as_deref(), Some(FRAGMENT_KEY_ALGORITHM));
        let read_note =
            read_lockbox_fragment(&cx, &bench.path(&moved_note.path), &HashSet::new(), &keys, None).unwrap();
        assert_eq!(read_note.content, "改过的正文");
        assert_eq!(
            find_lockbox_fragment_path(cx.vfs, &note.id).unwrap(),
            Some(bench.path("lockbox/notes/读书笔记.shard"))
        );

        let nested = bench.path("notes/项目/子笔记.md");
        let frontmatter = FragmentFrontmatter {
            id: "nested-note".into(),
            created_at: "2026-10-01T08:00:00+08:00".into(),
            updated_at: "2026-10-01T08:00:00+08:00".into(),
            tags: vec!["note".into()],
            category: None,
            ai_status: Some("none".into()),
            pinned: false,
            source: "test".into(),
            conflict_of: None,
            related: Vec::new(),
        };
        write_fragment_file(cx.vfs, &nested, &frontmatter, "子目录笔记").unwrap();
        let moved_nested = move_public_fragment_to_lockbox(&cx, Some(&keys), &nested).unwrap();
        assert_eq!(moved_nested.path, "lockbox/notes/项目/子笔记.shard");
        assert_eq!(moved_nested.tags, vec!["note"]);

        // 只收 fragments/、notes/；受保护类型不能移入；两种失败都不动文件。
        let outside = bench.path("maps/outside.md");
        write_fragment_file(cx.vfs, &outside, &FragmentFrontmatter { id: "outside".into(), ..frontmatter.clone() }, "其他")
            .unwrap();
        assert_eq!(
            move_public_fragment_to_lockbox(&cx, Some(&keys), &outside).unwrap_err(),
            "只有 fragments/、notes/ 中的文档可以移入密匣。"
        );
        assert!(cx.vfs.is_file(&outside));
        let outline = bench.path("fragments/tests/outline.md");
        write_fragment_file(
            cx.vfs,
            &outline,
            &FragmentFrontmatter { id: "outline".into(), tags: vec!["outline".into()], ..frontmatter.clone() },
            "- 大纲",
        )
        .unwrap();
        let outline_bytes = bench.read("fragments/tests/outline.md");
        assert_eq!(move_public_fragment_to_lockbox(&cx, Some(&keys), &outline).unwrap_err(), LOCKBOX_TYPE_ERROR);
        assert_eq!(
            move_public_fragment_content_to_lockbox(&cx, None, &outline, "- 大纲", vec![LOCKBOX_TAG.into()])
                .unwrap_err(),
            LOCKBOX_TYPE_ERROR
        );
        assert_eq!(bench.read("fragments/tests/outline.md"), outline_bytes);

        let listed = list_lockbox_fragments(&cx, &HashSet::new(), &keys).unwrap();
        assert_eq!(listed.len(), 3);

        let ids = [public.id.as_str(), note.id.as_str()];
        let mut out = vec![summary(&moved), summary(&moved_note), summary(&read_note), summary(&moved_nested)];
        out.extend(bench.files(&ids));
        out
    });
}

#[test]
fn dialect_migration_rewrites_legacy_payloads_once() {
    on_both_with_lockbox(|bench| {
        let cx = bench.cx();
        let keys = fixture_keys();
        let current = create_lockbox_fragment(&cx, Some(&keys), "已是新格式", vec![]).unwrap();
        let legacy_path = bench.path("lockbox/fragments/tests/legacy.shard");
        let legacy = LockboxFragmentPayload {
            frontmatter: FragmentFrontmatter {
                id: "legacy-lockbox".into(),
                created_at: "2026-09-28T08:00:00+08:00".into(),
                updated_at: "2026-09-28T08:00:00+08:00".into(),
                tags: vec!["private".into()],
                category: None,
                ai_status: Some("none".into()),
                pinned: false,
                source: "legacy".into(),
                conflict_of: None,
                related: Vec::new(),
            },
            frontmatter_raw: None,
            body: "甲\n\n乙".into(),
            markdown_dialect: None,
        };
        write_lockbox_payload(cx.vfs, &legacy_path, &WriteKey::Master(keys.master_key.clone()), &legacy).unwrap();

        let sources = list_lockbox_dialect_sources(&cx, &keys).unwrap();
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].path, "lockbox/fragments/tests/legacy.shard");
        assert_eq!(sources[0].body, "甲\n\n乙");
        let before = bench.read(&sources[0].path);
        assert_eq!(sources[0].sha, content_sha256_hex(&before));

        let stale = apply_lockbox_dialect_migration(
            &cx,
            &keys,
            vec![MigratedLockboxDialectSource {
                path: sources[0].path.clone(),
                expected_sha: "0".repeat(64),
                body: "甲\n乙".into(),
            }],
        );
        assert!(stale.unwrap_err().contains("在迁移期间被改动"));
        assert_eq!(bench.read(&sources[0].path), before);

        let written = apply_lockbox_dialect_migration(
            &cx,
            &keys,
            vec![MigratedLockboxDialectSource {
                path: sources[0].path.clone(),
                expected_sha: sources[0].sha.clone(),
                body: "甲\n乙".into(),
            }],
        )
        .unwrap();
        assert_eq!(written, 1);
        let migrated = bench.payload(&sources[0].path, &keys);
        assert_eq!((migrated.body.as_str(), migrated.markdown_dialect), ("甲\n乙", Some(MARKDOWN_DIALECT)));
        assert!(list_lockbox_dialect_sources(&cx, &keys).unwrap().is_empty());
        let again = apply_lockbox_dialect_migration(
            &cx,
            &keys,
            vec![MigratedLockboxDialectSource {
                path: sources[0].path.clone(),
                expected_sha: content_sha256_hex(&bench.read(&sources[0].path)),
                body: "甲乙".into(),
            }],
        );
        assert!(again.unwrap_err().contains("已经是新格式"));
        assert_eq!(apply_lockbox_dialect_migration(&cx, &keys, Vec::new()).unwrap(), 0);

        let mut out = sources.iter().map(|source| format!("{} {:?}", source.path, source.body)).collect::<Vec<_>>();
        out.extend(bench.files(&[&current.id]));
        out
    });

    let vault = Path::new("/vault");
    assert!(lockbox_dialect_target(vault, "lockbox/fragments/a.shard").is_ok());
    for bad in ["fragments/a.shard", "lockbox/../x.shard", "lockbox/a.md", "/lockbox/a.shard", "./lockbox/a.shard"] {
        assert!(lockbox_dialect_target(vault, bad).is_err(), "{bad}");
    }
}

#[test]
fn search_documents_come_from_the_decrypted_payload() {
    on_both_with_lockbox(|bench| {
        let cx = bench.cx();
        let keys = fixture_keys();
        let created = create_lockbox_fragment(&cx, Some(&keys), "可搜索的私密正文", vec!["work".into()]).unwrap();
        let text = bench.read(&created.path);

        let document = lockbox_search_document("vault-identity", created.path.clone(), &text, &keys).unwrap();
        let target = &document.metadata.target;
        assert_eq!(target.scope, SearchScope::Lockbox);
        assert_eq!((target.path.as_str(), target.archived), (created.path.as_str(), false));
        assert_eq!(target.object_id.as_deref(), Some(created.id.as_str()));
        let fragment = document.fragment.as_ref().unwrap();
        assert_eq!(fragment.content, "可搜索的私密正文");
        assert_eq!(fragment.file_sha, created.file_sha);
        assert!(fragment.lockbox);

        let archived = set_lockbox_fragment_archived_in_vault(&cx, &bench.path(&created.path), &keys, true).unwrap();
        let archived_document =
            lockbox_search_document("vault-identity", archived.path.clone(), &bench.read(&archived.path), &keys)
                .unwrap();
        assert!(archived_document.metadata.target.archived);

        assert_eq!(
            lockbox_search_document("vault-identity", created.path.clone(), "{}", &keys).unwrap_err(),
            SearchError::Io { retryable: false }
        );
        vec![summary(fragment), norm_path(&archived_document.metadata.target.path, &[&created.id])]
    });
}

#[test]
fn tag_and_image_rules_are_pure() {
    assert_eq!(
        normalize_lockbox_tags(vec!["#work".into(), LOCKBOX_TAG.into(), "inbox".into(), "work".into(), " ".into()]),
        vec!["work"]
    );
    assert!(is_markdown_image_line("  ![图](assets/a.png)  "));
    assert!(!is_markdown_image_line("正文里提到 ![图](a.png) 之后还有字"));
    assert!(reject_lockbox_images("第一行\n![x](y)\n").is_err());
    assert!(reject_lockbox_images("没有图片").is_ok());
}
