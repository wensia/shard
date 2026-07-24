#!/usr/bin/env node
/**
 * 设计 token 契约校验。
 *
 * 存在的理由：颜色/圆角/阴影这些设计值必须来自真相源（astryx 主题包 + 本项目扩展），
 * 不能靠印象编一个数值出来——这正是本仓库上一次设计系统迁移（kiln）踩过的坑
 * （散文写的阴影值和 CSS 真值不一致，只能靠肉眼发现）。
 *
 * 这个脚本把「token 必须来自真相源，不能自己编」变成一条会失败的构建检查：
 *
 *   1. 契约里有、本地没定义        → 缺 token，失败
 *   2. 本地定义了、契约里没有       → 自造 token，失败（除非登记在 knownDeviations）
 *   3. 业务代码/CSS 里出现裸 hex 颜色 → 失败（颜色必须走语义 token）
 *   4. 业务代码/CSS 里出现写死的像素高度 → 失败（高度必须由 shell/token 提供）
 *
 * 契约来源：contract/tokens.json —— astryx neutral 主题的 token 全集 + 本项目在
 *          astryx 之上的扩展（--shard-* 前缀，以及 --background/--primary 等
 *          指向 astryx token 的语义色别名）。
 * astryx token 真相源：node_modules/@astryxdesign/theme-neutral/dist/theme.css
 *          （随 pnpm install 一起就位，不在本仓库保留手抄副本——那是第二个真相源，
 *          必然漂移。要升级 astryx 主题版本？改 package.json，pnpm install，
 *          然后重新生成 contract/tokens.json 里 astryx 那部分）。
 * shard 扩展 token 真相源：src/index.css 的 :root 块。
 *
 * 本项目已经从 Tailwind v4 + shadcn 迁移到 astryx（React + StyleX 预编译产物），
 * 不再有 Tailwind 工具类字符串可扫，所以 Tailwind 调色板类 / 出厂阴影类这两条
 * 历史检查已经退休（见文件末尾说明），改为扫描手写 CSS 文件里的裸 hex / 写死高度，
 * 以及 TSX 里用 inline style 逃逸门禁的写死高度。
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const REPO = ROOT;

// 契约 = astryx 主题 token 全集 + 本项目的 --shard-* 与语义色别名扩展。
const CONTRACT = join(ROOT, "contract/tokens.json");
// astryx token 真相源：已安装的 @astryxdesign/theme-neutral 包，不是本仓库的副本。
const ASTRYX_THEME_CSS = join(
  ROOT,
  "node_modules/@astryxdesign/theme-neutral/dist/theme.css"
);
const LOCAL_CSS = join(ROOT, "src/index.css"); // ★ 全局 CSS（只会读它的 :root 块）
const SRC = join(ROOT, "src");

const failures = [];
const fail = (msg) => failures.push(msg);

// ── 1 & 2. token 契约 ────────────────────────────────────────────
const contract = JSON.parse(readFileSync(CONTRACT, "utf8"));
const allowed = new Set(contract.tokens);
const known = new Set(Object.keys(contract.knownDeviations ?? {}));

let astryxThemeCss = "";
try {
  astryxThemeCss = readFileSync(ASTRYX_THEME_CSS, "utf8");
} catch {
  fail(
    `找不到 astryx 主题 CSS：${relative(REPO, ASTRYX_THEME_CSS)} —— ` +
      `先跑 pnpm install（@astryxdesign/theme-neutral 未安装或路径变了）。`
  );
}

const tokensCss =
  astryxThemeCss +
  "\n" +
  // 本项目在 astryx 之上的扩展 —— **只取 :root 块**，不含 .dark 覆盖块。
  (readFileSync(LOCAL_CSS, "utf8").match(/^:root \{[\s\S]*?^\}/m)?.[0] ?? "");
// 匹配定义 `--foo:`，不匹配引用 `var(--foo)` / `var(--foo, x)` —— 引用后面跟的是 `)` 或 `,`，不是 `:`。
// 不要锚定行首：那样单行写法 `:root { --foo: x }` 会整个漏掉（这个洞是负向测试抓出来的）。
// \\. 处理 --space-0\.5 这种 CSS 转义。
const defined = new Set(
  [...tokensCss.matchAll(/(--[a-z0-9\\.-]+)\s*:/gi)].map((m) =>
    m[1].replace(/\\/g, "")
  )
);

for (const t of allowed) {
  if (!defined.has(t)) {
    fail(`缺少 token：${t} —— 契约里有，astryx 主题 CSS 或 src/index.css 的 :root 没定义。`);
  }
}
for (const t of defined) {
  if (!allowed.has(t) && !known.has(t)) {
    fail(
      `自造 token：${t} —— 不在设计系统的合法清单里。` +
        `不要自己编数值，要么这是 astryx 主题升级带来的新 token（补进 contract/tokens.json），` +
        `要么是本项目的合理扩展（同样补进 contract/tokens.json 的 tokens 数组），` +
        `或登记到 knownDeviations 并说明理由。`
    );
  }
}

// ── 3 & 4. 业务代码 / CSS 不得写死设计值 ────────────────────────────
const walk = (dir, test) => {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, test));
    else if (test(p)) out.push(p);
  }
  return out;
};

const HEX = /#[0-9a-fA-F]{6}\b/;
// 写死的固定像素高度：CSS 里的 height: 580px，或 TSX inline style 里的 height: 580。
// 只查 height，不查 min-height/max-height —— 后者是合法的约束（弹窗 max-height、
// 滚动容器上限），规范禁止的是「用组件专属固定高度替代 shell 的高度契约」。
const CSS_HARDCODED_HEIGHT = /(?<![a-z-])height\s*:\s*\d+px/;
const INLINE_STYLE_HEIGHT = /style=\{\{[^}]*\bheight:\s*\d+(?!px)/;

// 存量违规按「文件 → 各类计数」记账。新增会让计数超过基线 → 失败。
// 用计数而不是行号：行号会随无关编辑漂移，计数不会。
const BASELINE = join(ROOT, "design-debt.json");
const counts = {};
const bump = (rel, kind) => {
  counts[rel] ??= { hex: 0, height: 0 };
  counts[rel][kind]++;
};

const tsFiles = walk(SRC, (p) => /\.(tsx|ts)$/.test(p));
// CSS 文件：手写样式(frontend-rules.css 等)现在是唯一的裸色/写死高度可能出现的地方，
// 排除 index.css —— 那是 token 定义本身（:root 块允许字面 hex/color-mix，
// 不能被自己的裸色检查拦下）。
const cssFiles = walk(SRC, (p) => /\.css$/.test(p) && !p.endsWith("index.css"));

for (const file of tsFiles) {
  const rel = relative(REPO, file);
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    // 显式豁免：在元素上方写 `design-exempt: <理由>`。
    // 往上看 6 行 —— JSX 属性列表里插不了注释，注释只能挂在开标签上方。
    if (lines.slice(Math.max(0, i - 6), i + 1).some((l) => /design-exempt/.test(l))) return;

    if (HEX.test(line)) bump(rel, "hex");
    if (INLINE_STYLE_HEIGHT.test(line)) bump(rel, "height");
  });
}

for (const file of cssFiles) {
  const rel = relative(REPO, file);
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    if (lines.slice(Math.max(0, i - 6), i + 1).some((l) => /design-exempt/.test(l))) return;

    if (HEX.test(line)) bump(rel, "hex");
    if (CSS_HARDCODED_HEIGHT.test(line)) bump(rel, "height");
  });
}

const updating = process.argv.includes("--update-baseline");
if (updating) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(
    BASELINE,
    JSON.stringify(
      {
        _comment:
          "设计债基线：业务代码/CSS 里尚未清理的裸 hex 颜色与写死像素高度，按文件计数。" +
          "新增违规会让 verify:tokens 失败；清理后跑 `pnpm verify:tokens -- --update-baseline` 下调基线。目标是清零。",
        debt: counts,
      },
      null,
      2
    ) + "\n"
  );
  const total = Object.values(counts).reduce((s, c) => s + c.hex + c.height, 0);
  console.log(`✓ 已更新设计债基线：${Object.keys(counts).length} 个文件，共 ${total} 项。`);
  process.exit(0);
}

let baseline = {};
try {
  baseline = JSON.parse(readFileSync(BASELINE, "utf8")).debt ?? {};
} catch {
  fail(
    `缺少设计债基线文件 ${relative(REPO, BASELINE)} —— ` +
      `先跑 \`node scripts/verify-tokens.mjs --update-baseline\` 记录存量。`
  );
}

const KIND_HINT = {
  hex: "颜色必须走语义 token（var(--primary) / var(--success)…），或者用 astryx 组件自己的 variant。",
  height:
    "禁止组件专属的写死像素高度，高度应由父级 flex/Stack 布局或 astryx 组件自身的 size/height prop 提供。",
};
const KIND_NAME = { hex: "裸 hex 颜色", height: "写死像素高度" };

for (const [rel, c] of Object.entries(counts)) {
  const base = baseline[rel] ?? { hex: 0, height: 0 };
  for (const kind of ["hex", "height"]) {
    const was = base[kind] ?? 0;
    if (c[kind] > was) {
      fail(
        `${rel}：${KIND_NAME[kind]} ${was} → ${c[kind]}，新增了 ${c[kind] - was} 处。${KIND_HINT[kind]}`
      );
    }
  }
}

// ── 报告 ─────────────────────────────────────────────────────────
if (failures.length) {
  console.error(`\n✗ 设计契约校验未通过（${failures.length} 项）：\n`);
  for (const f of failures) console.error(`  · ${f}`);
  console.error(
    `\n真相源：node_modules/@astryxdesign/theme-neutral/dist/theme.css（astryx 主题包） + src/index.css 的 :root 块（本项目扩展）` +
      `\n契约：  contract/tokens.json\n`
  );
  process.exit(1);
}

const debtTotal = Object.values(counts).reduce((s, c) => s + c.hex + c.height, 0);
console.log(
  `✓ 设计契约通过：${allowed.size} 个 token 全部定义且无自造值。` +
    (debtTotal
      ? `\n  存量设计债 ${debtTotal} 项（已记入基线，未新增）。清理后跑 --update-baseline 下调。`
      : "")
);
