//! 路径比较键：APFS 默认不区分大小写，也不区分 Unicode 规范化方式（NFC / NFD）。
//! 现有代码的 `exists()`、重名判断、`![](Notes/x.png)` 这类引用都依赖这一点，
//! 内容库用 `path_key` 做唯一键来保持同样的语义。

use unicode_normalization::UnicodeNormalization;

/// NFC 规整后转小写。唯一索引与目录查找都用它。
pub fn path_key(path: &str) -> String {
    path.nfc().collect::<String>().to_lowercase()
}

/// 父目录的 `path_key`；顶层条目的父目录是根（空串）。
pub fn parent_key(path_key: &str) -> &str {
    match path_key.rfind('/') {
        Some(index) => &path_key[..index],
        None => "",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folds_case_and_normalization() {
        // 「é」的 NFD（e + U+0301）与 NFC 是同一个键。
        assert_eq!(path_key("notes/Cafe\u{0301}.md"), path_key("notes/café.md"));
        assert_eq!(path_key("Notes/证件/A.JPG"), "notes/证件/a.jpg");
    }

    #[test]
    fn parent_of_top_level_is_root() {
        assert_eq!(parent_key("notes"), "");
        assert_eq!(parent_key("notes/a/b.md"), "notes/a");
    }
}
