# Development Guide

Technical reference for developing and maintaining the Visionati Figma plugin.

## Architecture

The plugin has two execution contexts that communicate via `postMessage`:

- **Sandbox** (`code.ts` → `code.js`) — runs in Figma's plugin sandbox. Handles document access (node traversal, image export, annotation writing), API calls via sandbox `fetch`, parallel async polling, annotation category management, and settings storage via `clientStorage`. No DOM access.
- **UI** (`ui.html`) — runs in an iframe. Handles the settings panel, field selection, generate buttons, results display, and annotation read-back. Communicates with the sandbox via `postMessage`.

## Building

Edit `code.ts` and recompile:

```bash
npm install
npm run build
```

Watch mode for development (recompiles on file changes):

```bash
npm run watch
```

After recompiling, close and reopen the plugin in Figma to pick up changes.

`code.js` is committed so users can import the plugin without building. Always rebuild after editing `code.ts`.

## Debug Logging

Set `const DEBUG = true` at the top of `code.ts` to enable verbose console logging (poll attempts, asset matching, response parsing). Set it back to `false` before publishing. `console.warn` and `console.error` always fire regardless of this flag.

## Key Files

| File | Description |
|------|-------------|
| `manifest.json` | Plugin configuration (menu commands, network access, relaunch buttons) |
| `code.ts` | TypeScript source for the sandbox (compiles to `code.js`) |
| `code.js` | Compiled output (committed, referenced by manifest) |
| `ui.html` | Plugin UI: settings, field selection, generate actions, results preview |
| `tsconfig.json` | TypeScript configuration (`target: "es6"`, `lib: ["es2020"]` for `Promise.allSettled`) |
| `package.json` | Dependencies: `@figma/plugin-typings` (^1.123.0), `typescript` (^5.3) |
| `.figma-community/` | Icons, cover image, cover generator, and publishing checklist |

## Image Pipeline

1. Find nodes with image fills (`paint.type === "IMAGE"` with `paint.visible !== false`)
2. Export as PNG via `node.exportAsync()` (capped at `MAX_EXPORT_DIMENSION` = 2048px on longest dimension)
3. Export a 48px thumbnail per node for UI display via `exportNodeThumbnail()`
4. Encode to base64 in sandbox via `figma.base64Encode()`
5. Chunk into batches of `BATCH_SIZE` (10) images per API call
6. For each selected field × each chunk, POST to `api.visionati.com/api/fetch` with `file[]`, `file_name[]` (node IDs), and the field's role — all calls submitted in parallel
7. Each call returns `{ response_uri: "..." }` — poll all URIs concurrently via `Promise.allSettled` (up to 30 attempts, 2s interval)
8. Merge chunk responses per field, match results back to nodes by extracting basename from `asset.name` (the API transforms `file_name` values into server temp paths; `matchAssetToNodeId()` reverses the colon-to-underscore substitution)
9. Detect fields that returned no descriptions despite API "success" — surface as warnings
10. Send results (with thumbnails) to UI via `figma.ui.postMessage()` for preview
11. On Apply, write as `node.annotations` with category IDs, preserving other annotations

## Annotation System

Text is stored using Figma's Annotations API with annotation categories:

| Field | Role | Category Color | Annotation Prefix |
|-------|------|----------------|-------------------|
| `alt_text` | `alttext` | green | `**ALT TEXT**` |
| `caption` | `caption` | blue | `**CAPTION**` |
| `description` | `general` | violet | `**DESCRIPTION**` |

Defined in `FIELD_CONFIGS` in `code.ts`.

### Category Management

- Categories are created via `figma.annotations.addAnnotationCategoryAsync()` on first use and cached for the session
- Each annotation includes `categoryId` for color coding and `properties: [{ type: 'fills' }]` to pin to the fills property
- Applying a field replaces only that field's annotation (matched by `categoryId`), preserving annotations from other fields and manually-added annotations

### Graceful Degradation

`figma.annotations` may be `undefined` on older Figma versions. When unavailable:
- `ensureCategoryForField` returns `undefined`
- Annotations are written without `categoryId` (no color coding in Dev Mode)
- Matching falls back to bold prefix text (`**ALT TEXT**`, etc.) instead of category ID
- The plugin still works fully: generate, preview, apply, edit, remove

### Sanitization

When reading existing annotations from a node and writing them back (to preserve non-Visionati annotations), each annotation is passed through `sanitizeAnnotation()` which ensures only `label` OR `labelMarkdown` is set, never both. Figma's validation rejects annotations with both fields set.

## Async Node Access

All `figma.getNodeById()` calls must use `figma.getNodeByIdAsync()` because the manifest declares `documentAccess: "dynamic-page"`.

## API Response Structure

The Visionati API wraps results under `response.all.assets[]`. Each asset has:
- `name` — server temp path (not the original `file_name`)
- `descriptions[].description` (not `.text`) with `descriptions[].source` (not `.backend`)
- `credits` — remaining balance after deduction

Async polling responses use `status: "queued"` (job in Sidekiq queue) or `status: "processing"` (worker running) to indicate the job is not done. Both are treated as "keep polling."

## Results Caching and Selection

- **Incremental merging:** generating new fields does not clear previous results. Same node + same field replaces old result; same node + different field adds alongside; new nodes are appended.
- **Selection caching:** when the user changes selection, results are stashed in a cache keyed by sorted node IDs. Selecting the same nodes again restores cached results (including applied state). Uses `JSON.parse(JSON.stringify())` for deep-copying.
- **Selection-aware clearing:** on `selectionchange`, the sandbox sends `{ type: 'selection-changed', nodeIds: [...] }` to the UI. The UI stashes current results, checks cache, and either restores or clears.

