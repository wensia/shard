//! 给 AI 助手看的使用说明（`shard --agent-guide`），以及把它装成
//! Claude Code / Codex skill（`shard --install-skill`）。说明随 CLI 版本走，
//! 升级 shard 后重新运行 `--install-skill` 即可同步。

use crate::CliError;
use std::{
    env, fs,
    path::{Path, PathBuf},
};

pub const AGENT_GUIDE: &str = r#"# Shard CLI 使用说明（给 AI 助手）

Shard 是用户的本地 Markdown 资料库（vault）加桌面应用。读写一律用 `shard` 命令，
不要直接创建、修改或删除 vault 里的文件：命令会生成 frontmatter、规范标签、持锁防止
与应用同时写入；写入后 Shard 应用里会显示新内容。

## 内容放哪里

- 碎片：短记录、想法、摘录、待办，按时间排在碎片流里。没有特别说明就写碎片。
- 资料库笔记：长文档、会议纪要、方案，放在 `notes/` 下的文件夹里。
- 数据集：结构化记录（CSV），资料库里有一篇嵌入它的说明笔记。
- 大纲、流程图：受管 JSON，只能用 `--graph-*` 命令修改。
- 密匣（`#密匣`）是加密空间，CLI 读不到也写不进，不要尝试。

## 格式规则

- 正文是普通 Markdown。不要写 YAML frontmatter，id、时间和标签由 shard 生成。
- Shard 按源码的行显示：换一行就是新的一行；段落与段落之间空一行就显示一行空白，
  空几行显示几行。标题、列表、引用前后照常空一行，这个空行只是分隔、不显示，标题
  自带上下留白。按标准 Markdown 写即可，不要为了显示效果多空行。
- 标签直接写在正文里：`#标签`。`#` 前面要是行首、空格或标点，标签延续到空白为止。
  先运行 `shard --tags` 看已有标签，优先复用，不要造近义的新标签。
- `inbox`、`note`、`outline`、`flowchart`、`document` 是系统标签，不要手写。
- 待办写成 Markdown 复选框：`- [ ] 事项`，完成是 `- [x] 事项`。
- 资料库笔记以 `# 标题` 开头；不写时 shard 会自动补上。
- 只保存用户要求保存的内容，不要把整段对话写进去。

## 命令

所有命令都可加 `--json`：成功时 stdout 只有一个 JSON 值；失败时 stderr 输出
`{"error":{"code":"...","message":"..."}}`。用 `--vault <路径>` 或环境变量
`SHARD_VAULT` 指定资料库，默认用 Shard 应用当前的资料库。

新建碎片（内容写参数里，或从标准输入读）：

    shard --json --source <你的名字> '#读书 今天读完了《置身事内》'
    shard --json --source <你的名字> <<'EOF'
    #摘录 多行 Markdown 内容
    EOF

  返回 {id, path, sha, tags}。`--source` 写进 frontmatter 的 source 字段，标明内容
  来自哪个助手（例如 claude-code、codex），也可设环境变量 SHARD_SOURCE。
  参数开头可用 `/复选框`、`/列表`、`/引用`：之后每个非空行变成一项。

搜索（关键词须同时命中，规则同 Shard 应用）：

    shard -s 关键词 [更多关键词] --json [-n 50]

  返回 [{index, id, path, title, kind, tags, createdAt, updatedAt, preview}]。
  kind 是 fragment、note 或 document。不带关键词时按最近修改列出。

读取全文：

    shard --read <目标> --json

  <目标> 是 id、vault 相对路径（如 notes/项目/周报.md）、上次搜索的序号，或 id 中
  至少 4 个字符且唯一的片段。返回 {id, path, kind, title, tags, createdAt, updatedAt,
  source, sha, body}。不带 --json 时只输出正文。

改写全文（必须带读取时拿到的 sha）：

    shard --update <目标> --expect <sha> --json <<'EOF'
    新的完整正文
    EOF

  返回 {id, path, sha, changed, tags}。正文里的 #标签 会重新收进 frontmatter。

追加到末尾（不需要 sha，在锁内完成读改写）：

    shard --append <目标> --json '- [ ] 新的待办'
    shard --append <目标> --json < 片段.md

  末尾是列表、追加内容也以列表项开头时接成同一个列表，否则另起一段。
  也可加 `--expect <sha>`，确保追加时内容没变。

新建资料库笔记（文件夹不存在会自动创建）：

    shard --note '会议纪要 10-13' --folder 项目/周会 --json --source <你的名字> <<'EOF'
    ## 结论
    - ...
    EOF

  返回 {id, path, sha, tags}。重名时文件名自动加 -2。

列出标签与资料库目录：

    shard --tags --json        # [{tag, count}]，按使用次数降序
    shard --ls [文件夹] --json  # [{path, kind}]，kind: folder/note/dataset/mindmap/flowchart

数据集（CSV）：

    shard --read-dataset datasets/阅读记录.csv --json
      # {path, header, rows, primaryKey, sha, editable, readOnlyReason}
    shard --create-dataset 阅读记录 [--folder 文件夹] --json <<'EOF'
    {"header": ["id", "书名", "日期"], "rows": [["1", "置身事内", "2026-10-13"]], "primaryKey": "id"}
    EOF
    shard --append-dataset datasets/阅读记录.csv <<'EOF'
    {"expectedHeader": ["id", "书名", "日期"], "records": [{"id": "2", "书名": "...", "日期": "..."}]}
    EOF
      # 按主键幂等追加：同主键同内容跳过，同主键不同内容报 KEY_CONFLICT。

