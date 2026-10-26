//! 固定测试向量：`fixtures/lockbox-v1.json` 由本文件的 `generate_fixture`（`--ignored`）生成一次后提交。
//! 每次测试都必须能用口令与恢复密钥解出主密钥、解开两种信封；网页端实现解同一份向量，保证两边格式一致。

use std::path::PathBuf;

use serde_json::{json, Value};
use shard_lockbox::{open_text, random_bytes, Envelope, Manifest, WriteKey};

const PASSWORD: &str = "correct horse 电池";
const MASTER_PLAINTEXT: &str = r#"{"frontmatter":{"id":"20261026-090000-aaaaaaaa-000001"},"body":"主密钥加密的正文。"}"#;
const PUBLIC_PLAINTEXT: &str = r#"{"frontmatter":{"id":"20261026-090100-bbbbbbbb-000002"},"body":"锁着时用公钥加密的正文。"}"#;

fn fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/lockbox-v1.json")
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[test]
#[ignore = "只在需要重新生成向量时运行"]
fn generate_fixture() {
    let master_key = random_bytes(32);
    let recovery_key = shard_lockbox::generate_recovery_key();
    let manifest = Manifest::build(PASSWORD, &recovery_key, &master_key).unwrap();
    let by_master =
        Envelope::seal(&WriteKey::Master(master_key.clone()), "20261026-090000-aaaaaaaa-000001", MASTER_PLAINTEXT.as_bytes())
            .unwrap();
    let public_key = manifest.write_public_key().unwrap().unwrap();
    let by_public =
        Envelope::seal(&WriteKey::Public(public_key), "20261026-090100-bbbbbbbb-000002", PUBLIC_PLAINTEXT.as_bytes()).unwrap();
    let fixture = json!({
        "password": PASSWORD,
        "recoveryKey": recovery_key,
        "masterKeyHex": hex(&master_key),
        "manifest": manifest.to_text().unwrap(),
        "envelopes": [
            { "name": "master", "plaintext": MASTER_PLAINTEXT, "text": by_master.to_text().unwrap() },
            { "name": "public", "plaintext": PUBLIC_PLAINTEXT, "text": by_public.to_text().unwrap() },
        ],
    });
    std::fs::write(fixture_path(), serde_json::to_string_pretty(&fixture).unwrap() + "\n").unwrap();
}

fn fixture() -> Value {
    serde_json::from_str(&std::fs::read_to_string(fixture_path()).expect("向量文件")).unwrap()
}

#[test]
fn fixture_unwraps_with_password_and_recovery_key() {
    let fixture = fixture();
    let manifest = Manifest::parse(fixture["manifest"].as_str().unwrap()).unwrap();
    let expected = fixture["masterKeyHex"].as_str().unwrap();
    assert_eq!(hex(&manifest.unwrap_with_password(PASSWORD).unwrap()), expected);
    let recovery = fixture["recoveryKey"].as_str().unwrap();
    assert_eq!(hex(&manifest.unwrap_with_recovery(recovery).unwrap()), expected);
    // 恢复密钥输入时大小写、空格、连字符不影响。
    assert_eq!(hex(&manifest.unwrap_with_recovery(&recovery.to_uppercase().replace('-', " ")).unwrap()), expected);
    assert_eq!(manifest.unwrap_with_password("wrong password").unwrap_err(), "密码不正确。");
    assert_eq!(manifest.unwrap_with_recovery("shard-000000").unwrap_err(), "恢复密钥不正确。");
    // 原文往返不变：服务端原样存、导出原样写回。
    assert_eq!(manifest.to_text().unwrap(), fixture["manifest"].as_str().unwrap());
}

#[test]
fn fixture_envelopes_open_with_the_read_keys() {
    let fixture = fixture();
    let manifest = Manifest::parse(fixture["manifest"].as_str().unwrap()).unwrap();
    let master_key = manifest.unwrap_with_password(PASSWORD).unwrap();
    let read_keys = manifest.read_keys(&master_key).unwrap();
    for envelope in fixture["envelopes"].as_array().unwrap() {
        let text = envelope["text"].as_str().unwrap();
        let opened = open_text(text, &read_keys).unwrap();
        assert_eq!(String::from_utf8(opened).unwrap(), envelope["plaintext"].as_str().unwrap(), "{}", envelope["name"]);
        assert_eq!(Envelope::parse(text).unwrap().to_text().unwrap(), text);
    }
    // 没有写入私钥时，公钥信封读不出来。
    let without_private = shard_lockbox::ReadKeys { master_key, write_private_key: None };
    let public = fixture["envelopes"][1]["text"].as_str().unwrap();
    assert_eq!(open_text(public, &without_private).unwrap_err(), "密匣读取密钥缺失。请重置密匣密码后重试。");
}

