import * as path from "node:path";
import * as vscode from "vscode";

/** @author Nikolay Alekseev <domainexecute@gmail.com> */

const NUXT_STRIP_EXT = /\.(vue|ts|mts|cts)$/i;
const QUOTED_STRING_RE = /(['"`])(?:(?!\1)[^\n])*?\1/g;
const IMPORT_LINE_RE =
  /^\s*import\s|(?:\bfrom|\bimport\s*\(|\brequire\s*\()\s*['"`]|\bexport\s+.*\bfrom\s+['"`]/;
const NUXT_TS_DIR_RE =
  /\/(composables|utils|plugins|server|middleware|modules|stores|layouts|pages|components|app)\//i;
const FIND_EXCLUDE =
  "{**/node_modules/**,**/.git/**,**/*.d.ts,**/.nuxt/**,**/.output/**,**/dist/**,**/coverage/**}";
const FIND_LIMIT = 8000;
const READ_BATCH = 80;

const decoder = new TextDecoder("utf-8");

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normPath(fsPath: string): string {
  return fsPath.includes("\\") ? fsPath.replace(/\\/g, "/") : fsPath;
}

function toPascalCase(seg: string): string {
  if (/[-_\s]/.test(seg)) {
    let out = "";
    let up = true;
    for (const c of seg) {
      if (/[-_\s]/.test(c)) {
        up = true;
      } else {
        out += up ? c.toUpperCase() : c;
        up = false;
      }
    }
    return out;
  }
  return seg ? seg[0]!.toUpperCase() + seg.slice(1) : seg;
}

function toKebabCase(seg: string): string {
  return seg
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[\s_]+/g, "-")
    .toLowerCase();
}

function nuxtComponentTagNames(relNoExt: string): { pascal: string[]; kebab: string[] } {
  const m = normPath(relNoExt).match(/(?:^|\/)components\/(.+)$/i);
  if (!m?.[1]) {
    return { pascal: [], kebab: [] };
  }
  let segments = m[1].split("/").filter(Boolean);
  const last = segments[segments.length - 1];
  if (last && /^index$/i.test(last)) {
    segments.pop();
  }
  if (segments.length === 0) {
    return { pascal: [], kebab: [] };
  }
  const fullPascal = segments.map(toPascalCase).join("");
  const fullKebab = segments.map(toKebabCase).join("-");
  const leaf = segments[segments.length - 1]!;
  const leafPascal = toPascalCase(leaf);
  const leafKebab = toKebabCase(leaf);
  const pascal = leafPascal !== fullPascal ? [fullPascal, leafPascal] : [fullPascal];
  const kebab = leafKebab !== fullKebab ? [fullKebab, leafKebab] : [fullKebab];
  return { pascal, kebab };
}

function isSupportedSourcePath(fsPath: string): boolean {
  const p = normPath(fsPath);
  const lower = p.toLowerCase();
  if (lower.endsWith(".d.ts")) {
    return false;
  }
  if (lower.includes("/node_modules/@nuxt/") || lower.includes("/node_modules/nuxt/")) {
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
  if (NUXT_TS_DIR_RE.test(p)) {
    return true;
  }
  return /(^|\/)nuxt\.config\.(ts|mts)$/i.test(p) || /(^|\/)app\.config\.ts$/i.test(p);
}

type ScanPlan = {
  importNeedles: string[];
  pascalRes: RegExp[];
  kebabRes: RegExp[];
  symbolRes: RegExp[];
  prefilter: string[];
};

function uniqueSortedNeedles(items: string[]): string[] {
  return [...new Set(items)]
    .filter((n) => n.length >= 2 && !/^index$/i.test(n))
    .sort((a, b) => b.length - a.length);
}

function buildScanPlan(
  sourceFsPath: string,
  workspaceRootFs: string,
  sourceText: string,
  sourceIsVue: boolean
): ScanPlan {
  const rel = normPath(path.relative(workspaceRootFs, sourceFsPath));
  const relNoExt = rel.replace(NUXT_STRIP_EXT, "");
  const dir = path.posix.dirname(rel);
  const fileBase = path.posix.basename(relNoExt);

  const rawImports = [rel, relNoExt];
  let componentStem = fileBase;
  if (/^index$/i.test(fileBase)) {
    const parent = path.posix.basename(dir);
    if (parent && parent !== "." && parent !== "..") {
      componentStem = parent;
      rawImports.push(dir, `${dir}/index`, `${dir}/index.vue`, `${dir}/index.ts`);
    }
  }

  const importNeedles: string[] = [];
  for (const n of uniqueSortedNeedles(rawImports)) {
    importNeedles.push(n);
    if (/^src\//i.test(n)) {
      importNeedles.push(n.slice(4));
    }
    if (/^app\//i.test(n)) {
      importNeedles.push(n.slice(4));
    }
  }
  const importUnique = [...new Set(importNeedles)].sort((a, b) => b.length - a.length);

  const pascalTags: string[] = [];
  const kebabTags: string[] = [];
  if (sourceIsVue) {
    const nuxtNames = nuxtComponentTagNames(relNoExt);
    for (const p of nuxtNames.pascal) {
      if (p.length >= 2) {
        pascalTags.push(p);
      }
    }
    for (const k of nuxtNames.kebab) {
      if (k.length >= 2 && (k.includes("-") || k.length >= 4)) {
        kebabTags.push(k);
      }
    }
    if (pascalTags.length === 0) {
      const stem = componentStem.replace(/\.vue$/i, "");
      const p = toPascalCase(stem);
      const k = toKebabCase(stem);
      if (p.length >= 2) {
        pascalTags.push(p);
      }
      if (k.length >= 2 && (k.includes("-") || k.length >= 4)) {
        kebabTags.push(k);
      }
    }
  }

  const symbolNames = sourceIsVue ? [] : collectSymbolNeedles(sourceText);
  const prefilter = new Set<string>();
  for (const n of importUnique) {
    prefilter.add(n);
  }
  for (const t of pascalTags) {
    prefilter.add(`<${t}`);
  }
  for (const t of kebabTags) {
    prefilter.add(`<${t}`);
  }
  for (const s of symbolNames) {
    prefilter.add(s);
  }

  return {
    importNeedles: importUnique,
    pascalRes: [...new Set(pascalTags)].map((t) => new RegExp(`<${escapeRegExp(t)}\\b`, "g")),
    kebabRes: [...new Set(kebabTags)].map((t) => new RegExp(`<${escapeRegExp(t)}\\b`, "gi")),
    symbolRes: symbolNames.map((s) => new RegExp(`\\b${escapeRegExp(s)}\\b`, "g")),
    prefilter: [...prefilter],
  };
}

function collectSymbolNeedles(text: string): string[] {
  const names = new Set<string>();
  const re =
    /\bexport\s+(?:declare\s+)?(?:(?:async\s+)?function|(?:const|let|var)|(?:abstract\s+)?class)\s+([a-zA-Z_$][\w$]*)|\bexport\s+default\s+(?:async\s+)?function\s+([a-zA-Z_$][\w$]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const id = m[1] ?? m[2];
    if (id) {
      names.add(id);
    }
  }
  const reExport = /\bexport\s*\{([^}]+)\}(?!\s*from)/g;
  while ((m = reExport.exec(text)) !== null) {
    for (const spec of (m[1] ?? "").split(",")) {
      const t = spec.trim();
      if (!t || /^type\s+/i.test(t)) {
        continue;
      }
      const asMatch = /^(.+?)\s+as\s+([a-zA-Z_$][\w$]*)$/.exec(t);
      const exported = (asMatch ? asMatch[2] : t).trim();
      if (/^[a-zA-Z_$][\w$]*$/.test(exported)) {
        names.add(exported);
      }
    }
  }
  const list = [...names].filter((n) => n.length >= 2);
  const useLike = list.filter((n) => n.length >= 4 && /^use[A-Za-z0-9_$]/.test(n));
  return useLike.length > 0 ? useLike : list.length === 1 ? list : [];
}

function mightMatch(text: string, literals: string[]): boolean {
  if (literals.length === 0) {
    return true;
  }
  for (const lit of literals) {
    if (text.includes(lit)) {
      return true;
    }
  }
  return false;
}

function scanImportLine(
  line: string,
  lineNum: number,
  needles: string[],
  out: vscode.Range[]
): void {
  QUOTED_STRING_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = QUOTED_STRING_RE.exec(line)) !== null) {
    const slice = m[0];
    const base = m.index;
    for (const needle of needles) {
      let idx = 0;
      while ((idx = slice.indexOf(needle, idx)) !== -1) {
        const start = base + idx;
        out.push(new vscode.Range(lineNum, start, lineNum, start + needle.length));
        idx += needle.length;
      }
    }
  }
}

function scanTagRes(line: string, lineNum: number, res: RegExp[], out: vscode.Range[]): void {
  for (const re of res) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      const start = m.index + 1;
      out.push(new vscode.Range(lineNum, start, lineNum, start + m[0].length - 1));
    }
  }
}

