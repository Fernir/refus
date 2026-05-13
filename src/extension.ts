import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";

/** @author Nikolay Alekseev <domainexecute@gmail.com> */

const execFileAsync = promisify(execFile);

function isDeclarationFile(uri: vscode.Uri): boolean {
  return uri.fsPath.endsWith(".d.ts");
}

function isNuxtInternalModule(fsPath: string): boolean {
  const norm = fsPath.replace(/\\/g, "/").toLowerCase();
  return (
    norm.includes("/node_modules/@nuxt/") ||
    norm.includes("/node_modules/nuxt/")
  );
}

function shouldKeepLocation(uri: vscode.Uri): boolean {
  if (isDeclarationFile(uri)) {
    return false;
  }
  if (isNuxtInternalModule(uri.fsPath)) {
    return false;
  }
  return true;
}

function locationKey(loc: vscode.Location): string {
  const r = loc.range;
  return `${loc.uri.toString()}|${r.start.line}|${r.start.character}|${r.end.line}|${r.end.character}`;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toPascalCase(seg: string): string {
  if (/[-_\s]/.test(seg)) {
    return seg
      .split(/[-_\s]+/)
      .filter(Boolean)
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
      .join("");
  }
  return seg.charAt(0).toUpperCase() + seg.slice(1);
}

function toKebabCase(seg: string): string {
  return seg
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[\s_]+/g, "-")
    .toLowerCase();
}

const NUXT_STRIP_EXT = /\.(vue|ts|mts|cts)$/i;

/** Только .vue и TypeScript в типичных каталогах Nuxt (+ nuxt/app config). Без React (.tsx/.jsx) и прочего. */
function isRefusSupportedSourcePath(fsPath: string): boolean {
  const p = fsPath.replace(/\\/g, "/");
  if (p.toLowerCase().endsWith(".d.ts")) {
    return false;
  }
  if (/\.vue$/i.test(p)) {
    return true;
  }
  if (/\.(tsx|jsx|mjs|cjs|js)$/i.test(p)) {
    return false;
  }
  if (!/\.(ts|mts|cts)$/i.test(p)) {
    return false;
  }
  if (/\/\.nuxt\//i.test(p)) {
    return false;
  }
  if (
    /\/(composables|utils|plugins|server|middleware|modules|stores|layouts|pages|components|app)\//i.test(
      p
    )
  ) {
    return true;
  }
  if (/(^|\/)nuxt\.config\.(ts|mts)$/i.test(p)) {
    return true;
  }
  if (/(^|\/)app\.config\.ts$/i.test(p)) {
    return true;
  }
  return false;
}

function isRefusSupportedDocument(document: vscode.TextDocument): boolean {
  return isRefusSupportedSourcePath(document.uri.fsPath);
}

/** Globs для ripgrep: только vue и nuxt-деревья (OR между --glob). */
const RG_INCLUDE_GLOBS = [
  "**/*.vue",
  "**/composables/**/*.ts",
  "**/composables/**/*.mts",
  "**/utils/**/*.ts",
  "**/plugins/**/*.ts",
  "**/server/**/*.ts",
  "**/middleware/**/*.ts",
  "**/modules/**/*.ts",
  "**/stores/**/*.ts",
  "**/layouts/**/*.ts",
  "**/pages/**/*.ts",
  "**/components/**/*.ts",
  "**/app/**/*.ts",
  "**/nuxt.config.ts",
  "**/nuxt.config.mts",
  "**/app.config.ts",
];

const RG_EXCLUDE_GLOBS = [
  "**/node_modules/**",
  "**/.git/**",
  "**/*.d.ts",
  "**/.nuxt/**",
  "**/.output/**",
  "**/dist/**",
  "**/coverage/**",
];

/** Тот же бинарник ripgrep, что использует VS Code (быстрый prefilter файлов). */
function getRgBinaryPath(): string | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { rgPath } = require("@vscode/ripgrep") as { rgPath: string };
    return rgPath.replace(/\bnode_modules\.asar\b/, "node_modules.asar.unpacked");
  } catch {
    return undefined;
  }
}

function buildRgLiteralNeedles(plan: ModuleConsumerSearchPlan, isVue: boolean): string[] {
  const out: string[] = [];
  for (const n of plan.importNeedles.slice(0, 28)) {
    if (n.length >= 2 && !n.includes("\n")) {
      out.push(n);
    }
  }
  for (const s of plan.symbolNeedles) {
    if (!s.includes("\n")) {
      out.push(s);
    }
  }
  if (isVue && plan.pascalTag) {
    out.push(`<${plan.pascalTag}`);
  }
  if (isVue && plan.kebabTag) {
    out.push(`<${plan.kebabTag}`);
  }
  return [...new Set(out)];
}

