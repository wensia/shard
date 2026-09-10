#!/usr/bin/env node
// Kiln 页面控件契约：没有存量基线，也不豁免共享控件或 dev 目录。
import { readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEXT_TYPES = new Set(["text", "password", "email", "number", "tel", "url", "search", "hidden"]);

function mergeValues(results) {
  return { values: new Set(results.flatMap(result => [...result.values])), unknown: results.some(result => result.unknown) };
}

function typeValues(type, checker) {
  if (type.isUnion()) return mergeValues(type.types.map(member => typeValues(member, checker)));
  if (type.flags & ts.TypeFlags.StringLiteral) return { values: new Set([type.value.toLowerCase()]), unknown: false };
  if (type.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Never)) return { values: new Set(), unknown: false };
  if (type.flags & ts.TypeFlags.TypeParameter) {
    const constraint = checker.getBaseConstraintOfType(type);
    if (constraint && constraint !== type) return typeValues(constraint, checker);
  }
  return { values: new Set(), unknown: true };
}

function expressionValues(expression, checker) {
  // 不让多行、条件表达式或类型断言掩盖原生 picker 的字面类型。
  if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression) || ts.isNonNullExpression(expression)) {
    return expressionValues(expression.expression, checker);
  }
  if (ts.isConditionalExpression(expression)) {
    return mergeValues([expressionValues(expression.whenTrue, checker), expressionValues(expression.whenFalse, checker)]);
  }
  if (ts.isStringLiteralLike(expression)) return { values: new Set([expression.text.toLowerCase()]), unknown: false };
  return typeValues(checker.getTypeAtLocation(expression), checker);
}

function attributeValues(attribute, checker) {
  const value = attribute.initializer;
  if (value && ts.isStringLiteral(value)) return { values: new Set([value.text.toLowerCase()]), unknown: false };
  if (value && ts.isJsxExpression(value) && value.expression) return expressionValues(value.expression, checker);
  return { values: new Set(), unknown: true };
}

function attribute(node, name) {
  return node.attributes.properties.find(property => ts.isJsxAttribute(property) && property.name.getText() === name);
}

function hasStaticHiddenAttribute(node) {
  const hidden = attribute(node, "hidden");
  return !!hidden && (!hidden.initializer || (ts.isJsxExpression(hidden.initializer) && hidden.initializer.expression?.kind === ts.SyntaxKind.TrueKeyword));
}

function isInvisibleFile(node) {
  if (hasStaticHiddenAttribute(node)) return true;
  const style = attribute(node, "style")?.initializer;
  if (style && ts.isJsxExpression(style) && style.expression && ts.isObjectLiteralExpression(style.expression)) {
    return style.expression.properties.some(property => ts.isPropertyAssignment(property)
      && property.name.getText().replaceAll(/["']/g, "") === "display"
      && ts.isStringLiteralLike(property.initializer) && property.initializer.text === "none");
  }
  return false;
}

function hasExplicitStyle(node) {
  return ["className", "style"].some(name => {
    const value = attribute(node, name)?.initializer;
    if (!value) return false;
    if (ts.isStringLiteral(value)) return value.text.trim().length > 0;
    if (!ts.isJsxExpression(value) || !value.expression) return false;
    const expression = value.expression;
    if (ts.isObjectLiteralExpression(expression)) return expression.properties.length > 0;
    if (ts.isStringLiteralLike(expression)) return expression.text.trim().length > 0;
    return expression.kind !== ts.SyntaxKind.NullKeyword && !(ts.isIdentifier(expression) && expression.text === "undefined");
  });
}

function inputAliases(source) {
  const aliases = new Set();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if ((element.propertyName ?? element.name).text === "Input") aliases.add(element.name.text);
    }
  }
  return aliases;
}