function scanSymbolRes(line: string, lineNum: number, res: RegExp[], out: vscode.Range[]): void {
  for (const re of res) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      out.push(new vscode.Range(lineNum, m.index, lineNum, m.index + m[0].length));
    }
  }
}

function scanText(
  text: string,
  plan: ScanPlan,
  sourceIsVue: boolean,
  fileIsVue: boolean
): vscode.Range[] {
  const out: vscode.Range[] = [];
  const hasImports = plan.importNeedles.length > 0;
  const hasTags =
    sourceIsVue &&
    fileIsVue &&
    (plan.pascalRes.length > 0 || plan.kebabRes.length > 0);
  const hasSymbols = plan.symbolRes.length > 0;

  let lineNum = 0;
  let lineStart = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text.charCodeAt(i) === 10) {
      const line = text.slice(lineStart, i);
      if (hasImports && IMPORT_LINE_RE.test(line)) {
        scanImportLine(line, lineNum, plan.importNeedles, out);
      }
      if (hasTags && line.includes("<")) {
        scanTagRes(line, lineNum, plan.pascalRes, out);
        scanTagRes(line, lineNum, plan.kebabRes, out);
      }
      if (hasSymbols) {
        scanSymbolRes(line, lineNum, plan.symbolRes, out);
      }
      lineNum++;
      lineStart = i + 1;
    }
  }
  return out;
}