## Editing State Preservation

Both `renderResults()` and `renderSelectionAnnotations()` preserve in-progress edits across re-renders. Before replacing `innerHTML`, editing entries (`.editing` class) and their textarea values are captured. After rendering, they're restored. Applied entries (`.applied` class) are skipped during restore to avoid conflicts.

## Startup and Cleanup Hardening

- `figma.on('run', ...)` is wrapped in try/catch. On failure, attempts to show the UI with an error message; if that also fails, calls `figma.closePlugin()`.
- `load-settings` and `save-settings` handlers have try/catch. On load failure, falls back to `DEFAULT_SETTINGS`.
- The `selectionchange` handler wraps `sendSelectionAnnotations()` in `.catch()` to prevent unhandled rejections.

## PostMessage Protocol

### UI → Sandbox

| Message | Description |
|---------|-------------|
| `{ type: 'generate', source: 'selection' \| 'page', fields: FieldType[] }` | Start generation |
| `{ type: 'apply-field', nodeId, field, description }` | Apply one field to a node |
| `{ type: 'apply-node', nodeId, fields: [{ field, description }] }` | Apply all fields to a node |
| `{ type: 'apply-all', nodes: [{ nodeId, fields: [{ field, description }] }] }` | Apply everything |
| `{ type: 'discard-field', nodeId, field }` | Discard one field result |
| `{ type: 'discard-node', nodeId }` | Discard all results for a node |
| `{ type: 'remove-annotation', nodeId, categoryLabel }` | Remove an existing annotation |
| `{ type: 'remove-all-annotations', nodeId }` | Remove all annotations from a node |
| `{ type: 'edit-annotation', nodeId, categoryLabel, newText }` | Edit an existing annotation |
| `{ type: 'save-settings', settings: { apiKey, backend, language, prompt } }` | Save settings |
| `{ type: 'load-settings' }` | Load settings |

### Sandbox → UI

| Message | Description |
|---------|-------------|
| `{ type: 'settings', settings: {...} }` | Settings loaded from `clientStorage` |
| `{ type: 'switch-tab', tab: 'settings' }` | Open Settings tab (via menu command) |
| `{ type: 'auto-generate', source: 'selection' \| 'all-images' }` | Trigger generation (via menu command) |
| `{ type: 'selection-changed', nodeIds: string[] }` | Selection changed (not sent on post-apply refresh) |
| `{ type: 'selection-annotations', nodes: [...] }` | Current annotations for selected nodes |
| `{ type: 'status', message }` | Status bar text |
| `{ type: 'progress', current, total, phase }` | Progress update. Phases: `'exporting'`, `'polling'` |
| `{ type: 'results', results, totalImages, fields, fieldErrors, credits? }` | Generation results with thumbnails |
| `{ type: 'error', message?, messages? }` | Error(s). `messages` array renders each as a separate line |
| `{ type: 'field-applied', nodeId, field }` | Confirmation: field written to annotation |
| `{ type: 'field-discarded', nodeId, field }` | Confirmation: field result discarded |
| `{ type: 'node-discarded', nodeId }` | Confirmation: all results for node discarded |
| `{ type: 'all-applied', applied, failed }` | Confirmation: bulk apply complete |

## Manifest Requirements

- `editorType: ["figma"]` — design mode (annotations still visible in Dev Mode)
- `networkAccess.allowedDomains: ["https://api.visionati.com"]` — required for sandbox `fetch` (must include `https://` prefix)
- `documentAccess: "dynamic-page"` (required for all new plugins)
- `relaunchButtons` — `{ command: "open", name: "Generate with Visionati", multipleSelection: true }`
- No `enableProposedApi` needed (annotations API is stable in `@figma/plugin-typings@1.123.0`)
- No `capabilities: ["inspect"]` needed (that's for Dev Mode plugins)

## Figma API Reference

- [Plugin API introduction](https://www.figma.com/plugin-docs/)
- [figma global object](https://www.figma.com/plugin-docs/api/figma/) (showUI, clientStorage, base64Encode, fetch)
- [Working with images](https://www.figma.com/plugin-docs/working-with-images/)
- [exportAsync](https://www.figma.com/plugin-docs/api/properties/nodes-exportasync/)
- [FrameNode](https://www.figma.com/plugin-docs/api/FrameNode/) (annotations, fills, findAll)
- [Annotation type](https://www.figma.com/plugin-docs/api/Annotation/)
- [AnnotationProperty](https://www.figma.com/plugin-docs/api/AnnotationProperty/)
- [AnnotationCategory](https://www.figma.com/plugin-docs/api/AnnotationCategory/)
- [figma.annotations](https://www.figma.com/plugin-docs/api/figma-annotations/) (category management)
- [Editing properties](https://www.figma.com/plugin-docs/editing-properties/) (clone and set arrays/objects)
- [Plugin manifest](https://www.figma.com/plugin-docs/manifest/)
- [setRelaunchData](https://www.figma.com/plugin-docs/api/properties/nodes-setrelaunchdata/)
- [Official plugin samples](https://github.com/figma/plugin-samples)
- [Annotations sample](https://github.com/figma/plugin-samples/tree/main/annotations) (alt text pattern)