#[test]
fn password_change_and_reset_keep_the_master_key() {
    let master_key = random_bytes(32);
    let recovery = shard_lockbox::generate_recovery_key();
    let mut manifest = Manifest::build("first password", &recovery, &master_key).unwrap();
    let public_before = manifest.write_public_key.clone();
    manifest.rewrap_password("second password", &master_key).unwrap();
    assert_eq!(manifest.unwrap_with_password("second password").unwrap(), master_key);
    assert!(manifest.unwrap_with_password("first password").is_err());
    assert_eq!(manifest.unwrap_with_recovery(&recovery).unwrap(), master_key);
    let next_recovery = manifest.reset("third password", &master_key).unwrap();
    assert!(manifest.unwrap_with_recovery(&recovery).is_err());
    assert_eq!(manifest.unwrap_with_recovery(&next_recovery).unwrap(), master_key);
    // 写入密钥对不随口令变化：锁着时写下的内容照样读得出。
    assert_eq!(manifest.write_public_key, public_before);
}

/// 旧桌面代码真实写出的 manifest 与信封（公钥写入一条、主密钥改写一条）。
#[test]
fn files_written_by_the_old_desktop_code_still_open() {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/lockbox-desktop-v1.json");
    let fixture: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let manifest_text = fixture["manifest"].as_str().unwrap();
    let manifest = Manifest::parse(manifest_text).unwrap();
    assert_eq!(manifest.to_text().unwrap(), manifest_text, "manifest 原文往返不变");
    let master_key = manifest.unwrap_with_password(fixture["password"].as_str().unwrap()).unwrap();
    assert_eq!(manifest.unwrap_with_recovery(fixture["recoveryKey"].as_str().unwrap()).unwrap(), master_key);
    let read_keys = manifest.read_keys(&master_key).unwrap();
    let envelopes = fixture["envelopes"].as_array().unwrap();
    assert_eq!(envelopes.iter().filter(|envelope| envelope["keyAlgorithm"].is_string()).count(), 1);
    for envelope in envelopes {
        let text = envelope["text"].as_str().unwrap();
        assert_eq!(Envelope::parse(text).unwrap().to_text().unwrap(), text, "信封原文往返不变");
        let payload: Value = serde_json::from_slice(&open_text(text, &read_keys).unwrap()).unwrap();
        assert_eq!(payload["frontmatter"]["id"], envelope["id"]);
        assert_eq!(payload["body"], envelope["body"]);
    }
}

#[test]
fn new_manifests_record_current_kdf_and_old_ones_upgrade_on_unlock() {
    let master_key = random_bytes(32);
    let recovery = shard_lockbox::generate_recovery_key();
    let fresh = Manifest::build("password one", &recovery, &master_key).unwrap();
    assert_eq!(fresh.password_kdf, Some(shard_lockbox::CURRENT_KDF));
    assert_eq!(fresh.version, shard_lockbox::MANIFEST_VERSION);
    assert_eq!(fresh.recovery_kdf, Some(shard_lockbox::CURRENT_KDF));
    assert!(!fresh.password_kdf_outdated());

    // 旧桌面写出的 manifest 没有参数字段：按旧参数解开，升级口令包裹后仍能解开，恢复密钥那份不动。
    let fixture: Value = serde_json::from_str(
        &std::fs::read_to_string(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/lockbox-desktop-v1.json")).unwrap(),
    )
    .unwrap();
    let password = fixture["password"].as_str().unwrap();
    let mut legacy = Manifest::parse(fixture["manifest"].as_str().unwrap()).unwrap();
    assert_eq!(legacy.password_kdf, None);
    assert_eq!(legacy.version, 1, "没升级过的旧 manifest 保持版本 1");
    assert!(legacy.password_kdf_outdated());
    let key = legacy.unwrap_with_password(password).unwrap();
    let recovery_before = (legacy.recovery_salt.clone(), legacy.recovery_encrypted_master_key.clone());
    let write_key_before = legacy.write_public_key.clone();
    assert!(legacy.upgrade_password_kdf(password, &key).unwrap());
    assert_eq!(legacy.password_kdf, Some(shard_lockbox::CURRENT_KDF));
    assert_eq!(legacy.version, shard_lockbox::MANIFEST_VERSION, "记了参数就升到版本 2，旧客户端明确报不支持");
    assert!(!legacy.upgrade_password_kdf(password, &key).unwrap(), "已是当前标准就不再改");

    let reparsed = Manifest::parse(&legacy.to_text().unwrap()).unwrap();
    assert_eq!(reparsed.unwrap_with_password(password).unwrap(), key);
    assert_eq!(reparsed.unwrap_with_recovery(fixture["recoveryKey"].as_str().unwrap()).unwrap(), key);
    assert_eq!((reparsed.recovery_salt.clone(), reparsed.recovery_encrypted_master_key.clone()), recovery_before);
    assert_eq!(reparsed.recovery_kdf, None);
    assert_eq!(reparsed.write_public_key, write_key_before, "写入密钥对不变：锁着写下的内容照样读得出");
}