/**
 * Список абсолютных путей файлов, где встречается хотя бы один литерал (rg -F).
 * `undefined` — ошибка rg, тогда вызывающий делает полный findFiles.
 */
async function listWorkspaceFilesMatchingLiterals(
  workspaceRootFs: string,
  literals: string[],
  rgPath: string
): Promise<string[] | undefined> {
  if (literals.length === 0) {
    return [];
  }
  const maxPerChunk = 16;
  const merged = new Set<string>();

  for (let i = 0; i < literals.length; i += maxPerChunk) {
    const chunk = literals.slice(i, i + maxPerChunk);
    const args = ["-l", "--follow", "--threads", "4"];
    for (const g of RG_INCLUDE_GLOBS) {
      args.push("--glob", g);
    }
    for (const g of RG_EXCLUDE_GLOBS) {
      args.push("--glob", `!${g}`);
    }
    args.push("-F");
    for (const lit of chunk) {
      args.push("-e", lit);
    }
    args.push(".");
    try {
      const { stdout } = await execFileAsync(rgPath, args, {
        cwd: workspaceRootFs,
        maxBuffer: 64 * 1024 * 1024,
        encoding: "utf8",
      });
      for (const line of stdout.split("\n")) {
        const t = line.trim();
        if (t) {
          merged.add(path.resolve(workspaceRootFs, t));
        }
      }
    } catch (err: unknown) {
      const e = err as { code?: string | number; status?: number };
      if (e.status === 1 || e.code === 1 || e.code === "1") {
        continue;
      }
      return undefined;
    }
  }
  return [...merged];
}

type ModuleConsumerSearchPlan = {
  importNeedles: string[];
  pascalTag: string | undefined;
  kebabTag: string | undefined;
  symbolNeedles: string[];
};

