# Figma Community Listing Assets

Assets for publishing the Visionati plugin to the [Figma Community](https://www.figma.com/community) plugin directory.

## Icons

| File | Size | Status |
|------|------|--------|
| `icon-192x192.png` | 192×192 | ✅ Ready (from visionati.com android-chrome) |
| `icon-512x512.png` | 512×512 | ✅ Ready (from visionati.com android-chrome) |

## Cover Image

| File | Size | Status |
|------|------|--------|
| `cover-1920x1080.png` | 1920×1080 | ✅ Ready (dark slate background, swirl logo, orange SVG wordmark, field pills, tagline) |
| `cover-generator.html` | — | ✅ HTML generator for the cover image (edit and re-screenshot to update) |

## Screenshots

All screenshots captured from Figma desktop on Windows VM (no official Linux client). Cropped to the Figma content area with the floating plugin panel. Source images: Hi'ilawe Falls (Hawaii) and tropical food spread from Unsplash.

| File | What it Shows | Status |
|------|--------------|--------|
| `screenshot-1.png` | **First-run / Settings**: Settings tab with orange welcome banner, empty API key field, AI model (Gemini), language (English), custom prompt textarea | ✅ Ready |
| `screenshot-2.png` | **Generate tab with results**: Two images on canvas (waterfall + food), color-coded field results (green Alt Text, blue Caption, violet Description) with thumbnails, Apply/Discard buttons, "2 images · 6 fields" summary. **Hero shot — also used on marketing site, docs, and OG image.** | ✅ Ready |
| `screenshot-3.png` | **Current Annotations**: Selected waterfall node showing applied annotations (Alt Text, Caption, Description) with × remove buttons and Remove All option | ✅ Ready |

## Publishing Checklist

- [x] Icons uploaded (192×192 and 512×512)
- [x] Cover image created and uploaded (3840×1920 retina, from cover-generator.html)
- [x] All 3 screenshots captured
- [ ] Plugin name: "Visionati"
- [ ] Tagline: "AI-powered alt text, captions, and descriptions for your designs. 7 AI models, 160+ languages, preview before apply."
- [ ] Description written (adapt from README.md)
- [ ] Categories: Accessibility, Content, Development
- [ ] Tags: alt text, accessibility, captions, descriptions, AI, annotations
- [ ] Support link: https://docs.visionati.com/figma-plugin/
- [ ] Creator: Visionati
- [ ] Test plugin loads correctly from Community install (not just dev manifest)

## Figma Community Requirements

- Plugin must pass Figma's automated review
- Network access declared in manifest (`api.visionati.com`) is reviewed
- No hardcoded API keys or secrets
- UI must render correctly at the declared panel size
- Plugin must not crash on empty selection or missing data