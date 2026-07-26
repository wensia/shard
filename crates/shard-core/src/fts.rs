//! 全文检索的分词层。
//!
//! # 为什么需要这个模块
//!
//! SQLite FTS5 内置的两个分词器对中文都不可用：
//!
//! - `unicode61`：汉字属于 Unicode Letter 类别，连续汉字会被当成**一个** token。
//!   「今天开会议程」整串是一个 token，搜「会议」永远搜不到。
//! - `trigram`：要求查询至少 3 个字符，「会议」「日程」这类 2 字查询**全部返回空**，
//!   相对项目原有的 `indexOf` 子串匹配是明确的功能倒退。
//!
//! 所以这里在**应用层**做分词：把 CJK 字符逐字用空格切开再交给 `unicode61`。
//! 代价是索引侧和查询侧必须调用同一份逻辑，收益是索引与查询都只依赖内置分词器，
//! 因而客户端本地库、服务端 Turso、以及浏览器直连查询三处行为完全一致
//! （自定义 tokenizer 无法在远端注册，这是选它的决定性理由）。
//!
//! # 不变量
//!
//! [`to_fts_text`] 用于写入索引，[`build_match_query`] 用于构造查询，
//! **两者必须同时修改**。任何改动都必须伴随一次全量 `rebuild_search_index()`，
//! 否则旧索引与新查询不匹配，表现为"搜索静默失效"——不报错，只是搜不到。

/// FTS5 建表时使用的分词器配置。索引与查询共用，改动需重建索引。
///
/// `tokenchars` 里的 `_-#/@` 让标签（`#tag`）、路径、邮箱形态的词保持完整，
/// 不被拆散。
pub const FTS_TOKENIZE: &str = "unicode61 remove_diacritics 2 tokenchars '_-#/@'";

/// 判断字符是否需要逐字切分。
///
/// 覆盖汉字（含扩展区与兼容区）、日文假名、谚文音节。**不包含** CJK 标点
/// （U+3000–U+303F）和全角 ASCII 变体（U+FF01–U+FF60）——那些是标点，
/// `unicode61` 本来就会把它们当分隔符，逐字切开反而会产生垃圾 token。
pub fn is_cjk(c: char) -> bool {
    matches!(c as u32,
        0x3040..=0x30FF   // 平假名 + 片假名
        | 0x3400..=0x4DBF // CJK 扩展 A
        | 0x4E00..=0x9FFF // CJK 统一表意文字
        | 0xAC00..=0xD7AF // 谚文音节
        | 0xF900..=0xFAFF // CJK 兼容表意文字
        | 0x20000..=0x2FA1F // CJK 扩展 B–F（增补平面）
    )
}

/// 除 CJK 外，还算作 token 组成部分的字符。与 [`FTS_TOKENIZE`] 的
/// `tokenchars` 保持一致。
fn is_token_char(c: char) -> bool {
    c.is_alphanumeric() || matches!(c, '_' | '-' | '#' | '/' | '@')
}

/// 把任意文本转成可写入 FTS5 的字符串：CJK 字符逐字用空格隔开，其余原样。
///
/// ```text
/// "今天开会议程"  -> "今 天 开 会 议 程"
/// "Rust 会议"     -> "Rust 会 议"
/// "日程#2"        -> "日 程 #2"
/// ```
pub fn to_fts_text(input: &str) -> String {
    // CJK 每字最多多出一个空格；给 1.5 倍容量避免反复扩容。
    let mut out = String::with_capacity(input.len() + input.len() / 2);
    for c in input.chars() {
        if is_cjk(c) {
            if !out.is_empty() && !out.ends_with(' ') {
                out.push(' ');
            }
            out.push(c);
            out.push(' ');
        } else if c.is_whitespace() && out.ends_with(' ') {
            // 跳过：CJK 切分引入的尾随空格已经充当了分隔符，再叠加原文空白
            // 只会让索引文本无谓变长。连续空白对 FTS5 而言等价于单个分隔符。
            continue;
        } else {
            out.push(c);
        }
    }
    out.trim().to_string()
}

/// 把用户输入的查询串转成 FTS5 `MATCH` 表达式。
///
/// - 连续 CJK 段变成 phrase 查询，保证字序相邻：`会议` -> `"会 议"`
/// - 拉丁/数字段变成前缀查询：`rust` -> `"rust"*`
/// - 多段之间用 `AND` 连接：`Rust 会议` -> `"rust"* AND "会 议"`
///
/// 所有词都用双引号包裹，因此 `AND` / `OR` / `NOT` / `(` 等 FTS5 语法元素
/// 出现在用户输入里时会被当作字面量，不会被解释成查询语法（这同时也是注入防护）。
///
/// 查询不含任何可检索内容时返回 `None`——调用方应据此跳过查询而不是传一个
/// 空表达式给 FTS5（那会报语法错误）。
pub fn build_match_query(raw: &str) -> Option<String> {
    let mut terms: Vec<String> = Vec::new();
    let mut cjk_run: Vec<char> = Vec::new();
    let mut latin_run = String::new();

    for c in raw.chars() {
        if is_cjk(c) {
            flush_latin(&mut latin_run, &mut terms);
            cjk_run.push(c);
        } else if is_token_char(c) {
            flush_cjk(&mut cjk_run, &mut terms);
            latin_run.push(c);
        } else {
            // 空白与标点：两个 run 都结束。
            flush_cjk(&mut cjk_run, &mut terms);
            flush_latin(&mut latin_run, &mut terms);
        }
    }
    flush_cjk(&mut cjk_run, &mut terms);
    flush_latin(&mut latin_run, &mut terms);

    if terms.is_empty() {
        None
    } else {
        Some(terms.join(" AND "))
    }
}

fn flush_cjk(run: &mut Vec<char>, terms: &mut Vec<String>) {
    if run.is_empty() {
        return;
    }
    let phrase: Vec<String> = run.iter().map(|c| c.to_string()).collect();
    terms.push(format!("\"{}\"", phrase.join(" ")));
    run.clear();
}

fn flush_latin(run: &mut String, terms: &mut Vec<String>) {
    if run.is_empty() {
        return;
    }
    // 纯符号（如 `---`、`##`）不构成有意义的检索词，丢弃；否则会生成
    // 合法但永远匹配不到东西的查询项，还会让整个 AND 表达式落空。
    if run.chars().any(char::is_alphanumeric) {
        let lowered = run.to_lowercase();
        // FTS5 phrase 内的双引号用叠写转义。
        let escaped = lowered.replace('"', "\"\"");
        terms.push(format!("\"{escaped}\"*"));
    }
    run.clear();
}