export function inspectUiControls(sourceFiles, checker) {
  const failures = [];
  for (const source of sourceFiles) {
    const aliases = inputAliases(source);
    function fail(node, message) {
      const location = source.getLineAndCharacterOfPosition(node.getStart(source));
      failures.push({ file: source.fileName, line: location.line + 1, column: location.character + 1, message });
    }
    function checkTypes(node, values) {
      const forbidden = [...values.values].filter(value => !TEXT_TYPES.has(value) && !(value === "file" && isInvisibleFile(node)));
      if (forbidden.length) fail(node, `禁止原生 input 类型 ${forbidden.join(" / ")}；使用共享 Kiln 控件（file 仅允许显式隐藏的上传桥接）。`);
      if (values.unknown) fail(node, "无法证明 input type 仅为允许的文字输入类型；收窄类型，禁止用 string / any 或动态 props 绕过共享控件。");
    }
    function visit(node) {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tag = node.tagName.getText(source);
        if (tag === "select" || tag === "datalist") {
          fail(node, `禁止原生 <${tag}>；使用共享 Select / Combobox，CSS 包壳或 appearance:none 不构成豁免。`);
        }
        if (["input", "textarea", "button"].includes(tag) && !hasExplicitStyle(node) && !hasStaticHiddenAttribute(node)) {
          const inputType = tag === "input" && attribute(node, "type");
          const types = inputType ? attributeValues(inputType, checker) : null;
          const isHiddenValue = types && !types.unknown && types.values.size > 0 && [...types.values].every(value => value === "hidden");
          if (!isHiddenValue) fail(node, `禁止无样式的原生 <${tag}>；业务表单使用共享控件，语义底层必须有明确 className / style。`);
        }
        if (tag === "input" || /(?:^|\.)\w*Input$/.test(tag) || aliases.has(tag)) {
          for (const property of node.attributes.properties) {
            if (ts.isJsxAttribute(property)) {
              if (property.name.getText(source) === "type") checkTypes(node, attributeValues(property, checker));
              if (property.name.getText(source) === "list") fail(node, "禁止原生 datalist 关联；使用共享 Combobox。");
            } else if (ts.isJsxSpreadAttribute(property)) {
              const spreadType = checker.getTypeAtLocation(property.expression);
              if (spreadType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) {
                checkTypes(node, { values: new Set(), unknown: true });
                continue;
              }
              const typeProperty = checker.getPropertyOfType(spreadType, "type");
              if (typeProperty) checkTypes(node, typeValues(checker.getTypeOfSymbolAtLocation(typeProperty, property), checker));
              const listProperty = checker.getPropertyOfType(spreadType, "list");
              // Shared input props can inherit the optional HTML list property;
              // explicit datalist wiring is rejected above and every datalist is rejected.
              if (listProperty && ts.isObjectLiteralExpression(property.expression)) {
                const explicitList = property.expression.properties.some(item => ts.isPropertyAssignment(item) && item.name.getText() === "list");
                if (explicitList) fail(node, "禁止通过 props 关联原生 datalist；使用共享 Combobox。");
              }
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  return failures;
}

function tsxFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? tsxFiles(path) : entry.isFile() && entry.name.endsWith(".tsx") ? [path] : [];
  });
}

export function verifyUiControls(root = ROOT) {
  const configPath = join(root, "tsconfig.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  const paths = tsxFiles(join(root, "src")).sort();
  const program = ts.createProgram(paths, { ...parsed.options, noEmit: true });
  const sources = paths.map(path => program.getSourceFile(path));
  if (sources.some(source => !source)) throw new Error("未能读取全部 TSX 源文件。");
  return { count: paths.length, failures: inspectUiControls(sources, program.getTypeChecker()) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { count, failures } = verifyUiControls();
  if (failures.length) {
    console.error(`✗ Kiln 默认控件静态契约失败（${failures.length} 项；扫描 ${count} 个 TSX 文件，无豁免基线）：`);
    for (const failure of failures) console.error(`  ${relative(ROOT, failure.file)}:${failure.line}:${failure.column} ${failure.message}`);
    process.exitCode = 1;
  } else {
    console.log(`✓ Kiln 默认控件静态契约通过：已检查 ${count} 个 TSX 文件；实际弹层与视觉状态仍需运行时验证。`);
  }
}
