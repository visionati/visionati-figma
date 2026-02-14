"use strict";
/// <reference types="@figma/plugin-typings" />
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
// ============================================================================
// Constants
// ============================================================================
const DEBUG = false;
const API_BASE_URL = 'https://api.visionati.com';
const POLL_INTERVAL_MS = 2000;
const MAX_POLL_ATTEMPTS = 30;
const MAX_EXPORT_DIMENSION = 2048;
const BATCH_SIZE = 10;
const DEFAULT_SETTINGS = {
    apiKey: '',
    backend: 'gemini',
    language: 'English',
    prompt: '',
};
const SETTINGS_KEYS = [
    'apiKey',
    'backend',
    'language',
    'prompt',
];
const FIELD_CONFIGS = {
    alt_text: {
        role: 'alttext',
        categoryLabel: 'Alt Text',
        categoryColor: 'green',
        annotationPrefix: 'ALT TEXT',
    },
    caption: {
        role: 'caption',
        categoryLabel: 'Caption',
        categoryColor: 'blue',
        annotationPrefix: 'CAPTION',
    },
    description: {
        role: 'general',
        categoryLabel: 'Description',
        categoryColor: 'violet',
        annotationPrefix: 'DESCRIPTION',
    },
};
// Category IDs cached for the session
const categoryIdCache = new Map();
// Track selectionchange handler to avoid accumulating listeners
let selectionChangeHandler = null;
// ============================================================================
// Node Detection
// ============================================================================
/**
 * Check if a node has at least one visible image fill.
 * Ignores figma.mixed fill values.
 */
function nodeHasImageFill(node) {
    return ('fills' in node &&
        Array.isArray(node.fills) &&
        node.fills.some((paint) => paint.type === 'IMAGE' && paint.visible !== false));
}
/**
 * Recursively find all nodes with image fills from an array of nodes.
 * Traverses descendants using findAll when available.
 */
function getImageNodes(nodes) {
    const imageNodes = [];
    const seen = new Set();
    for (const node of nodes) {
        if (nodeHasImageFill(node) && !seen.has(node.id)) {
            imageNodes.push(node);
            seen.add(node.id);
        }
        // Traverse descendants
        if ('findAll' in node) {
            const descendants = node.findAll((descendant) => nodeHasImageFill(descendant));
            for (const desc of descendants) {
                if (!seen.has(desc.id)) {
                    imageNodes.push(desc);
                    seen.add(desc.id);
                }
            }
        }
    }
    return imageNodes;
}
// ============================================================================
// Image Export
// ============================================================================
/**
 * Export a node as PNG bytes, capping the longest dimension at MAX_EXPORT_DIMENSION.
 * LLMs don't benefit from higher resolution, and capping keeps payloads manageable
 * for large batches (e.g., 30+ images per API call).
 */
function exportNodeAsPng(node) {
    return __awaiter(this, void 0, void 0, function* () {
        // Cap the longest dimension to avoid huge payloads
        const maxDim = Math.max(node.width, node.height);
        if (maxDim > MAX_EXPORT_DIMENSION) {
            const constraint = node.width >= node.height
                ? { type: 'WIDTH', value: MAX_EXPORT_DIMENSION }
                : { type: 'HEIGHT', value: MAX_EXPORT_DIMENSION };
            return yield node.exportAsync({ format: 'PNG', constraint });
        }
        return yield node.exportAsync({ format: 'PNG' });
    });
}
/**
 * Export a small thumbnail of a node for UI preview.
 * Returns a base64 data URL string (data:image/png;base64,...).
 */
function exportNodeThumbnail(node) {
    return __awaiter(this, void 0, void 0, function* () {
        const bytes = yield node.exportAsync({
            format: 'PNG',
            constraint: { type: 'WIDTH', value: 48 },
        });
        const base64 = figma.base64Encode(bytes);
        return `data:image/png;base64,${base64}`;
    });
}
// ============================================================================
// Settings Storage
// ============================================================================
/**
 * Load all settings from clientStorage.
 */
function loadSettings() {
    return __awaiter(this, void 0, void 0, function* () {
        const settings = Object.assign({}, DEFAULT_SETTINGS);
        for (const key of SETTINGS_KEYS) {
            const value = yield figma.clientStorage.getAsync(key);
            if (value !== undefined && value !== null) {
                settings[key] = value;
            }
        }
        return settings;
    });
}
/**
 * Save all settings to clientStorage.
 */
function saveSettings(settings) {
    return __awaiter(this, void 0, void 0, function* () {
        for (const key of SETTINGS_KEYS) {
            yield figma.clientStorage.setAsync(key, settings[key]);
        }
    });
}
// ============================================================================
// Annotation Categories
// ============================================================================
/**
 * Find or create an annotation category for the given field.
 * Caches the category ID for the session to avoid repeated lookups.
 */
function ensureCategoryForField(field) {
    return __awaiter(this, void 0, void 0, function* () {
        // figma.annotations may be undefined on older Figma versions
        if (!figma.annotations) {
            return undefined;
        }
        // Check cache first
        const cached = categoryIdCache.get(field);
        if (cached) {
            // Verify it still exists (user might have deleted it)
            const existing = yield figma.annotations.getAnnotationCategoryByIdAsync(cached);
            if (existing) {
                return cached;
            }
            categoryIdCache.delete(field);
        }
        const config = FIELD_CONFIGS[field];
        // Search existing categories by label
        const categories = yield figma.annotations.getAnnotationCategoriesAsync();
        for (const cat of categories) {
            if (cat.label === config.categoryLabel) {
                categoryIdCache.set(field, cat.id);
                return cat.id;
            }
        }
        // Create new category
        const newCategory = yield figma.annotations.addAnnotationCategoryAsync({
            label: config.categoryLabel,
            color: config.categoryColor,
        });
        categoryIdCache.set(field, newCategory.id);
        return newCategory.id;
    });
}
/**
 * Ensure categories exist for all requested fields.
 * Returns a map of field → categoryId (value is undefined when annotations API is unavailable).
 */
