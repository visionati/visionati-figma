# Visionati

![Visionati](.figma-community/cover-1920x960.png)

AI-powered alt text, captions, and descriptions for Figma images.

Select image layers (or scan the entire page), choose which fields to generate, preview the results, and apply them as color-coded [Figma annotations](https://www.figma.com/plugin-docs/api/Annotation/) visible in both design mode and Dev Mode handoff.

Powered by the [Visionati API](https://visionati.com). Choose from AI models by Anthropic, Google, OpenAI, xAI, and others to generate descriptions tuned to your needs.

## Features

- **Three Field Types:** Alt Text (green), Caption (blue), Description (violet). Each written as a separate color-coded annotation on the image node.
- **Preview Before Apply:** Review and edit generated text before writing anything to the document. Apply, edit, or discard individual fields independently.
- **Batch Processing:** Select multiple images or scan the entire page. Images are processed in parallel batches of 10.
- **7 AI Models:** Gemini, OpenAI, Claude, Grok, Jina AI, LLaVA, BakLLaVA.
- **160+ Languages:** Generate descriptions in any supported language.
- **Custom Prompts:** Write your own instructions to override the default field roles.
- **Annotation Management:** Select any node to see its existing annotations in the plugin. Edit text inline, remove individual annotations, or clear them all.
- **Dev Mode Ready:** Annotations are visible during developer handoff with color-coded categories, so developers know which text is alt text, which is a caption, and which is a description.

## Fields

| Field | Color | Purpose |
|-------|-------|---------|
| Alt Text | Green | Concise, WCAG-compliant descriptions for accessibility |
| Caption | Blue | Short display text for captions and labels |
| Description | Violet | Longer prose descriptions |

Select one or more fields per generation. Each field triggers a separate API call with the appropriate AI role.

## Prerequisites

- [Figma desktop app](https://www.figma.com/downloads/) (required for loading the plugin in development; published plugins work in the browser too)
- A [Visionati API key](https://api.visionati.com/signup) (requires credits)

## Installation

1. Download or clone this repository
2. Open the Figma desktop app
3. Go to **Plugins → Development → Import plugin from manifest**
4. Select the `manifest.json` file from this directory
5. The plugin appears under **Plugins → Development → Visionati**

No build step needed. `code.js` is committed and ready to use.

## Usage

### First Run

1. Open the plugin from the **Plugins** menu
2. The **Settings** tab opens automatically with a welcome banner
3. Enter your Visionati API key
4. Choose your preferred AI model and language
5. Click **Save Settings** (switches to the Generate tab)

### Generating Descriptions

1. On the **Generate** tab, toggle which fields you want: Alt Text, Caption, Description (at least one required)
2. Select one or more layers or frames containing images on the canvas
3. Click **Selection** to process selected layers, or **Scan Page** to find and process all images on the current page
4. Generated text appears grouped by image with color-coded field badges and a thumbnail preview
5. Click the text to edit any description before applying

### Applying Results

- **Apply** on a single field to write just that annotation
- **Apply All** on a node card to write all fields for that image
- **Apply All** at the bottom to write everything at once
- **Discard** to throw away a field you don't want

### Managing Existing Annotations

Select any node on the canvas to see its annotations in the **Current Annotations** section:

- **Edit inline:** click the annotation text to open an editor
- **Remove one:** click the × button to delete a single annotation
- **Remove All:** clear every annotation from a node

### Menu Commands

| Command | Action |
|---------|--------|
| **Open Visionati** | Open the plugin panel |
| **Generate for Selection** | Process selected layers immediately |
| **Scan All Images on Page** | Find and process every image on the current page |
| **Settings** | Open the Settings tab |

## How Annotations Work

Text is written using Figma's [Annotations API](https://www.figma.com/plugin-docs/api/Annotation/) with [annotation categories](https://www.figma.com/plugin-docs/api/AnnotationCategory/):

- Each field type gets its own color-coded category (created automatically on first use)
- Multiple annotations can coexist on the same node (one per field)
- Applying a field replaces only that field's annotation, preserving others
- Visible in the design panel when a node is selected
- Visible in Dev Mode during developer handoff
- No document structure changes (no component conversion)
- Works on older Figma versions without color coding (graceful degradation)

## Credits

Each image processed costs credits per field based on the selected AI model. Each selected field is a separate API call. See [visionati.com](https://visionati.com) for current pricing.

## Documentation

Full documentation at [docs.visionati.com/figma-plugin/](https://docs.visionati.com/figma-plugin/).

## Development

To modify the plugin, edit `code.ts` and recompile:

```bash
npm install
npm run build        # compile code.ts → code.js
npm run watch        # watch mode (recompiles on save)
```

After recompiling, close and reopen the plugin in Figma to pick up changes.

See [DEVELOPMENT.md](DEVELOPMENT.md) for architecture details, the PostMessage protocol, image pipeline internals, annotation system, and Figma API reference links.

## License

MIT. See [LICENSE](LICENSE).