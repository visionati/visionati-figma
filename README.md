# Visionati — Figma Plugin

AI-powered alt text, captions, and descriptions for Figma images. Select image layers (or scan the page), choose which fields to generate, preview the results, and write them as color-coded Figma annotations visible in both design mode and Dev Mode handoff.

## Features

- **Three field types:** Alt Text (green), Caption (blue), Description (violet) — each written as a separate color-coded annotation
- **7 AI models:** Gemini, OpenAI, Claude, Grok, Jina AI, LLaVA, BakLLaVA
- **160+ languages**
- **Custom prompts** that override field roles
- **Batch processing:** select multiple images or scan the entire page
- **Preview before apply:** review and edit generated text before writing annotations
- **Per-field control:** apply, edit, or discard individual fields independently
- **Figma Annotations API:** text is stored as first-party annotations with color-coded categories, visible in the design panel and Dev Mode

## Fields

Each field maps to a fixed Visionati role and gets its own annotation category:

| Field | Role | Category Color | Purpose |
|-------|------|----------------|---------|
| Alt Text | `alttext` | Green | Concise, WCAG-compliant descriptions |
| Caption | `caption` | Blue | Short display text |
| Description | `general` | Violet | Longer prose descriptions |

Select one or more fields per generation. Each selected field triggers a separate API call with its role. All fields for an image are written as separate annotations on the same node, organized by category.

## Prerequisites

- [Figma desktop app](https://www.figma.com/downloads/) (plugins require the desktop app for development)
- [Node.js](https://nodejs.org/) (for TypeScript compilation)
- A [Visionati API key](https://visionati.com) (requires credits)

## Setup

```
npm install
npm run build
```

This compiles `code.ts` → `code.js` via the TypeScript compiler.

## Load in Figma

1. Open Figma desktop app
2. Go to **Plugins → Development → Import plugin from manifest**
3. Select the `manifest.json` file from this directory
4. The plugin appears under **Plugins → Development → Visionati**

## Usage

1. **Configure:** Run the plugin, go to the **Settings** tab, enter your Visionati API key, choose your preferred AI model and language. Click **Save Settings**.
2. **Select fields:** On the **Generate** tab, check which fields you want: Alt Text, Caption, Description (at least one required).
3. **Select images:** Select one or more layers/frames containing images on the canvas.
4. **Generate:** Click **Selection** to process selected layers, or **Scan Page** to find all images on the page.
5. **Preview:** The **Results** tab shows generated text grouped by image, with color-coded field badges. Edit any description before applying.
6. **Apply:** Click **Apply** on individual fields, **Apply All Fields** on a single image, or **Apply All** for everything at once.

### Menu Commands

- **Generate for Selection** — process selected layers
- **Scan All Images on Page** — find and process all image nodes on the current page
- **Settings** — open the plugin panel to the settings tab

### Annotations

Text is written using Figma's Annotations API with annotation categories:

- Each field type gets its own color-coded category (created automatically on first use)
- Multiple annotations can exist on the same node (one per field)
- Applying a field replaces only that field's annotation, preserving others
- Visible when a node is selected in the design panel
- Visible in Dev Mode during developer handoff
- Does not mutate document structure (no component conversion)
- Existing annotations are skipped by default (enable "Include images with existing annotations" to overwrite)

## Development

Watch mode for development (recompiles on file changes):

```
npm run watch
```

After recompiling, close and reopen the plugin in Figma to pick up changes.

### Architecture

The plugin has two execution contexts:

- **Sandbox** (`code.ts` → `code.js`) — runs in Figma's plugin sandbox. Handles document access (node traversal, image export, annotation writing), API calls via sandbox `fetch`, parallel async polling, annotation category management, and settings storage via `clientStorage`. No DOM access.
- **UI** (`ui.html`) — runs in an iframe. Handles the settings panel, field selection, generate buttons, and multi-field results display. Communicates with the sandbox via `postMessage`.

### Key Files

| File | Description |
|------|-------------|
| `manifest.json` | Plugin configuration (menu, network access, relaunch buttons) |
| `code.ts` | TypeScript source for the sandbox (compiles to `code.js`) |
| `code.js` | Compiled output (gitignored) |
| `ui.html` | Plugin UI: settings, field selection, generate actions, results preview |
| `tsconfig.json` | TypeScript configuration |
| `package.json` | Dependencies and build scripts |

### Image Pipeline

1. Find nodes with image fills (`paint.type === "IMAGE"`)
2. Export as PNG via `node.exportAsync()` (capped at 2048px longest dimension)
3. Encode to base64 via `figma.base64Encode()`
4. For each selected field, batch POST to `api.visionati.com/api/fetch` with `file[]`, `file_name[]` (node IDs), and the field's role — all API calls submitted in parallel
5. Poll all `response_uri` endpoints concurrently (up to 30 attempts, 2s interval)
6. Match results back to nodes via `file_name`, grouped by field
7. Preview in UI with color-coded field badges, then write as `node.annotations` with category IDs on Apply

### PostMessage Protocol

**UI → Sandbox:**
- `{ type: 'generate', source: 'selection' | 'page', fields: FieldType[], overwrite?: boolean }`
- `{ type: 'apply-field', nodeId: string, field: FieldType, description: string }`
- `{ type: 'apply-node', nodeId: string, fields: [{ field, description }] }`
- `{ type: 'apply-all', nodes: [{ nodeId, fields: [{ field, description }] }] }`
- `{ type: 'discard-field', nodeId: string, field: FieldType }`
- `{ type: 'discard-node', nodeId: string }`
- `{ type: 'save-settings', settings: { apiKey, backend, language, prompt } }`
- `{ type: 'load-settings' }`

**Sandbox → UI:**
- `{ type: 'settings', settings: {...} }`
- `{ type: 'auto-generate', source: string }`
- `{ type: 'categories', categories: {...} }`
- `{ type: 'status', message: string }`
- `{ type: 'progress', current: number, total: number, phase: string }`
- `{ type: 'results', results: [...], fields: FieldType[] }`
- `{ type: 'error', message: string }`
- `{ type: 'field-applied', nodeId: string, field: FieldType }`
- `{ type: 'field-discarded', nodeId: string, field: FieldType }`
- `{ type: 'node-discarded', nodeId: string }`
- `{ type: 'all-applied', applied: number, failed: number }`

## Credits

Each image processed costs credits per field based on the selected AI model. Each selected field (Alt Text, Caption, Description) is a separate API call. See [visionati.com](https://visionati.com) for current pricing.

## License

Proprietary. All rights reserved.