/** Пути для import/from; для .vue — теги в шаблоне; для .ts — имена экспортов (use*, или единственный экспорт). */
function buildModuleConsumerSearchPlan(
  sourceFsPath: string,
  workspaceRootFs: string,
  sourceFileText: string,
  isVue: boolean
): ModuleConsumerSearchPlan {
  const rel = path.relative(workspaceRootFs, sourceFsPath).replace(/\\/g, "/");
  const relNoExt = rel.replace(NUXT_STRIP_EXT, "");
  const dir = path.posix.dirname(rel);
  const fileBase = path.posix.basename(relNoExt);

  const importNeedles: string[] = [];

  importNeedles.push(rel, relNoExt);

  let componentStem = fileBase;
  if (/^index$/i.test(fileBase)) {
    const parent = path.posix.basename(dir);
    if (parent && parent !== "." && parent !== "..") {
      componentStem = parent;
      importNeedles.push(dir, `${dir}/index`);
      importNeedles.push(
        `${dir}/index.vue`,
        `${dir}/index.ts`,
        `${dir}/index.mts`,
        `${dir}/index.cts`
      );
    }
  }

  const unique = [...new Set(importNeedles.map((n) => n.replace(/\\/g, "/")))]
    .filter((n) => n.length > 0 && !/^index$/i.test(n))
    .sort((a, b) => b.length - a.length);

  const withAliases: string[] = [...unique];
  for (const n of unique) {
    const noSrc = n.replace(/^src\//i, "");
    if (noSrc !== n) {
      withAliases.push(noSrc);
    }
    const noApp = n.replace(/^app\//i, "");
    if (noApp !== n) {
      withAliases.push(noApp);
    }
  }
  const importNeedlesSorted = [...new Set(withAliases)].sort((a, b) => b.length - a.length);

  let pascalTag: string | undefined;
  let kebabTag: string | undefined;
  if (isVue) {
    const stemClean = componentStem.replace(/\.vue$/i, "");
    const pascal = toPascalCase(stemClean);
    const kebab = toKebabCase(stemClean);
    pascalTag = pascal.length >= 2 ? pascal : undefined;
    kebabTag =
      kebab.length >= 2 && (kebab.includes("-") || kebab.length >= 4) ? kebab : undefined;
  }

  const symbolNeedles = isVue ? [] : collectExportedRuntimeSymbolNeedles(sourceFileText);

  return {
    importNeedles: importNeedlesSorted,
    pascalTag,
    kebabTag,
    symbolNeedles,
  };
}

/** Имена для поиска `useFoo()` / auto-import; без типов. */
function collectExportedRuntimeSymbolNeedles(text: string): string[] {
  const names = new Set<string>();

  for (const m of text.matchAll(/\bexport\s+(?:declare\s+)?(?:async\s+)?function\s+([a-zA-Z_$][\w$]*)/g)) {
    if (m[1]) {
      names.add(m[1]);
    }
  }
  for (const m of text.matchAll(
    /\bexport\s+(?:declare\s+)?(?:const|let|var)\s+([a-zA-Z_$][\w$]*)/g
  )) {
    if (m[1]) {
      names.add(m[1]);
    }
  }
  for (const m of text.matchAll(
    /\bexport\s+(?:declare\s+)?(?:abstract\s+)?class\s+([a-zA-Z_$][\w$]*)/g
  )) {
    if (m[1]) {
      names.add(m[1]);
    }
  }
  for (const m of text.matchAll(
    /\bexport\s+default\s+(?:async\s+)?function\s+([a-zA-Z_$][\w$]*)/g
  )) {
    if (m[1]) {
      names.add(m[1]);
    }
  }

  const reExport = /\bexport\s*\{([^}]+)\}(?!\s*from)/g;
  let m: RegExpExecArray | null;
  while ((m = reExport.exec(text)) !== null) {
    const inner = m[1] ?? "";
    for (const spec of inner.split(",").map((s) => s.trim()).filter(Boolean)) {
      if (/^type\s+/i.test(spec)) {
        continue;
      }
      const asMatch = /^(.+?)\s+as\s+([a-zA-Z_$][\w$]*)$/.exec(spec);
      const exported = asMatch ? asMatch[2]!.trim() : spec.trim();
      const nameMatch = /^([a-zA-Z_$][\w$]*)$/.exec(exported);
      if (nameMatch?.[1]) {
        names.add(nameMatch[1]);
      }
    }
  }

  const list = [...names].filter((n) => n.length >= 2);
  const useLike = list.filter((n) => /^use[A-Za-z0-9_$]/.test(n) && n.length >= 4);
  if (useLike.length > 0) {
    return [...new Set(useLike)];
  }
  if (list.length === 1) {
    return list;
  }
  return [];
}

/** Совпадение пути только внутри однострочной строки в кавычках (import/from/dynamic import). */
function rangesForNeedleInImportStrings(
  line: string,
  lineStartOffset: number,
  needle: string,
  doc: vscode.TextDocument
): vscode.Range[] {
  if (needle.length < 2) {
    return [];
  }
  const ranges: vscode.Range[] = [];
  const e = escapeRegExp(needle);
  const re = new RegExp(`(['"\`])[^'"\`\\n]*${e}[^'"\`\\n]*\\1`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    const slice = line.slice(m.index, m.index + m[0].length);
    const localIdx = slice.indexOf(needle);
    if (localIdx === -1) {
      continue;
    }
    const needleIdx = m.index + localIdx;
    const abs = lineStartOffset + needleIdx;
    ranges.push(
      new vscode.Range(doc.positionAt(abs), doc.positionAt(abs + needle.length))
    );
  }
  return ranges;
}

function lineLooksLikeImportOrExportPath(line: string): boolean {
  const t = line.trimStart();
  if (/^import\s/.test(t)) {
    return true;
  }
  if (/\bfrom\s+['"`]/.test(t)) {
    return true;
  }
  if (/\bimport\s*\(\s*['"`]/.test(t)) {
    return true;
  }
  if (/\brequire\s*\(\s*['"`]/.test(t)) {
    return true;
  }
  if (/\bexport\s+.*\bfrom\s+['"`]/.test(t)) {
    return true;
  }
  return false;
}

function rangesForTemplateTags(
  line: string,
  lineStartOffset: number,
  doc: vscode.TextDocument,
  pascalTag: string | undefined,
  kebabTag: string | undefined
): vscode.Range[] {
  if (!line.includes("<")) {
    return [];
  }
  const ranges: vscode.Range[] = [];
  if (pascalTag) {
    const re = new RegExp(`<${escapeRegExp(pascalTag)}\\b`, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      const abs = lineStartOffset + m.index + 1;
      ranges.push(
        new vscode.Range(doc.positionAt(abs), doc.positionAt(abs + pascalTag.length))
      );
    }
  }
  if (kebabTag) {
    const re = new RegExp(`<${escapeRegExp(kebabTag)}\\b`, "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      const abs = lineStartOffset + m.index + 1;
      ranges.push(
        new vscode.Range(doc.positionAt(abs), doc.positionAt(abs + kebabTag.length))
      );
    }
  }
  return ranges;
}

function rangesForSymbolNeedle(
  line: string,
  lineStartOffset: number,
  name: string,
  doc: vscode.TextDocument
): vscode.Range[] {
  if (name.length < 2) {
    return [];
  }
  const ranges: vscode.Range[] = [];
  const re = new RegExp(`\\b${escapeRegExp(name)}\\b`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    const abs = lineStartOffset + m.index;
    ranges.push(
      new vscode.Range(doc.positionAt(abs), doc.positionAt(abs + name.length))
    );
  }
  return ranges;
}

function scanFileForModuleConsumers(
  doc: vscode.TextDocument,
  plan: ModuleConsumerSearchPlan,
  scanTemplates: boolean
): vscode.Range[] {
  const text = doc.getText();
  const isVue = doc.languageId === "vue" || doc.uri.fsPath.toLowerCase().endsWith(".vue");
  const out: vscode.Range[] = [];
  let offset = 0;
  for (const line of text.split("\n")) {
    const lineStart = offset;
    if (lineLooksLikeImportOrExportPath(line)) {
      for (const needle of plan.importNeedles) {
        out.push(...rangesForNeedleInImportStrings(line, lineStart, needle, doc));
      }
    }
    if (scanTemplates && isVue) {
      out.push(
        ...rangesForTemplateTags(line, lineStart, doc, plan.pascalTag, plan.kebabTag)
      );
    }
    for (const sym of plan.symbolNeedles) {
      out.push(...rangesForSymbolNeedle(line, lineStart, sym, doc));
    }
    offset += line.length + 1;
  }
  return out;
}

async function findModuleUsersByTextSearch(
  sourceUri: vscode.Uri,
  workspaceFolder: vscode.WorkspaceFolder,
  sourceDocument: vscode.TextDocument
): Promise<vscode.Location[]> {
  const wsRoot = workspaceFolder.uri.fsPath;
  const sourcePath = sourceUri.fsPath;
  const isVue =
    sourceDocument.languageId === "vue" ||
    sourceUri.fsPath.toLowerCase().endsWith(".vue");
  const plan = buildModuleConsumerSearchPlan(
    sourcePath,
    wsRoot,
    sourceDocument.getText(),
    isVue
  );

  const findFilesPattern = new vscode.RelativePattern(
    workspaceFolder,
    "**/*.{vue,ts,mts,cts}"
  );
  const findFilesExclude =
    "{**/node_modules/**,**/.git/**,**/*.d.ts,**/.nuxt/**,**/.output/**,**/dist/**,**/coverage/**}";

  const rgLiterals = buildRgLiteralNeedles(plan, isVue);
  const rgBin = getRgBinaryPath();

  let files: vscode.Uri[];
  if (rgBin) {
    const matchedAbs = await listWorkspaceFilesMatchingLiterals(wsRoot, rgLiterals, rgBin);
    if (matchedAbs !== undefined) {
      files = matchedAbs.map((p) => vscode.Uri.file(p));
    } else {
      files = await vscode.workspace.findFiles(findFilesPattern, findFilesExclude, 8000);
    }
  } else {
    files = await vscode.workspace.findFiles(findFilesPattern, findFilesExclude, 8000);
  }

  files = files.filter(
    (u) =>
      u.fsPath !== sourcePath &&
      shouldKeepLocation(u) &&
      isRefusSupportedSourcePath(u.fsPath)
  );

  const merged = new Map<string, vscode.Location>();
  const batchSize = 50;

  for (let i = 0; i < files.length; i += batchSize) {
    const batch = files.slice(i, i + batchSize);
    await Promise.all(
      batch.map(async (uri) => {
        const doc = await vscode.workspace.openTextDocument(uri);
        const ranges = scanFileForModuleConsumers(doc, plan, isVue);
        for (const range of ranges) {
          const loc = new vscode.Location(uri, range);
          merged.set(locationKey(loc), loc);
        }
      })
    );
  }

  return [...merged.values()].sort((a, b) => {
    const pa = a.uri.fsPath;
    const pb = b.uri.fsPath;
    if (pa !== pb) {
      return pa.localeCompare(pb);
    }
    return a.range.start.compareTo(b.range.start);
  });
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("refus.findFileUsers", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        await vscode.window.showWarningMessage("Нет активного редактора.");
        return;
      }

      const document = editor.document;
      const peekPosition = editor.selection.active;

      if (!isRefusSupportedDocument(document)) {
        await vscode.window.showInformationMessage(
          "Refus только для Vue и Nuxt: файл .vue или .ts/.mts/.cts в composables, pages, server, plugins, … См. README."
        );
        return;
      }

      const folder = vscode.workspace.getWorkspaceFolder(document.uri);
      if (!folder) {
        await vscode.window.showWarningMessage(
          "Refus: откройте папку проекта (workspace), иначе поиск не работает."
        );
        return;
      }
      const filtered = await findModuleUsersByTextSearch(
        document.uri,
        folder,
        document
      );
      if (filtered.length === 0) {
        await vscode.window.showInformationMessage(
          "Refus: совпадений нет (импорты в кавычках, в .vue — ещё теги <Pascal / kebab>, в composables — use* / один export)."
        );
        return;
      }
      await vscode.commands.executeCommand(
        "editor.action.showReferences",
        document.uri,
        peekPosition,
        filtered
      );
    })
  );
}

export function deactivate(): void {}
