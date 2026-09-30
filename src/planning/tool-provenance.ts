/** Read package declarations without importing or executing the evaluated plugin. */
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import ts from "typescript";
import type { JsonObject } from "../core/models.js";

type Value = string | Record<string, unknown> | undefined;

export function extractToolRegistrations(source: string, filename: string): Array<{ name: string; description: string; line: number }> {
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const bindings = new Map<string, ts.Node | null>();
  const defineToolNames = new Set<string>();
  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text === "@deepseek-ai/dsh-tools") {
      const imports = statement.importClause?.namedBindings;
      if (imports && ts.isNamedImports(imports)) for (const item of imports.elements) {
        if ((item.propertyName?.text ?? item.name.text) === "defineTool") defineToolNames.add(item.name.text);
      }
    }
  }
  const bind = (name: string, node: ts.Node) => bindings.set(name, bindings.has(name) ? null : node);
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) bind(node.name.text, node.initializer);
    if (ts.isFunctionDeclaration(node) && node.name) bind(node.name.text, node);
    ts.forEachChild(node, collect);
  };
  collect(file);
  const evaluate = (node: ts.Node | undefined, locals = new Map<string, Value>(), depth = 0): Value => {
    if (!node || depth > 18) return undefined;
    const next = (n: ts.Node | undefined, scope = locals) => evaluate(n, scope, depth + 1);
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) return next(node.expression);
    if (ts.isIdentifier(node)) return locals.has(node.text) ? locals.get(node.text) : next(bindings.get(node.text) ?? undefined);
    if (ts.isObjectLiteralExpression(node)) {
      const result: Record<string, unknown> = {};
      for (const p of node.properties) {
        if (ts.isSpreadAssignment(p)) {
          const spread = next(p.expression);
          if (spread && typeof spread === "object") Object.assign(result, spread);
          else { delete result.name; delete result.description; }
        } else if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) {
          if (["name", "description"].includes(p.name.text)) result[p.name.text] = next(p.initializer);
        } else if (ts.isShorthandPropertyAssignment(p)) result[p.name.text] = next(p.name);
      }
      return result;
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      // defineTool preserves the public name. Other wrappers must resolve to a local function body.
      if (defineToolNames.has(node.expression.text) && !bindings.has(node.expression.text) && !locals.has(node.expression.text)) return next(node.arguments[0]);
      const fn = bindings.get(node.expression.text);
      if (!fn || !(ts.isFunctionDeclaration(fn) || ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) || !fn.body) return undefined;
      const scope = new Map(locals);
      fn.parameters.forEach((p, i) => { if (ts.isIdentifier(p.name)) scope.set(p.name.text, next(node.arguments[i] ?? p.initializer)); });
      if (!ts.isBlock(fn.body)) return next(fn.body, scope);
      const values: Value[] = [];
      const returns = (n: ts.Node): void => {
        if (ts.isReturnStatement(n)) { values.push(next(n.expression, scope)); return; }
        if (ts.isFunctionLike(n)) return;
        ts.forEachChild(n, returns);
      };
      returns(fn.body);
      const first = values[0];
      return values.length > 0 && values.every(v => JSON.stringify(v) === JSON.stringify(first)) ? first : undefined;
    }
    return undefined;
  };
  const result: Array<{ name: string; description: string; line: number }> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "register" &&
      ts.isPropertyAccessExpression(node.expression.expression) && node.expression.expression.name.text === "tools") {
      const value = evaluate(node.arguments[0]);
      if (value && typeof value === "object" && typeof value.name === "string" && /^[A-Za-z0-9_.:-]{1,160}$/u.test(value.name)) {
        result.push({ name: value.name, description: typeof value.description === "string" ? value.description.slice(0,4000) : "",
          line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1 });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return result;
}

const packageName = (value: string) => value.startsWith("@") ? value.split("/").slice(0,2).join("/") : value.split("/")[0]!;
const safePackage = (value: string) => /^(?:@[\w.-]+\/)?[\w.-]+$/u.test(value) && !value.includes("..");
const inside = (root: string, file: string) => file === root || file.startsWith(root + path.sep);

export async function collectToolProvenance(sourceRoot: string, profileRoot: string, bundles: readonly string[]): Promise<JsonObject[]> {
  const locate = async (name: string, parent?: string) => {
    if (!safePackage(name)) return undefined;
    for (const base of [path.join(profileRoot,"local-plugins"), path.join(profileRoot,"node_modules"), ...(parent ? [path.join(parent,"node_modules")] : []), path.join(sourceRoot,"node_modules")]) {
      try {
        const root = await realpath(path.join(base,name));
        const manifest = JSON.parse(await readFile(path.join(root,"package.json"),"utf8"));
        if (manifest.name === name) return {root,manifest};
      } catch { /* Unresolved packages do not acquire invented ownership. */ }
    }
    return undefined;
  };
  const result: JsonObject[] = [];
  for (const bundle of [...new Set(bundles)].slice(0,100)) {
    const owner = packageName(bundle), located = await locate(owner);
    if (!located) continue;
    const base = ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@deepseek-ai/dsh-headless", "evaldock-runtime-probe"].includes(owner);
    const packages = [located];
    for (const dependency of Object.keys(located.manifest.dependencies ?? {}).filter(n=>n.startsWith("@deepseek-ai/dsh-tool-") && !n.endsWith("-policy"))) {
      const found = await locate(dependency,located.root); if (found) packages.push(found);
    }
    for (const pkg of packages) {
      const queue: string[] = [], seen = new Set<string>(); let bytes = 0;
      const entries = (v: unknown): void => {
        if (typeof v === "string" && /\.(?:c|m)?js$/u.test(v) && !v.includes("*")) queue.push(path.resolve(pkg.root,v));
        else if (v && typeof v === "object") for (const x of Object.values(v)) entries(x);
      };
      entries(pkg.manifest.main ?? "index.js"); entries(pkg.manifest.exports);
      while (queue.length && seen.size < 128 && bytes < 24*1024*1024) {
        const candidate = queue.shift()!; let file: string, source: string;
        try {
          file = await realpath(candidate);
          if (!inside(pkg.root,file) || seen.has(file)) continue;
          seen.add(file); const size = (await stat(file)).size;
          if (size > 8*1024*1024 || bytes + size > 24*1024*1024) continue;
          source = await readFile(file,"utf8"); bytes += Buffer.byteLength(source);
        } catch { continue; }
        const ast = ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
        for (const statement of ast.statements) {
          if ((ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text.startsWith(".")) {
            queue.push(path.resolve(path.dirname(file),statement.moduleSpecifier.text));
          }
        }
        for (const tool of extractToolRegistrations(source,file)) result.push({
          name: tool.name, description: tool.description, schema: String(pkg.manifest.name), status: "STATIC_DECLARATION",
          attribution: {kind: base ? "BASELINE" : "TESTED_PLUGIN", plugins:[owner], basis:"STATIC_REGISTRATION",
            evidence:[{package:String(pkg.manifest.name),version:String(pkg.manifest.version??"UNKNOWN"),file:path.relative(pkg.root,file),line:tool.line,sha256:createHash("sha256").update(source).digest("hex")}]},
        });
      }
    }
  }
  return result.sort((a,b)=>String(a.name).localeCompare(String(b.name)));
}
