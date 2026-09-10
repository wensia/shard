import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import ts from "typescript";
import { inspectUiControls, verifyUiControls } from "./verify-ui-controls.mjs";

function inspect(code) {
  const filename = "/fixture.tsx";
  const options = { noLib: true, noResolve: true, strict: true, jsx: ts.JsxEmit.ReactJSX };
  const host = ts.createCompilerHost(options);
  const source = ts.createSourceFile(filename, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  host.getSourceFile = path => path === filename ? source : undefined;
  const program = ts.createProgram([filename], options, host);
  return inspectUiControls([source], program.getTypeChecker());
}

test("多行 JSX 及 CSS 包壳无法豁免原生选择器", () => {
  const failures = inspect(`const Demo = () => <><select\n className="styled"\n style={{ appearance: "none" }}><option>选项</option></select><datalist id="items" /></>`);
  assert.equal(failures.length, 2);
  assert.equal(failures[0].line, 1);
  assert.match(failures[0].message, /Select \/ Combobox/);
});

test("所有原生 picker、勾选和动作 input 类型都会失败", () => {
  for (const type of ["date", "datetime-local", "time", "month", "week", "color", "range", "checkbox", "radio", "file", "button", "reset", "submit", "image"]) {
    assert.equal(inspect(`const Demo = () => <input className="control" type="${type}" />`).length, 1, type);
  }
});

test("共享 Input 包装、命名空间和导入别名不能放行原生日期", () => {
  assert.equal(inspect(`import { Input as Field } from "./input"; const Demo = () => <><Input type="date"/><UI.Input type="month"/><Field type="week"/></>`).length, 3);
});

test("条件表达式、变量、props spread 和类型断言不能绕过检查", () => {
  const fixtures = [
    `declare const enabled: boolean; const Demo = () => <Input type={enabled ? "date" : "text"} />`,
    `const type = "checkbox"; const Demo = () => <input type={type} />`,
    `const props = {type: "date" as const}; const Demo = () => <Input {...props} />`,
    `const Demo = () => <input {...{ type: "radio" }} />`,
    `const Demo = () => <Input type={"date" as "text"} />`,
    `declare const type: string; const Demo = () => <Input type={type} />`,
    `declare const props: any; const Demo = () => <input {...props} />`,
  ];
  for (const code of fixtures) assert.ok(inspect(code).length > 0, code);
});

test("文字输入条件类型、语义控件和明确不可见文件桥接可通过", () => {
  const failures = inspect(`
    declare const visible: boolean;
    declare const props: { type?: "text" | "number" };
    const Demo = () => <>
      <Input type={visible ? "text" : "password"} />
      <Input {...props} />
      <input className="editor-text" type="text" /><input className="editor-text" /><textarea className="editor-text" /><button className="editor-action" type="button" />
      <input type="hidden" value="id" />
      <input type="file" hidden />
      <input type="file" hidden={true} />
      <input type="file" style={{ display: "none" }} />
      <Select /><Checkbox /><RadioGroup /><DatePicker />
    </>;
  `);
  assert.deepEqual(failures, []);
});

test("不确定隐藏状态或 aria-hidden 不会放行文件输入", () => {
  assert.equal(inspect(`declare const hidden: boolean; const Demo = () => <><input className="control" type="file" hidden={hidden}/><input className="control" type="file" hidden={false}/><input className="control" type="file" aria-hidden="true"/></>`).length, 3);
});

test("原生 datalist 关联也会失败", () => {
  assert.equal(inspect(`const Demo = () => <><Input list="items"/><input className="control" {...{list: "items"}}/></>`).length, 2);
});

test("原生语义底层也必须有明确样式，空 className / style 不能充数", () => {
  assert.equal(inspect(`const Demo = () => <><input/><textarea/><button/><input className=""/><button style={{}}/><textarea className={undefined}/></>`).length, 6);
});

test("项目扫描包含业务、共享控件与 dev，不服从 tsconfig 的目录排除", () => {
  const root = mkdtempSync(join(tmpdir(), "shard-ui-control-fixture-"));
  try {
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { jsx: "react-jsx", strict: true }, exclude: ["src/dev", "src/components/ui"] }));
    for (const folder of ["features/tables", "components/ui", "dev"]) {
      const directory = join(root, "src", folder);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "fixture.tsx"), "const Demo = () => <select />;");
    }
    const result = verifyUiControls(root);
    assert.equal(result.count, 3);
    assert.equal(result.failures.length, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