function ensureCategories(fields) {
    return __awaiter(this, void 0, void 0, function* () {
        const result = new Map();
        for (const field of fields) {
            const id = yield ensureCategoryForField(field);
            result.set(field, id);
        }
        return result;
    });
}
// ============================================================================
// Visionati API
// ============================================================================
/**
 * Send images to the Visionati API as a batched request with a specific role.
 * Returns the response_uri for async polling, or results if sync.
 */
function callVisionatiApi(apiKey, base64Images, fileNames, settings, role) {
    return __awaiter(this, void 0, void 0, function* () {
        const body = {
            file: base64Images,
            file_name: fileNames,
            role: role,
            backend: [settings.backend],
            language: settings.language,
            feature: ['descriptions'],
        };
        // Custom prompt overrides role
        if (settings.prompt && settings.prompt.trim() !== '') {
            body.prompt = settings.prompt.trim();
        }
        const response = yield fetch(`${API_BASE_URL}/api/fetch`, {
            method: 'POST',
            headers: {
                'X-API-Key': `Token ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
        });
        if (!response.ok) {
            const text = yield response.text();
            let errorMessage;
            try {
                const errorJson = JSON.parse(text);
                errorMessage = errorJson.error || errorJson.message || `API error (${response.status})`;
            }
            catch (_a) {
                errorMessage = `API error (${response.status}): ${text.substring(0, 200)}`;
            }
            throw new Error(errorMessage);
        }
        return yield response.json();
    });
}
/**
 * Poll a single response_uri until results are ready.
 */
function pollSingleUri(apiKey, responseUri, fieldLabel, onProgress) {
    return __awaiter(this, void 0, void 0, function* () {
        for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
            if (attempt > 0) {
                yield sleep(POLL_INTERVAL_MS);
            }
            onProgress(attempt + 1);
            const response = yield fetch(responseUri, {
                method: 'GET',
                headers: {
                    'X-API-Key': `Token ${apiKey}`,
                },
            });
            if (!response.ok) {
                const text = yield response.text();
                throw new Error(`Polling error for ${fieldLabel} (${response.status}): ${text.substring(0, 200)}`);
            }
            const data = yield response.json();
            if (DEBUG)
                console.log(`[Visionati] Poll ${fieldLabel} attempt ${attempt + 1}: status="${data.status}", has all=${!!data.all}, has response_uri=${!!data.response_uri}`);
            // Results ready: has assets (possibly with backend errors too)
            if (data.all && data.all.assets && data.all.assets.length > 0) {
                if (DEBUG)
                    console.log(`[Visionati] Poll ${fieldLabel} DONE: ${data.all.assets.length} asset(s)`);
                return data;
            }
            // Still processing or queued (job not yet picked up by Sidekiq)
            if (data.status === 'processing' || data.status === 'queued' || data.response_uri) {
                if (DEBUG)
                    console.log(`[Visionati] Poll ${fieldLabel} still ${data.status || 'waiting'}, continuing...`);
                continue;
            }
            // Got an `all` with errors but no assets — backend failures
            if (data.all && data.all.errors && data.all.errors.length > 0) {
                throw new Error(`${fieldLabel}: ${data.all.errors.join('; ')}`);
            }
            // Completed but no results (all backends failed silently or empty response)
            if (data.all && data.all.assets && data.all.assets.length === 0) {
                console.warn(`[Visionati] Poll ${fieldLabel} completed with empty assets:`, JSON.stringify(data).substring(0, 500));
                throw new Error(`${fieldLabel}: No results returned. The AI backend may have timed out. Please try again.`);
            }
            // Truly unexpected — include response data for diagnostics
            const unexpectedDetail = data.error || data.message || '';
            const responseSnippet = JSON.stringify(data).substring(0, 200);
            console.warn(`[Visionati] Unexpected poll response for ${fieldLabel}:`, JSON.stringify(data).substring(0, 500));
            if (unexpectedDetail) {
                throw new Error(`${fieldLabel}: ${unexpectedDetail}`);
            }
            throw new Error(`${fieldLabel}: Unexpected API response: ${responseSnippet}`);
        }
        throw new Error(`Timed out waiting for ${fieldLabel} results. Please try again.`);
    });
}
/**
 * Submit API calls for multiple fields in parallel, chunking images into
 * batches of BATCH_SIZE per call. All field×chunk combinations are submitted
 * in parallel, polled concurrently, and results merged back per field.
 *
 * For 32 images × 3 fields with BATCH_SIZE=10:
 *   4 batches × 3 fields = 12 API calls, all in parallel.
 */
function submitAndPollAllFields(apiKey, base64Images, fileNames, settings, fields) {
    return __awaiter(this, void 0, void 0, function* () {
        const responses = new Map();
        const errors = [];
        // Chunk images into batches
        const chunks = [];
        for (let i = 0; i < base64Images.length; i += BATCH_SIZE) {
            chunks.push({
                images: base64Images.slice(i, i + BATCH_SIZE),
                names: fileNames.slice(i, i + BATCH_SIZE),
            });
        }
        const totalImages = base64Images.length;
        const fieldLabels = fields.map(f => FIELD_CONFIGS[f].categoryLabel).join(', ');
        sendToUI({
            type: 'status',
            message: `Processing ${totalImages} image${totalImages !== 1 ? 's' : ''} (${fieldLabels})...`,
        });
        const submissions = [];
        for (const field of fields) {
            const config = FIELD_CONFIGS[field];
            for (let ci = 0; ci < chunks.length; ci++) {
                const chunk = chunks[ci];
                const promise = callVisionatiApi(apiKey, chunk.images, chunk.names, settings, config.role);
                submissions.push({ field, chunkIndex: ci, promise });
            }
        }
        // Await all submissions, collecting sync results and async polling URIs
        const needsPolling = [];
        const chunkResponses = [];
        for (const sub of submissions) {
            try {
                const response = yield sub.promise;
                const label = FIELD_CONFIGS[sub.field].categoryLabel;
                const chunkLabel = chunks.length > 1 ? ` (batch ${sub.chunkIndex + 1})` : '';
                if (DEBUG)
                    console.log(`[Visionati] Submission ${label}${chunkLabel}: status="${response.status}", has all=${!!response.all}, has response_uri=${!!response.response_uri}`);
                if (response.all && response.all.assets && response.all.assets.length > 0) {
                    // Got sync results immediately
                    chunkResponses.push({ field: sub.field, chunkIndex: sub.chunkIndex, response });
                }
                else if (response.response_uri) {
                    // Needs async polling
                    needsPolling.push({ field: sub.field, chunkIndex: sub.chunkIndex, responseUri: response.response_uri });
                }
                else if (response.error || response.message) {
                    errors.push({ field: sub.field, message: `${label}${chunkLabel}: ${response.error || response.message}` });
                }
                else if (response.all && response.all.errors && response.all.errors.length > 0) {
                    errors.push({ field: sub.field, message: `${label}${chunkLabel}: ${response.all.errors.join('; ')}` });
                }
                else {
                    errors.push({ field: sub.field, message: `${label}${chunkLabel}: No results returned.` });
                }
            }
            catch (err) {
                const label = FIELD_CONFIGS[sub.field].categoryLabel;
                const chunkLabel = chunks.length > 1 ? ` (batch ${sub.chunkIndex + 1})` : '';
                errors.push({ field: sub.field, message: `${label}${chunkLabel}: ${(err === null || err === void 0 ? void 0 : err.message) || err}` });
            }
        }
        // Poll all pending URIs concurrently using allSettled so one failure doesn't kill others
        let latestCredits;
        if (needsPolling.length > 0) {
            // Track progress by unique images completed (not API calls)
            const completedChunkIndices = new Set();
            let completedImages = 0;
            // Count images already done from sync responses
            for (const cr of chunkResponses) {
                if (!completedChunkIndices.has(cr.chunkIndex)) {
                    completedChunkIndices.add(cr.chunkIndex);
                    completedImages += chunks[cr.chunkIndex].images.length;
                }
            }
            sendToUI({
                type: 'status',
                message: `Waiting for results (${completedImages}/${totalImages} images)...`,
            });
            const pollPromises = needsPolling.map(p => {
                const label = FIELD_CONFIGS[p.field].categoryLabel;
                const chunkLabel = chunks.length > 1 ? ` batch ${p.chunkIndex + 1}` : '';
                return pollSingleUri(apiKey, p.responseUri, `${label}${chunkLabel}`, () => {
                    // Per-attempt progress: show image-level completion
                    sendToUI({
                        type: 'progress',
                        current: completedImages,
                        total: totalImages,
                        phase: 'polling',
                    });
                }).then(response => {
                    if (!completedChunkIndices.has(p.chunkIndex)) {
                        completedChunkIndices.add(p.chunkIndex);
                        completedImages += chunks[p.chunkIndex].images.length;
                    }
                    sendToUI({
                        type: 'progress',
                        current: completedImages,
                        total: totalImages,
                        phase: 'polling',
                    });
                    return { field: p.field, chunkIndex: p.chunkIndex, response, credits: response.credits };
                });
            });
            const settled = yield Promise.allSettled(pollPromises);
            for (let i = 0; i < settled.length; i++) {
                const outcome = settled[i];
                const field = needsPolling[i].field;
                const label = FIELD_CONFIGS[field].categoryLabel;
                const chunkLabel = chunks.length > 1 ? ` (batch ${needsPolling[i].chunkIndex + 1})` : '';
                if (outcome.status === 'fulfilled' && outcome.value.credits !== undefined) {
                    latestCredits = outcome.value.credits;
                }
                if (outcome.status === 'fulfilled') {
                    chunkResponses.push(outcome.value);
                }
                else {
                    const reason = outcome.reason;
                    errors.push({ field, message: `${label}${chunkLabel}: ${(reason === null || reason === void 0 ? void 0 : reason.message) || reason}` });
                }
            }
        }
        // Merge chunk responses into one response per field
        for (const field of fields) {
            const fieldChunks = chunkResponses.filter(cr => cr.field === field);
            if (fieldChunks.length === 0)
                continue;
            const mergedAssets = [];
            const mergedErrors = [];
            for (const cr of fieldChunks) {
                if (cr.response.all && cr.response.all.assets) {
                    mergedAssets.push(...cr.response.all.assets);
                }
                if (cr.response.all && cr.response.all.errors) {
                    mergedErrors.push(...cr.response.all.errors);
                }
            }
            responses.set(field, {
                all: {
                    assets: mergedAssets,
                    errors: mergedErrors.length > 0 ? mergedErrors : undefined,
                },
            });
        }
        return { responses, errors, credits: latestCredits };
    });
}
// ============================================================================
// Annotation Writing
// ============================================================================
/**
 * Sanitize an annotation to ensure it has only `label` OR `labelMarkdown`, not both.
 * Figma's validation rejects annotations with both set.
 */
function sanitizeAnnotation(ann) {
    const result = {};
    // Prefer labelMarkdown over label
    if (ann.labelMarkdown) {
        result.labelMarkdown = ann.labelMarkdown;
    }
    else if (ann.label) {
        result.label = ann.label;
    }
    if (ann.properties)
        result.properties = ann.properties;
    if (ann.categoryId)
        result.categoryId = ann.categoryId;
    return result;
}
/**
 * Write a single field's annotation to a node, preserving annotations from other fields
 * and any manually-added annotations.
 */
function writeFieldAnnotation(node, field, text, categoryIds) {
    return __awaiter(this, void 0, void 0, function* () {
        if (!('annotations' in node)) {
            throw new Error(`Node "${node.name}" does not support annotations.`);
        }
        const categoryId = categoryIds.get(field);
        const config = FIELD_CONFIGS[field];
        // Read existing annotations and filter out any with the same category or prefix
        const existing = [...(node.annotations || [])];
        const preserved = existing
            .filter((a) => {
            if (categoryId && a.categoryId === categoryId)
                return false;
            // When no category ID available, match by bold prefix text
            if (!categoryId) {
                const annText = a.labelMarkdown || a.label || '';
                if (annText.startsWith(`**${config.annotationPrefix}**`))
                    return false;
            }
            return true;
        })
            .map(sanitizeAnnotation);
        // Create the new annotation (with categoryId when available)
        const newAnnotation = {
            labelMarkdown: `**${config.annotationPrefix}**\n${text}`,
            properties: [{ type: 'fills' }],
        };
        if (categoryId) {
            newAnnotation.categoryId = categoryId;
        }
        // Write back with the new annotation appended
        node.annotations = [...preserved, newAnnotation];
    });
}
/**
 * Write multiple field annotations to a node at once.
 */
function writeMultipleFieldAnnotations(node, fields, categoryIds) {
    return __awaiter(this, void 0, void 0, function* () {
        if (!('annotations' in node)) {
            throw new Error(`Node "${node.name}" does not support annotations.`);
        }
        // Collect all category IDs and prefixes we're about to write
        const writingCategoryIds = new Set();
        const writingPrefixes = new Set();
        for (const f of fields) {
            const catId = categoryIds.get(f.field);
            if (catId)
                writingCategoryIds.add(catId);
            writingPrefixes.add(`**${FIELD_CONFIGS[f.field].annotationPrefix}**`);
        }
        // Read existing annotations and filter out ones we're replacing
        const existing = [...(node.annotations || [])];
        const preserved = existing
            .filter((a) => {
            if (a.categoryId && writingCategoryIds.has(a.categoryId))
                return false;
            // When no category ID on the annotation, match by bold prefix text
            if (!a.categoryId) {
                const annText = a.labelMarkdown || a.label || '';
                for (const prefix of writingPrefixes) {
                    if (annText.startsWith(prefix))
                        return false;
                }
            }
            return true;
        })
            .map(sanitizeAnnotation);
        // Build new annotations (with categoryId when available)
        const newAnnotations = fields.map(f => {
            const config = FIELD_CONFIGS[f.field];
            const categoryId = categoryIds.get(f.field);
            const ann = {
                labelMarkdown: `**${config.annotationPrefix}**\n${f.description}`,
                properties: [{ type: 'fills' }],
            };
            if (categoryId) {
                ann.categoryId = categoryId;
            }
            return ann;
        });
        node.annotations = [...preserved, ...newAnnotations];
    });
}
/**
 * Set relaunch data on a node so users can re-run the plugin.
 */
function setRelaunchOnNode(node) {
    if ('setRelaunchData' in node) {
        node.setRelaunchData({ open: '' });
    }
}
// ============================================================================
// Utilities
// ============================================================================
function sendToUI(message) {
    figma.ui.postMessage(message);
}
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
/**
 * Match an asset name from the API response back to the original node ID we sent.
 * The API transforms file_name values into server temp paths, e.g.:
 *   sent: "1:2504"  →  returned: "/tmp/files20260214-1-ei7mrm/1_2504"
 * Strategy:
 *   1. Direct match (handles future API improvements)
 *   2. Extract basename, reverse the colon→underscore substitution, match
 */
function matchAssetToNodeId(assetName, nodeIds) {
    // Direct match
    for (const id of nodeIds) {
        if (assetName === id)
            return id;
    }
    // Extract basename from path
    const basename = assetName.split('/').pop() || '';
    // Try reversing the colon→underscore transformation
    for (const id of nodeIds) {
        if (basename === id.replace(/:/g, '_'))
            return id;
    }
    return null;
}
// ============================================================================
// Main Generation Flow
// ============================================================================
/**
 * Main flow: find images, export, call API for each field, poll, send results to UI.
 */
function generateForFields(source, fields) {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            // Load settings
            const settings = yield loadSettings();
            if (!settings.apiKey) {
                sendToUI({
                    type: 'error',
                    message: 'API key is required. Please enter your Visionati API key in Settings.',
                });
                return;
            }
            if (fields.length === 0) {
                sendToUI({
                    type: 'error',
                    message: 'No fields selected. Choose at least one field (Alt Text, Caption, or Description).',
                });
                return;
            }
            // Find image nodes
            sendToUI({ type: 'status', message: 'Finding images...' });
            let sourceNodes;
            if (source === 'selection') {
                sourceNodes = figma.currentPage.selection;
                if (sourceNodes.length === 0) {
                    sendToUI({
                        type: 'error',
                        message: 'No layers selected. Select one or more layers containing images.',
                    });
                    return;
                }
            }
            else {
                sourceNodes = figma.currentPage.children;
            }
            const allImageNodes = getImageNodes(sourceNodes);
            if (allImageNodes.length === 0) {
                sendToUI({
                    type: 'error',
                    message: source === 'selection'
                        ? 'No images found in the selection. Select layers that contain images.'
                        : 'No images found on this page.',
                });
                return;
            }
            const imageNodes = allImageNodes;
            const fieldLabels = fields.map(f => FIELD_CONFIGS[f].categoryLabel).join(', ');
            sendToUI({
                type: 'status',
                message: `Found ${imageNodes.length} image(s). Generating: ${fieldLabels}`,
            });
            // Ensure annotation categories exist
            sendToUI({ type: 'status', message: 'Setting up annotation categories...' });
            const categoryIds = yield ensureCategories(fields);
            // Send category info to UI for display
            const categoryInfo = {};
            for (const field of fields) {
                const config = FIELD_CONFIGS[field];
                categoryInfo[field] = { label: config.categoryLabel, color: config.categoryColor };
            }
            sendToUI({ type: 'categories', categories: categoryInfo });
            // Build node map for result matching
            const nodeMap = new Map();
            for (const node of imageNodes) {
                nodeMap.set(node.id, node);
            }
            // Export images as PNG bytes
            const base64Images = [];
            const fileNames = [];
            const nodeInfos = [];
            for (let i = 0; i < imageNodes.length; i++) {
                const node = imageNodes[i];
                sendToUI({
                    type: 'progress',
                    current: i + 1,
                    total: imageNodes.length,
                    phase: 'exporting',
                });
                try {
                    const bytes = yield exportNodeAsPng(node);
                    const base64 = figma.base64Encode(bytes);
                    base64Images.push(base64);
                    fileNames.push(node.id);
                    // Export a small thumbnail for the UI preview
                    let thumbnail = '';
                    try {
                        thumbnail = yield exportNodeThumbnail(node);
                    }
                    catch (_a) {
                        // Thumbnail is optional — don't fail the whole export
                    }
                    nodeInfos.push({
                        nodeId: node.id,
                        nodeName: node.name,
                        thumbnail: thumbnail,
                    });
                }
                catch (err) {
                    console.error(`Failed to export node "${node.name}" (${node.id}):`, err);
                    sendToUI({
                        type: 'status',
                        message: `Warning: Failed to export "${node.name}", skipping.`,
                    });
                }
            }
            if (base64Images.length === 0) {
                sendToUI({
                    type: 'error',
                    message: 'Failed to export any images. Please try again.',
                });
                return;
            }
            // Submit API calls for all fields and poll for results
            const { responses: fieldResponses, errors: fieldErrors, credits: remainingCredits } = yield submitAndPollAllFields(settings.apiKey, base64Images, fileNames, settings, fields);
            // If ALL fields failed, show error and bail
            if (fieldResponses.size === 0) {
                const messages = fieldErrors.map(e => e.message);
                sendToUI({
                    type: 'error',
                    messages: messages.length > 0
                        ? messages
                        : ['The API returned no results. Try a different model or check your API credits.'],
                });
                return;
            }
            // Parse results and group by node
            const nodeResultMap = new Map();
            // Initialize entries for all exported nodes
            for (const info of nodeInfos) {
                nodeResultMap.set(info.nodeId, {
                    nodeId: info.nodeId,
                    nodeName: info.nodeName,
                    thumbnail: info.thumbnail || undefined,
                    fields: [],
                });
            }
            // Surface any backend errors from successful responses as warnings.
            // Errors from responses that also had assets were already captured during
            // submission, but polling results may also carry errors — capture those too.
            const fieldsWithSubmissionErrors = new Set(fieldErrors.map(e => e.field));
            for (const [field, response] of fieldResponses) {
                if (response.all && response.all.errors && response.all.errors.length > 0) {
                    const label = FIELD_CONFIGS[field].categoryLabel;
                    console.warn(`[Visionati] ${label} backend errors:`, response.all.errors);
                    // Only add if not already captured during submission phase
                    if (!fieldsWithSubmissionErrors.has(field)) {
                        fieldErrors.push({
                            field,
                            message: `${label}: ${response.all.errors.join('; ')}`,
                        });
                    }
                }
            }
            // Process responses for each field that succeeded.
            // The API transforms file_name values into server temp paths (e.g., "1:2504" becomes
            // "/tmp/files.../1_2504"). Match by extracting the basename and reversing the
            // colon-to-underscore conversion.
            const nodeIds = [...nodeResultMap.keys()];
            if (DEBUG)
                console.log(`[Visionati] Processing ${fieldResponses.size} field response(s), ${fieldErrors.length} error(s)`);
            if (DEBUG)
                console.log(`[Visionati] Node IDs we're looking for:`, nodeIds);
            for (const [field, response] of fieldResponses) {
                if (!response.all || !response.all.assets) {
                    if (DEBUG)
                        console.log(`[Visionati] Field "${field}": no assets in response`);
                    continue;
                }
                const assets = response.all.assets;
                if (DEBUG)
                    console.log(`[Visionati] Field "${field}": ${assets.length} asset(s)`);
                for (let i = 0; i < assets.length; i++) {
                    const asset = assets[i];
                    const nodeId = matchAssetToNodeId(asset.name || '', nodeIds);
                    if (DEBUG)
                        console.log(`[Visionati] Asset ${i}: name="${asset.name}", matched nodeId="${nodeId}"`);
                    if (!nodeId)
                        continue;
                    const nodeResult = nodeResultMap.get(nodeId);
                    if (!nodeResult)
                        continue;
                    let description = '';
                    let backendName = settings.backend;
                    if (asset.descriptions && asset.descriptions.length > 0) {
                        if (DEBUG)
                            console.log(`[Visionati] Asset ${i}: ${asset.descriptions.length} description(s), first: ${JSON.stringify(asset.descriptions[0]).substring(0, 150)}`);
                        description = asset.descriptions[0].description || '';
                        backendName = asset.descriptions[0].source || settings.backend;
                    }
                    else {
                        if (DEBUG)
                            console.log(`[Visionati] Asset ${i}: no descriptions`);
                    }
                    if (description) {
                        nodeResult.fields.push({
                            field: field,
                            description: description,
                            backend: backendName,
                        });
                    }
                }
            }
            // Collect results that have at least one field
            const results = [];
            for (const nodeResult of nodeResultMap.values()) {
                if (nodeResult.fields.length > 0) {
                    results.push(nodeResult);
                }
            }
            if (results.length === 0) {
                const messages = fieldErrors.map(e => e.message);
                sendToUI({
                    type: 'error',
                    messages: messages.length > 0
                        ? messages
                        : ['The API returned no descriptions. Try a different model or check your API credits.'],
                });
                return;
            }
            // Detect fields that were requested but produced no descriptions anywhere
            // (API call "succeeded" but returned empty/no descriptions — silent failure)
            const fieldsWithResults = new Set();
            for (const nr of results) {
                for (const f of nr.fields) {
                    fieldsWithResults.add(f.field);
                }
            }
            const fieldsAlreadyErrored = new Set(fieldErrors.map(e => e.field));
            for (const field of fields) {
                if (!fieldsWithResults.has(field) && !fieldsAlreadyErrored.has(field)) {
                    const label = FIELD_CONFIGS[field].categoryLabel;
                    console.warn(`[Visionati] ${label}: API returned no descriptions (response had assets but all descriptions were empty)`);
                    fieldErrors.push({
                        field,
                        message: `${label}: No descriptions returned. The model may not have produced output for this role. Try a different model.`,
                    });
                }
            }
            // Report partial errors (some fields failed, others succeeded)
            if (fieldErrors.length > 0) {
                const failedLabels = fieldErrors.map(e => FIELD_CONFIGS[e.field].categoryLabel);
                sendToUI({
                    type: 'status',
                    message: `Warning: ${failedLabels.join(', ')} failed. Showing results for fields that succeeded.`,
                });
            }
            // Send results to UI for preview
            sendToUI({
                type: 'results',
                results: results,
                totalImages: imageNodes.length,
                fields: fields,
                fieldErrors: fieldErrors.map(e => ({ field: e.field, message: e.message })),
                credits: remainingCredits,
            });
        }
        catch (err) {
            const message = (err === null || err === void 0 ? void 0 : err.message) || String(err);
            sendToUI({
                type: 'error',
                message: message,
            });
        }
    });
}
// ============================================================================
// Message Handler
// ============================================================================
figma.ui.onmessage = (msg) => __awaiter(void 0, void 0, void 0, function* () {
    switch (msg.type) {
        case 'load-settings': {
            try {
                const settings = yield loadSettings();
                sendToUI({ type: 'settings', settings });
            }
            catch (err) {
                console.error('[Visionati] Failed to load settings:', err);
                sendToUI({ type: 'settings', settings: Object.assign({}, DEFAULT_SETTINGS) });
                sendToUI({ type: 'error', message: `Failed to load settings: ${(err === null || err === void 0 ? void 0 : err.message) || err}` });
            }
            break;
        }
        case 'save-settings': {
            try {
                yield saveSettings(msg.settings);
                sendToUI({ type: 'status', message: 'Settings saved.' });
            }
            catch (err) {
                console.error('[Visionati] Failed to save settings:', err);
                sendToUI({ type: 'error', message: `Failed to save settings: ${(err === null || err === void 0 ? void 0 : err.message) || err}` });
            }
            break;
        }
        case 'generate': {
            yield generateForFields(msg.source, msg.fields);
            break;
        }
        case 'apply-field': {
            try {
                const node = yield figma.getNodeByIdAsync(msg.nodeId);
                if (!node) {
                    sendToUI({
                        type: 'error',
                        message: `Node not found: ${msg.nodeId}. It may have been deleted.`,
                    });
                    break;
                }
                const categoryIds = yield ensureCategories([msg.field]);
                yield writeFieldAnnotation(node, msg.field, msg.description, categoryIds);
                setRelaunchOnNode(node);
                sendToUI({
                    type: 'field-applied',
                    nodeId: msg.nodeId,
                    field: msg.field,
                });
                const label = FIELD_CONFIGS[msg.field].categoryLabel;
                figma.notify(`${label} applied to "${node.name}".`);
                sendSelectionAnnotations();
            }
            catch (err) {
                sendToUI({
                    type: 'error',
                    message: `Failed to apply: ${(err === null || err === void 0 ? void 0 : err.message) || err}`,
                });
            }
            break;
        }
        case 'apply-node': {
            try {
                const node = yield figma.getNodeByIdAsync(msg.nodeId);
                if (!node) {
                    sendToUI({
                        type: 'error',
                        message: `Node not found: ${msg.nodeId}. It may have been deleted.`,
                    });
                    break;
                }
                const fieldTypes = msg.fields.map(f => f.field);
                const categoryIds = yield ensureCategories(fieldTypes);
                yield writeMultipleFieldAnnotations(node, msg.fields, categoryIds);
                setRelaunchOnNode(node);
                for (const f of msg.fields) {
                    sendToUI({
                        type: 'field-applied',
                        nodeId: msg.nodeId,
                        field: f.field,
                    });
                }
                const count = msg.fields.length;
                figma.notify(`${count} annotation${count !== 1 ? 's' : ''} applied to "${node.name}".`);
                sendSelectionAnnotations();
            }
            catch (err) {
                sendToUI({
                    type: 'error',
                    message: `Failed to apply: ${(err === null || err === void 0 ? void 0 : err.message) || err}`,
                });
            }
            break;
        }
        case 'apply-all': {
            let applied = 0;
            let failed = 0;
            // Collect all field types we need categories for
            const allFieldTypes = new Set();
            for (const nodeData of msg.nodes) {
                for (const f of nodeData.fields) {
                    allFieldTypes.add(f.field);
                }
            }
            const categoryIds = yield ensureCategories([...allFieldTypes]);
            for (const nodeData of msg.nodes) {
                try {
                    const node = yield figma.getNodeByIdAsync(nodeData.nodeId);
                    if (!node) {
                        failed++;
                        continue;
                    }
                    yield writeMultipleFieldAnnotations(node, nodeData.fields, categoryIds);
                    setRelaunchOnNode(node);
                    for (const f of nodeData.fields) {
                        sendToUI({
                            type: 'field-applied',
                            nodeId: nodeData.nodeId,
                            field: f.field,
                        });
                    }
                    applied++;
                }
                catch (_a) {
                    failed++;
                }
            }
            const parts = [];
            if (applied > 0) {
                parts.push(`Applied to ${applied} image${applied !== 1 ? 's' : ''}`);
            }
            if (failed > 0) {
                parts.push(`${failed} failed`);
            }
            figma.notify(parts.join('. ') + '.');
            sendToUI({
                type: 'all-applied',
                applied: applied,
                failed: failed,
            });
            sendSelectionAnnotations();
            break;
        }
        case 'discard-field': {
            sendToUI({
                type: 'field-discarded',
                nodeId: msg.nodeId,
                field: msg.field,
            });
            break;
        }
        case 'discard-node': {
            sendToUI({
                type: 'node-discarded',
                nodeId: msg.nodeId,
            });
            break;
        }
        case 'remove-annotation': {
            try {
                const node = yield figma.getNodeByIdAsync(msg.nodeId);
                if (!node || !('annotations' in node)) {
                    sendToUI({ type: 'error', message: 'Node not found or does not support annotations.' });
                    break;
                }
                // Find the category ID by label (if annotations API is available)
                let targetCategoryId = null;
                if (figma.annotations) {
                    const categories = yield figma.annotations.getAnnotationCategoriesAsync();
                    for (const cat of categories) {
                        if (cat.label === msg.categoryLabel) {
                            targetCategoryId = cat.id;
                            break;
                        }
                    }
                }
                const existing = [...(node.annotations || [])];
                if (targetCategoryId) {
                    // Remove annotations matching the category
                    const filtered = existing
                        .filter((a) => a.categoryId !== targetCategoryId)
                        .map(sanitizeAnnotation);
                    node.annotations = filtered;
                }
                else {
                    // No category match — remove by label text match
                    const filtered = existing
                        .filter((a) => {
                        const text = a.labelMarkdown || a.label || '';
                        return !text.includes(`**${msg.categoryLabel.toUpperCase()}**`);
                    })
                        .map(sanitizeAnnotation);
                    node.annotations = filtered;
                }
                figma.notify(`Removed ${msg.categoryLabel} from "${node.name}".`);
                sendSelectionAnnotations();
            }
            catch (err) {
                sendToUI({ type: 'error', message: `Failed to remove: ${(err === null || err === void 0 ? void 0 : err.message) || err}` });
            }
            break;
        }
        case 'edit-annotation': {
            try {
                const node = yield figma.getNodeByIdAsync(msg.nodeId);
                if (!node || !('annotations' in node)) {
                    sendToUI({ type: 'error', message: 'Node not found or does not support annotations.' });
                    break;
                }
                // Find the category ID by label (if annotations API is available)
                let targetCategoryId = null;
                if (figma.annotations) {
                    const categories = yield figma.annotations.getAnnotationCategoriesAsync();
                    for (const cat of categories) {
                        if (cat.label === msg.categoryLabel) {
                            targetCategoryId = cat.id;
                            break;
                        }
                    }
                }
                const existing = [...(node.annotations || [])];
                let found = false;
                const updated = existing.map((a) => {
                    const matchesCat = targetCategoryId && a.categoryId === targetCategoryId;
                    const matchesText = !targetCategoryId && (a.labelMarkdown || a.label || '').includes(`**${msg.categoryLabel.toUpperCase()}**`);
                    if ((matchesCat || matchesText) && !found) {
                        found = true;
                        // Rebuild with the new text, preserving bold prefix and category
                        const prefix = `**${msg.categoryLabel.toUpperCase()}**`;
                        const result = {
                            labelMarkdown: `${prefix}\n${msg.newText}`,
                        };
                        if (a.properties)
                            result.properties = a.properties;
                        if (a.categoryId)
                            result.categoryId = a.categoryId;
                        return result;
                    }
                    return sanitizeAnnotation(a);
                });
                if (found) {
                    node.annotations = updated;
                    figma.notify(`Updated ${msg.categoryLabel} on "${node.name}".`);
                }
                else {
                    sendToUI({ type: 'error', message: `No ${msg.categoryLabel} annotation found on "${node.name}".` });
                }
                sendSelectionAnnotations();
            }
            catch (err) {
                sendToUI({ type: 'error', message: `Failed to edit: ${(err === null || err === void 0 ? void 0 : err.message) || err}` });
            }
            break;
        }
        case 'remove-all-annotations': {
            try {
                const node = yield figma.getNodeByIdAsync(msg.nodeId);
                if (!node || !('annotations' in node)) {
                    sendToUI({ type: 'error', message: 'Node not found or does not support annotations.' });
                    break;
                }
                node.annotations = [];
                figma.notify(`Removed all annotations from "${node.name}".`);
                sendSelectionAnnotations();
            }
            catch (err) {
                sendToUI({ type: 'error', message: `Failed to remove: ${(err === null || err === void 0 ? void 0 : err.message) || err}` });
            }
            break;
        }
    }
});
// ============================================================================
// Selection Change — Read Annotations
// ============================================================================
/**
 * Read annotations from selected nodes and send to UI for display.
 */
function sendSelectionAnnotations() {
    return __awaiter(this, void 0, void 0, function* () {
        const selection = figma.currentPage.selection;
        if (selection.length === 0) {
            sendToUI({ type: 'selection-annotations', nodes: [] });
            return;
        }
        const annotatedNodes = [];
        for (const node of selection) {
            if (!('annotations' in node))
                continue;
            const annotations = node.annotations;
            if (!annotations || annotations.length === 0)
                continue;
            const parsed = [];
            for (const ann of annotations) {
                const text = ann.labelMarkdown || ann.label || '';
                if (!text)
                    continue;
                // Try to resolve category label
                let label = '';
                if (ann.categoryId && figma.annotations) {
                    const cat = yield figma.annotations.getAnnotationCategoryByIdAsync(ann.categoryId);
                    if (cat)
                        label = cat.label;
                }
                parsed.push({
                    label: label,
                    categoryId: ann.categoryId || undefined,
                    text: text,
                });
            }
            if (parsed.length > 0) {
                annotatedNodes.push({
                    nodeId: node.id,
                    nodeName: node.name,
                    annotations: parsed,
                });
            }
        }
        sendToUI({ type: 'selection-annotations', nodes: annotatedNodes });
    });
}
// ============================================================================
// Plugin Entry Point
// ============================================================================
/**
 * Show the plugin UI panel and send initial settings.
 */
function showPluginUI(command) {
    return __awaiter(this, void 0, void 0, function* () {
        figma.showUI(__html__, {
            width: 380,
            height: 600,
            themeColors: true,
            title: 'Visionati',
        });
        // Send initial settings to UI
        const settings = yield loadSettings();
        sendToUI({ type: 'settings', settings });
        // If launched with a generate command, tell the UI to auto-trigger
        if (command === 'selection' || command === 'all-images') {
            sendToUI({ type: 'auto-generate', source: command });
        }
        else if (command === 'settings') {
            sendToUI({ type: 'switch-tab', tab: 'settings' });
        }
        // Listen for selection changes to show existing annotations
        // Remove old listener first to avoid accumulation across re-opens
        if (selectionChangeHandler) {
            figma.off('selectionchange', selectionChangeHandler);
        }
        selectionChangeHandler = () => {
            const nodeIds = figma.currentPage.selection.map(n => n.id);
            sendToUI({ type: 'selection-changed', nodeIds });
            sendSelectionAnnotations().catch(err => {
                console.error('[Visionati] Failed to read selection annotations:', err);
            });
        };
        figma.on('selectionchange', selectionChangeHandler);
        // Send initial selection annotations
        sendSelectionAnnotations().catch(err => {
            console.error('[Visionati] Failed to read initial selection annotations:', err);
        });
    });
}
// Handle plugin run from menu commands
figma.on('run', (_a) => __awaiter(void 0, [_a], void 0, function* ({ command }) {
    try {
        switch (command) {
            case 'open':
            case 'selection':
            case 'all-images':
            case 'settings':
                yield showPluginUI(command);
                break;
            default:
                yield showPluginUI();
                break;
        }
    }
    catch (err) {
        console.error('[Visionati] Plugin startup failed:', err);
        // Try to show the UI with an error if possible
        try {
            figma.showUI(__html__, { width: 380, height: 600, themeColors: true, title: 'Visionati' });
            sendToUI({ type: 'error', message: `Plugin failed to start: ${(err === null || err === void 0 ? void 0 : err.message) || err}` });
        }
        catch (_b) {
            figma.closePlugin(`Plugin failed to start: ${(err === null || err === void 0 ? void 0 : err.message) || err}`);
        }
    }
}));