async function readText(uri: vscode.Uri): Promise<string | undefined> {
  try {
    return decoder.decode(await vscode.workspace.fs.readFile(uri));
  } catch {
    return undefined;
  }
}

function locKey(loc: vscode.Location): string {
  const r = loc.range;
  return `${loc.uri.fsPath}:${r.start.line}:${r.start.character}:${r.end.line}:${r.end.character}`;
}

async function findModuleUsers(
  sourceUri: vscode.Uri,
  folder: vscode.WorkspaceFolder,
  sourceDoc: vscode.TextDocument
): Promise<vscode.Location[]> {
  const sourcePath = sourceUri.fsPath;
  const sourceIsVue =
    sourceDoc.languageId === "vue" || sourcePath.toLowerCase().endsWith(".vue");
  const plan = buildScanPlan(sourcePath, folder.uri.fsPath, sourceDoc.getText(), sourceIsVue);

  const pattern = new vscode.RelativePattern(folder, "**/*.{vue,ts,mts,cts}");
  const uris = (await vscode.workspace.findFiles(pattern, FIND_EXCLUDE, FIND_LIMIT)).filter(
    (u) => u.fsPath !== sourcePath && isSupportedSourcePath(u.fsPath)
  );

  const merged = new Map<string, vscode.Location>();

  for (let i = 0; i < uris.length; i += READ_BATCH) {
    const batch = uris.slice(i, i + READ_BATCH);
    await Promise.all(
      batch.map(async (uri) => {
        const text = await readText(uri);
        if (!text || !mightMatch(text, plan.prefilter)) {
          return;
        }
        const fileIsVue = uri.fsPath.toLowerCase().endsWith(".vue");
        for (const range of scanText(text, plan, sourceIsVue, fileIsVue)) {
          const loc = new vscode.Location(uri, range);
          merged.set(locKey(loc), loc);
        }
      })
    );
  }

  return [...merged.values()].sort((a, b) => {
    const d = a.uri.fsPath.localeCompare(b.uri.fsPath);
    return d !== 0 ? d : a.range.start.compareTo(b.range.start);
  });
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("refus.findFileUsers", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        await vscode.window.showWarningMessage("No active editor.");
        return;
      }

      const { document } = editor;
      if (!isSupportedSourcePath(document.uri.fsPath)) {
        await vscode.window.showInformationMessage(
          "refus supports .vue and Nuxt-area .ts/.mts/.cts (composables, pages, server, plugins, …). See README."
        );
        return;
      }

      const folder = vscode.workspace.getWorkspaceFolder(document.uri);
      if (!folder) {
        await vscode.window.showWarningMessage(
          "refus: open a folder workspace — search does not work without one."
        );
        return;
      }

      const locations = await findModuleUsers(document.uri, folder, document);
      if (locations.length === 0) {
        await vscode.window.showInformationMessage(
          "refus: no matches (quoted import paths; in .vue also <Pascal> / kebab tags; in composables use* or a single export)."
        );
        return;
      }

      await vscode.commands.executeCommand(
        "editor.action.showReferences",
        document.uri,
        editor.selection.active,
        locations
      );
    })
  );
}

export function deactivate(): void {}
