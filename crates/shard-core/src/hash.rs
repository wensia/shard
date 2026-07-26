//! 内容指纹。**两端必须算出同一个值。**
//!
//! `content_hash` 参与导入幂等、导出脏检测，接上同步之后还要参与「这两台设备
//! 上的这条笔记是不是同一版内容」的判断。任何一端换了算法或改了输入口径，
//! 结果都不是报错，而是同一条内容被当成两条不同的东西反复来回同步。

use sha2::{Digest, Sha256};

/// 字节内容的 sha256 十六进制摘要。附件的内容寻址键。
pub fn hash_bytes(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// 文本的 sha256 十六进制摘要，按 UTF-8 编码。
pub fn hash_text(text: &str) -> String {
    hash_bytes(text.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashes_are_stable_and_content_sensitive() {
        assert_eq!(hash_text("hello"), hash_text("hello"));
        assert_ne!(hash_text("hello"), hash_text("world"));
        // 已知向量：口径若被改动（比如换成 base64 或加了盐），这一条会立刻炸。
        assert_eq!(
            hash_text(""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn text_and_bytes_agree() {
        assert_eq!(hash_text("图片"), hash_bytes("图片".as_bytes()));
    }
}
