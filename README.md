# Refus

VS Code / Cursor extension for Nuxt + Vue. Right‑click → **Refus** and it tries to show who’s using this file (imports, template tags, `use*` from composables, that sort of thing). Not the language server; details below in two languages.

![Refus — screen recording](https://raw.githubusercontent.com/Fernir/refus/main/docs/refus-screen.gif)

Licensed under the MIT License — see `LICENSE`. Publishing to the VS Marketplace: **PUBLISHING.md**.

---

## English

Right‑click in the editor → **Refus** (same name in the command palette). The question it chases: **who actually touches this file** — imports that mention the path, `<Component>` tags in templates, and for composables usually `useWhatever` sprinkled around.

This is not the TypeScript “find all references” pipeline. More like smart grep with a few Nuxt‑shaped assumptions, and ripgrep runs first so we don’t walk every file by hand. `.d.ts` and paths under `node_modules/nuxt` / `node_modules/@nuxt/` are skipped on purpose; they rarely help here.

Open the repo as a **folder workspace**. A lone file without a project root won’t work — paths need something to be relative to.

**What you get**

For `.vue` it looks at quoted import paths and at tags like `<FooBar>` / `<foo-bar>` derived from the filename. If the file is `Something/index.vue`, it leans on the **folder name** — same mental model as when you import a folder in Nuxt.

For `.ts` / `.mts` / `.cts` in the usual Nuxt places (`composables`, `pages`, `server`, `plugins`, `components`, `app`, etc.) it does the path thing and also hunts for exported **`use…`** names (or one lonely export if there’s nothing `use*`-shaped).

**What it deliberately ignores**

No React stack: no `.tsx`, `.jsx`, random `.js` pipelines. If your TypeScript lives in some hand‑rolled `src/lib` that isn’t under the paths above, Refus won’t care — that was on purpose so this thing stays small and Nuxt‑shaped.

**Hacking on it**

`npm install`, `npm run compile`, then F5 / “Run Extension” from this repo if you want to poke it.

Command id: `refus.findFileUsers`.

---

## По-русски

Надоело смотреть на пустой “find references” по компоненту, когда по факту все импорты и теги в шаблонах живут своей жизнью. Refus — это попытка собрать **куда этот файл реально торчит**: строки `import … '…/path…'`, в `.vue` ещё и `<ИмяКакВФайле>`, в компосаблах чаще всего просто **`useFoo`** по проекту.

Курсор не нужен — смотрится текущий файл целиком. Для `index.vue` в названии участвует **папка над ним**, логика как у нормального Nuxt‑компонента в папке.

Поиск грубоватый (текст + эвристики), зато не зависит от Volar. Сначала узкий прогон через ripgrep, потом чуть более придирчивый разбор строк. `.d.ts` и внутренности nuxt в `node_modules` выкидываются — там обычно только мусор для этой задачи.

Работает только если открыт **workspace папкой**. И только для **vue + типичного nuxt‑дерева**: `.vue` где угодно в проекте, а `.ts`/`.mts`/`.cts` — если путь похож на `composables/`, `pages/`, `server/`, `plugins/`, `components/`, `app/` и т.д., плюс `nuxt.config` / `app.config`. React и случайный `tools/foo.ts` в корне — мимо, так задумано.

Сборка: `npm install`, `npm run compile`, дальше как обычно Run Extension.

Команда: `refus.findFileUsers`, в меню называется **Refus**.