大纲与流程图：

    shard --graph-read <碎片id>          # 完整 JSON，含 fileSha
    shard --graph-outline <碎片id>       # 大纲导出为缩进列表
    shard --graph-set-text <碎片id> <节点id> <文字> --expect <fileSha>
    shard --graph-add-child <碎片id> <父节点id> <文字> --expect <fileSha>
    shard --graph-remove <碎片id> <节点id> --expect <fileSha>

## 安全改写流程

1. `shard -s 关键词 --json` 找到 id。
2. `shard --read <id> --json` 拿到 body 和 sha。
3. 改好后 `shard --update <id> --expect <sha> --json`，正文从标准输入给。
4. 遇到 CONFLICT（退出码 2）：用户或同步在这期间改过它。重新 --read，基于最新内容
   重做修改再提交，不要用旧内容覆盖。

## 退出码与错误码

- 0：成功。
- 1：一般错误。code 为 ERROR、NOT_FOUND（目标不存在）、AMBIGUOUS（片段匹配多条，
  改用完整 id）或 LOCKED（Shard 正在写入，稍等几秒重试）。
- 2：CONFLICT，内容已被改过（--expect 不符），或数据集表头已变化。
- 3：KEY_CONFLICT，数据集主键冲突。

## 不要做

- 不要直接读写 vault 目录里的文件，也不要运行 git 提交（Shard 应用会自动提交）。
- CLI 不提供删除；需要删除时请用户在 Shard 里操作。
- 不要使用交互命令 `shard -i`、`shard -e`，它们需要终端界面。
"#;

const SKILL_DESCRIPTION: &str = "在用户的 Shard 资料库里记录、查找、修改碎片与笔记（通过 `shard` 命令）。\
用户提到 Shard、让你记一下、存到碎片/笔记/资料库、查找或整理他的笔记时使用。";

const SKILL_MARKER: &str = "<!-- 由 shard --install-skill 生成";

pub fn skill_text() -> String {
    format!(
        "---\nname: shard\ndescription: {SKILL_DESCRIPTION}\n---\n\n{SKILL_MARKER}（shard {}），升级 shard 后重新运行该命令即可更新。 -->\n\n{AGENT_GUIDE}",
        env!("CARGO_PKG_VERSION")
    )
}

/// 安装目标：`claude`、`codex`，或一个 skills 目录路径。不给目标时装到本机已有的
/// Claude Code（`~/.claude`）与 Codex（`~/.codex`）配置下。
pub fn install_skill(targets: &[String], force: bool) -> Result<(), CliError> {
    let destinations = if targets.is_empty() {
        let found = [("claude", claude_home()), ("codex", codex_home())]
            .into_iter()
            .filter_map(|(_, home)| home.filter(|home| home.is_dir()))
            .map(|home| home.join("skills"))
            .collect::<Vec<_>>();
        if found.is_empty() {
            return Err("没有找到 ~/.claude 或 ~/.codex。请指定目标：shard --install-skill claude|codex|<skills 目录>".into());
        }
        found
    } else {
        targets
            .iter()
            .map(|target| match target.as_str() {
                "claude" => claude_home()
                    .map(|home| home.join("skills"))
                    .ok_or_else(|| CliError::from("无法确定 Claude Code 配置目录")),
                "codex" => codex_home()
                    .map(|home| home.join("skills"))
                    .ok_or_else(|| CliError::from("无法确定 Codex 配置目录")),
                path => Ok(PathBuf::from(path)),
            })
            .collect::<Result<Vec<_>, _>>()?
    };

    let text = skill_text();
    for skills in destinations {
        let file = skills.join("shard").join("SKILL.md");
        write_skill(&file, &text, force)?;
        println!("已安装：{}", file.display());
    }
    Ok(())
}

fn write_skill(file: &Path, text: &str, force: bool) -> Result<(), CliError> {
    if let Ok(existing) = fs::read_to_string(file) {
        if !force && !existing.contains(SKILL_MARKER) {
            return Err(format!(
                "{} 已存在且不是 shard 生成的，没有覆盖（确认要替换请加 --force）",
                file.display()
            )
            .into());
        }
    }
    let parent = file.parent().expect("skill 文件总在目录里");
    fs::create_dir_all(parent).map_err(|error| format!("创建 {} 失败：{error}", parent.display()))?;
    fs::write(file, text).map_err(|error| format!("写入 {} 失败：{error}", file.display()))?;
    Ok(())
}

fn home_dir() -> Option<PathBuf> {
    env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

fn claude_home() -> Option<PathBuf> {
    env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| home_dir().map(|home| home.join(".claude")))
}

fn codex_home() -> Option<PathBuf> {
    env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| home_dir().map(|home| home.join(".codex")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skill_has_frontmatter_and_guide() {
        let text = skill_text();
        assert!(text.starts_with("---\nname: shard\ndescription: "));
        assert!(text.contains(SKILL_MARKER));
        assert!(text.ends_with(AGENT_GUIDE));
    }

    #[test]
    fn foreign_skill_is_not_overwritten_without_force() {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("shard/SKILL.md");
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, "用户自己写的").unwrap();
        assert!(write_skill(&file, &skill_text(), false).is_err());
        assert_eq!(fs::read_to_string(&file).unwrap(), "用户自己写的");
        write_skill(&file, &skill_text(), true).unwrap();
        write_skill(&file, &skill_text(), false).unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), skill_text());
    }
}
