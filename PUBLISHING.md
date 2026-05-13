# Publishing Refus to the VS Marketplace

Publisher: [marketplace.visualstudio.com/manage/publishers/Nikolay](https://marketplace.visualstudio.com/manage/publishers/Nikolay).

Docs: [Publishing Extensions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension).

## One-time setup

0. **GitHub** — README images on the Marketplace are resolved via `repository` in `package.json`. Source of truth: **`https://github.com/Fernir/refus`**. Keep `docs/` in the repo so the README GIF resolves on the listing.

1. **Personal Access Token (PAT)**  
   Azure DevOps → Personal access tokens → New token → scope **Marketplace → Manage** (see Microsoft’s guide above).

2. **Login** (pick one)

   ```bash
   npm install
   npx @vscode/vsce login Nikolay
   ```

   Or non-interactive / CI: create a PAT with scope **Marketplace (Manage)**, then:

   ```bash
   export VSCE_PAT="your_token_here"
   npm run publish
   ```

   The publisher id must match `"publisher": "Nikolay"` in `package.json`.

   If you see **`TF400813`** or **Personal Access Token verification has failed**, the saved token is missing, expired, or lacks **Marketplace → Manage** — create a new PAT and run `vsce login` again or set a fresh `VSCE_PAT`.

## Each release

1. Bump `"version"` in `package.json` (semver; must increase for every upload).

2. Build and pack:

   ```bash
   npm run compile
   npm run package
   ```

   (`vscode:prepublish` runs `compile` during `package` / `publish`.)

3. Publish:

   ```bash
   npm run publish
   ```

   Or upload the generated `refus-*.vsix` on the publisher page (**New extension** / **Update**).

## Before the first listing

- Marketplace extension id: **`Nikolay.refus`**. If the name `refus` is taken globally, change `"name"` in `package.json` (lowercase, no spaces).
- `README.md`, `LICENSE`, `PUBLISHING.md`, and `docs/` are packaged; `src/` is not (only `out/`).
- **Ripgrep**: `postinstall` and `vscode:prepublish` run `scripts/ensure-all-ripgrep-platforms.cjs`, which installs every `@vscode/ripgrep-*` platform binary (`npm install --force`) so the published VSIX works on Windows, Linux, and macOS (not only the machine you packed on). The `.vsix` is larger (~25 MB) because it ships every `rg` build.
- Optional: add **`icon.png`** (128×128) at the repo root and `"icon": "icon.png"` in `package.json`.

---

## Кратко

1. Публичный GitHub **`Fernir/refus`** — URL в `package.json` уже на него; в репозитории должна быть папка **`docs/`**.  
2. PAT Azure DevOps — право **Marketplace (Manage)**.  
3. Поднять `version` в `package.json` при каждом релизе (сейчас **0.1.1**).  
4. `npx @vscode/vsce login Nikolay` или `export VSCE_PAT=…` и `npm run publish`. Если **`TF400813`** — токен протух или без **Marketplace → Manage**, выпусти новый PAT.  
5. Панель издателя: [Nikolay](https://marketplace.visualstudio.com/manage/publishers/Nikolay).  
6. Перед пакетом/паблишем `vscode:prepublish` подтягивает **все** бинарники `@vscode/ripgrep-*` (не только текущую ОС), иначе у пользователей на других платформах расширение упадёт при поиске.
