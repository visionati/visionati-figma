/// <reference types="@figma/plugin-typings" />

// Visionati — Figma Plugin Sandbox Code
// Runs in Figma's plugin sandbox. Handles document access, image export,
// API calls via sandbox fetch, annotation writing, and postMessage bridge to UI.

// ============================================================================
// Types
// ============================================================================

type FieldType = 'alt_text' | 'caption' | 'description';

interface FieldConfig {
  role: string;
  categoryLabel: string;
  categoryColor: AnnotationCategoryColor;
  annotationPrefix: string;
}

interface PluginSettings {
  apiKey: string;
  backend: string;
  language: string;
  prompt: string;
}

interface ImageNodeInfo {
  nodeId: string;
  nodeName: string;
  width: number;
  height: number;
}

interface FieldResult {
  field: FieldType;
  description: string;
  backend: string;
}

interface NodeResult {
  nodeId: string;
  nodeName: string;
  hasExistingAnnotation: boolean;
  fields: FieldResult[];
}

interface VisionatiAsset {
  file_name?: string;
  descriptions?: Array<{
    text: string;
    backend: string;
  }>;
}

interface VisionatiResponse {
  response_uri?: string;
  assets?: VisionatiAsset[];
  error?: string;
  message?: string;
}

// Message types from UI → Sandbox
interface GenerateMessage {
  type: 'generate';
  source: 'selection' | 'page';
  fields: FieldType[];
  overwrite?: boolean;
}

interface ApplyFieldMessage {
  type: 'apply-field';
  nodeId: string;
  field: FieldType;
  description: string;
}

interface ApplyNodeMessage {
  type: 'apply-node';
  nodeId: string;
  fields: Array<{ field: FieldType; description: string }>;
}

interface ApplyAllMessage {
  type: 'apply-all';
  nodes: Array<{
    nodeId: string;
    fields: Array<{ field: FieldType; description: string }>;
  }>;
}

interface DiscardFieldMessage {
  type: 'discard-field';
  nodeId: string;
  field: FieldType;
}

interface DiscardNodeMessage {
  type: 'discard-node';
  nodeId: string;
}

interface SaveSettingsMessage {
  type: 'save-settings';
  settings: PluginSettings;
}

interface LoadSettingsMessage {
  type: 'load-settings';
}

type UIMessage =
  | GenerateMessage
  | ApplyFieldMessage
  | ApplyNodeMessage
  | ApplyAllMessage
  | DiscardFieldMessage
  | DiscardNodeMessage
  | SaveSettingsMessage
  | LoadSettingsMessage;

// ============================================================================
// Constants
// ============================================================================

const API_BASE_URL = 'https://api.visionati.com';
const MAX_EXPORT_DIMENSION = 2048;
const POLL_INTERVAL_MS = 2000;
const MAX_POLL_ATTEMPTS = 30;

const DEFAULT_SETTINGS: PluginSettings = {
  apiKey: '',
  backend: 'gemini',
  language: 'English',
  prompt: '',
};

const SETTINGS_KEYS: Array<keyof PluginSettings> = [
  'apiKey',
  'backend',
  'language',
  'prompt',
];

const FIELD_CONFIGS: Record<FieldType, FieldConfig> = {
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
const categoryIdCache: Map<FieldType, string> = new Map();

// ============================================================================
// Node Detection
// ============================================================================

/**
 * Check if a node has at least one visible image fill.
 * Ignores figma.mixed fill values.
 */
function nodeHasImageFill(node: SceneNode): boolean {
  return (
    'fills' in node &&
    Array.isArray(node.fills) &&
    node.fills.some(
      (paint: Paint) => paint.type === 'IMAGE' && paint.visible !== false
    )
  );
}

/**
 * Recursively find all nodes with image fills from an array of nodes.
 * Traverses descendants using findAll when available.
 */
function getImageNodes(nodes: ReadonlyArray<SceneNode>): SceneNode[] {
  const imageNodes: SceneNode[] = [];
  const seen = new Set<string>();

  for (const node of nodes) {
    if (nodeHasImageFill(node) && !seen.has(node.id)) {
      imageNodes.push(node);
      seen.add(node.id);
    }

    // Traverse descendants
    if ('findAll' in node) {
      const descendants = (node as ChildrenMixin & SceneNode).findAll(
        (descendant: SceneNode) => nodeHasImageFill(descendant)
      );
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

/**
 * Check if a node already has annotations.
 */
function nodeHasAnnotations(node: SceneNode): boolean {
  return (
    'annotations' in node &&
    Array.isArray((node as any).annotations) &&
    (node as any).annotations.length > 0
  );
}

// ============================================================================
// Image Export
// ============================================================================

/**
 * Calculate export constraint to cap the longest dimension at MAX_EXPORT_DIMENSION.
 * Returns undefined if no scaling is needed.
 */
function getExportConstraint(
  node: SceneNode
): { type: 'WIDTH'; value: number } | { type: 'HEIGHT'; value: number } | undefined {
  const width = node.width;
  const height = node.height;

  if (width <= MAX_EXPORT_DIMENSION && height <= MAX_EXPORT_DIMENSION) {
    return undefined;
  }

  if (width >= height) {
    return { type: 'WIDTH', value: MAX_EXPORT_DIMENSION };
  } else {
    return { type: 'HEIGHT', value: MAX_EXPORT_DIMENSION };
  }
}

/**
 * Export a node as PNG bytes with optional size capping.
 */
async function exportNodeAsPng(node: SceneNode): Promise<Uint8Array> {
  const constraint = getExportConstraint(node);
  const settings: ExportSettings = {
    format: 'PNG',
    ...(constraint ? { constraint } : {}),
  };
  return await (node as ExportMixin).exportAsync(settings);
}

// ============================================================================
// Settings Storage
// ============================================================================

/**
 * Load all settings from clientStorage.
 */
async function loadSettings(): Promise<PluginSettings> {
  const settings: PluginSettings = { ...DEFAULT_SETTINGS };

  for (const key of SETTINGS_KEYS) {
    const value = await figma.clientStorage.getAsync(key);
    if (value !== undefined && value !== null) {
      settings[key] = value as string;
    }
  }

  return settings;
}

/**
 * Save all settings to clientStorage.
 */
async function saveSettings(settings: PluginSettings): Promise<void> {
  for (const key of SETTINGS_KEYS) {
    await figma.clientStorage.setAsync(key, settings[key]);
  }
}

// ============================================================================
// Annotation Categories
// ============================================================================

/**
 * Find or create an annotation category for the given field.
 * Caches the category ID for the session to avoid repeated lookups.
 */
async function ensureCategoryForField(field: FieldType): Promise<string> {
  // Check cache first
  const cached = categoryIdCache.get(field);
  if (cached) {
    // Verify it still exists (user might have deleted it)
    const existing = await figma.annotations.getAnnotationCategoryByIdAsync(cached);
    if (existing) {
      return cached;
    }
    categoryIdCache.delete(field);
  }

  const config = FIELD_CONFIGS[field];

  // Search existing categories by label
  const categories = await figma.annotations.getAnnotationCategoriesAsync();
  for (const cat of categories) {
    if (cat.label === config.categoryLabel) {
      categoryIdCache.set(field, cat.id);
      return cat.id;
    }
  }

  // Create new category
  const newCategory = await figma.annotations.addAnnotationCategoryAsync({
    label: config.categoryLabel,
    color: config.categoryColor,
  });

  categoryIdCache.set(field, newCategory.id);
  return newCategory.id;
}

/**
 * Ensure categories exist for all requested fields.
 * Returns a map of field → categoryId.
 */
async function ensureCategories(fields: FieldType[]): Promise<Map<FieldType, string>> {
  const result = new Map<FieldType, string>();
  for (const field of fields) {
    const id = await ensureCategoryForField(field);
    result.set(field, id);
  }
  return result;
}

// ============================================================================
// Visionati API
// ============================================================================

/**
 * Send images to the Visionati API as a batched request with a specific role.
 * Returns the response_uri for async polling, or results if sync.
 */
async function callVisionatiApi(
  apiKey: string,
  base64Images: string[],
  fileNames: string[],
  settings: PluginSettings,
  role: string
): Promise<VisionatiResponse> {
  const body: Record<string, any> = {
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

  const response = await fetch(`${API_BASE_URL}/api/fetch`, {
    method: 'POST',
    headers: {
      'X-API-Key': `Token ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    let errorMessage: string;
    try {
      const errorJson = JSON.parse(text);
      errorMessage = errorJson.error || errorJson.message || `API error (${response.status})`;
    } catch {
      errorMessage = `API error (${response.status}): ${text.substring(0, 200)}`;
    }
    throw new Error(errorMessage);
  }

  return await response.json() as VisionatiResponse;
}

/**
 * Poll a single response_uri until results are ready.
 */
async function pollSingleUri(
  apiKey: string,
  responseUri: string,
  fieldLabel: string,
  onProgress: (attempt: number) => void
): Promise<VisionatiResponse> {
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      await sleep(POLL_INTERVAL_MS);
    }

    onProgress(attempt + 1);

    const response = await fetch(responseUri, {
      method: 'GET',
      headers: {
        'X-API-Key': `Token ${apiKey}`,
      },
    });

    if (!response.ok) {
      if (response.status === 202) {
        continue;
      }
      const text = await response.text();
      throw new Error(`Polling error for ${fieldLabel} (${response.status}): ${text.substring(0, 200)}`);
    }

    const data = await response.json() as VisionatiResponse;

    if (data.assets && data.assets.length > 0) {
      return data;
    }

    if (data.response_uri) {
      continue;
    }

    return data;
  }

  throw new Error(`Timed out waiting for ${fieldLabel} results. Please try again.`);
}

/**
 * Submit API calls for multiple fields in parallel, then poll all concurrently.
 * Returns a map of field → VisionatiResponse.
 */
async function submitAndPollAllFields(
  apiKey: string,
  base64Images: string[],
  fileNames: string[],
  settings: PluginSettings,
  fields: FieldType[]
): Promise<Map<FieldType, VisionatiResponse>> {
  const results = new Map<FieldType, VisionatiResponse>();

  // Submit all API calls in parallel (one per field)
  sendToUI({
    type: 'status',
    message: `Submitting ${fields.length} API call${fields.length !== 1 ? 's' : ''} (${fields.map(f => FIELD_CONFIGS[f].categoryLabel).join(', ')})...`,
  });

  const submissions: Array<{ field: FieldType; promise: Promise<VisionatiResponse> }> = [];
  for (const field of fields) {
    const config = FIELD_CONFIGS[field];
    const promise = callVisionatiApi(apiKey, base64Images, fileNames, settings, config.role);
    submissions.push({ field, promise });
  }

  // Await all submissions
  const submissionResults: Array<{ field: FieldType; response: VisionatiResponse }> = [];
  for (const sub of submissions) {
    try {
      const response = await sub.promise;
      submissionResults.push({ field: sub.field, response });
    } catch (err: any) {
      throw new Error(`${FIELD_CONFIGS[sub.field].categoryLabel}: ${err?.message || err}`);
    }
  }

  // Separate sync results from async (need polling)
  const needsPolling: Array<{ field: FieldType; responseUri: string }> = [];

  for (const sub of submissionResults) {
    if (sub.response.assets && sub.response.assets.length > 0) {
      // Got sync results
      results.set(sub.field, sub.response);
    } else if (sub.response.response_uri) {
      needsPolling.push({ field: sub.field, responseUri: sub.response.response_uri });
    } else if (sub.response.error || sub.response.message) {
      throw new Error(
        `${FIELD_CONFIGS[sub.field].categoryLabel}: ${sub.response.error || sub.response.message}`
      );
    } else {
      throw new Error(
        `${FIELD_CONFIGS[sub.field].categoryLabel}: Unexpected API response.`
      );
    }
  }

  // Poll all pending URIs concurrently
  if (needsPolling.length > 0) {
    const pollingLabels = needsPolling.map(p => FIELD_CONFIGS[p.field].categoryLabel).join(', ');
    sendToUI({
      type: 'status',
      message: `Waiting for results (${pollingLabels})...`,
    });

    const pollPromises = needsPolling.map(p =>
      pollSingleUri(
        apiKey,
        p.responseUri,
        FIELD_CONFIGS[p.field].categoryLabel,
        (attempt) => {
          sendToUI({
            type: 'progress',
            current: attempt,
            total: MAX_POLL_ATTEMPTS,
            phase: 'polling',
          });
        }
      ).then(response => ({ field: p.field, response }))
    );

    const pollResults = await Promise.all(pollPromises);
    for (const pr of pollResults) {
      results.set(pr.field, pr.response);
    }
  }

  return results;
}

// ============================================================================
// Annotation Writing
// ============================================================================

/**
 * Write a single field's annotation to a node, preserving annotations from other fields
 * and any manually-added annotations.
 */
async function writeFieldAnnotation(
  node: SceneNode,
  field: FieldType,
  text: string,
  categoryIds: Map<FieldType, string>
): Promise<void> {
  if (!('annotations' in node)) {
    throw new Error(`Node "${node.name}" does not support annotations.`);
  }

  const categoryId = categoryIds.get(field);
  if (!categoryId) {
    throw new Error(`No category found for field "${field}".`);
  }

  const config = FIELD_CONFIGS[field];

  // Read existing annotations and filter out any with the same category
  const existing: Annotation[] = [...((node as any).annotations || [])];
  const preserved = existing.filter(
    (a: Annotation) => a.categoryId !== categoryId
  );

  // Create the new annotation
  const newAnnotation: Annotation = {
    labelMarkdown: `**${config.annotationPrefix}**\n${text}`,
    properties: [{ type: 'fills' }],
    categoryId: categoryId,
  };

  // Write back with the new annotation appended
  (node as any).annotations = [...preserved, newAnnotation];
}

/**
 * Write multiple field annotations to a node at once.
 */
async function writeMultipleFieldAnnotations(
  node: SceneNode,
  fields: Array<{ field: FieldType; description: string }>,
  categoryIds: Map<FieldType, string>
): Promise<void> {
  if (!('annotations' in node)) {
    throw new Error(`Node "${node.name}" does not support annotations.`);
  }

  // Collect all category IDs we're about to write
  const writingCategoryIds = new Set<string>();
  for (const f of fields) {
    const catId = categoryIds.get(f.field);
    if (catId) writingCategoryIds.add(catId);
  }

  // Read existing annotations and filter out ones we're replacing
  const existing: Annotation[] = [...((node as any).annotations || [])];
  const preserved = existing.filter(
    (a: Annotation) => !a.categoryId || !writingCategoryIds.has(a.categoryId)
  );

  // Build new annotations
  const newAnnotations: Annotation[] = fields.map(f => {
    const config = FIELD_CONFIGS[f.field];
    const categoryId = categoryIds.get(f.field)!;
    return {
      labelMarkdown: `**${config.annotationPrefix}**\n${f.description}`,
      properties: [{ type: 'fills' as const }],
      categoryId: categoryId,
    };
  });

  (node as any).annotations = [...preserved, ...newAnnotations];
}

/**
 * Set relaunch data on a node so users can re-run the plugin.
 */
function setRelaunchOnNode(node: SceneNode): void {
  if ('setRelaunchData' in node) {
    (node as any).setRelaunchData({ selection: '' });
  }
}

// ============================================================================
// Utilities
// ============================================================================

function sendToUI(message: Record<string, any>): void {
  figma.ui.postMessage(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================================
// Main Generation Flow
// ============================================================================

/**
 * Main flow: find images, export, call API for each field, poll, send results to UI.
 */
async function generateForFields(
  source: 'selection' | 'page',
  fields: FieldType[],
  overwrite: boolean
): Promise<void> {
  try {
    // Load settings
    const settings = await loadSettings();

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

    let sourceNodes: ReadonlyArray<SceneNode>;
    if (source === 'selection') {
      sourceNodes = figma.currentPage.selection;
      if (sourceNodes.length === 0) {
        sendToUI({
          type: 'error',
          message: 'No layers selected. Select one or more layers containing images.',
        });
        return;
      }
    } else {
      sourceNodes = figma.currentPage.children;
    }

    const allImageNodes = getImageNodes(sourceNodes);

    if (allImageNodes.length === 0) {
      sendToUI({
        type: 'error',
        message:
          source === 'selection'
            ? 'No images found in the selection. Select layers that contain images.'
            : 'No images found on this page.',
      });
      return;
    }

    // Filter out nodes with existing annotations (unless overwrite is requested)
    const imageNodes = overwrite
      ? allImageNodes
      : allImageNodes.filter((node) => !nodeHasAnnotations(node));

    const skippedCount = allImageNodes.length - imageNodes.length;

    if (imageNodes.length === 0) {
      sendToUI({
        type: 'error',
        message: `All ${allImageNodes.length} image(s) already have annotations. Enable "Include images with existing annotations" to regenerate.`,
      });
      return;
    }

    const fieldLabels = fields.map(f => FIELD_CONFIGS[f].categoryLabel).join(', ');
    if (skippedCount > 0) {
      sendToUI({
        type: 'status',
        message: `Found ${imageNodes.length} image(s) (${skippedCount} skipped). Generating: ${fieldLabels}`,
      });
    } else {
      sendToUI({
        type: 'status',
        message: `Found ${imageNodes.length} image(s). Generating: ${fieldLabels}`,
      });
    }

    // Ensure annotation categories exist
    sendToUI({ type: 'status', message: 'Setting up annotation categories...' });
    const categoryIds = await ensureCategories(fields);

    // Send category info to UI for display
    const categoryInfo: Record<string, { label: string; color: string }> = {};
    for (const field of fields) {
      const config = FIELD_CONFIGS[field];
      categoryInfo[field] = { label: config.categoryLabel, color: config.categoryColor };
    }
    sendToUI({ type: 'categories', categories: categoryInfo });

    // Build node map for result matching
    const nodeMap = new Map<string, SceneNode>();
    for (const node of imageNodes) {
      nodeMap.set(node.id, node);
    }

    // Export images as PNG bytes
    const base64Images: string[] = [];
    const fileNames: string[] = [];
    const nodeInfos: ImageNodeInfo[] = [];

    for (let i = 0; i < imageNodes.length; i++) {
      const node = imageNodes[i];

      sendToUI({
        type: 'progress',
        current: i + 1,
        total: imageNodes.length,
        phase: 'exporting',
      });

      try {
        const bytes = await exportNodeAsPng(node);
        const base64 = figma.base64Encode(bytes);
        base64Images.push(base64);
        fileNames.push(node.id);
        nodeInfos.push({
          nodeId: node.id,
          nodeName: node.name,
          width: Math.round(node.width),
          height: Math.round(node.height),
        });
      } catch (err) {
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
    const fieldResponses = await submitAndPollAllFields(
      settings.apiKey,
      base64Images,
      fileNames,
      settings,
      fields
    );

    // Parse results and group by node
    const nodeResultMap = new Map<string, NodeResult>();

    // Initialize entries for all exported nodes
    for (const info of nodeInfos) {
      const node = nodeMap.get(info.nodeId);
      nodeResultMap.set(info.nodeId, {
        nodeId: info.nodeId,
        nodeName: info.nodeName,
        hasExistingAnnotation: node ? nodeHasAnnotations(node) : false,
        fields: [],
      });
    }

    // Process responses for each field
    for (const [field, response] of fieldResponses) {
      if (!response.assets) continue;

      for (const asset of response.assets) {
        const nodeId = asset.file_name;
        if (!nodeId) continue;

        const nodeResult = nodeResultMap.get(nodeId);
        if (!nodeResult) continue;

        let description = '';
        let backendName = settings.backend;

        if (asset.descriptions && asset.descriptions.length > 0) {
          description = asset.descriptions[0].text || '';
          backendName = asset.descriptions[0].backend || settings.backend;
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
    const results: NodeResult[] = [];
    for (const nodeResult of nodeResultMap.values()) {
      if (nodeResult.fields.length > 0) {
        results.push(nodeResult);
      }
    }

    if (results.length === 0) {
      sendToUI({
        type: 'error',
        message: 'The API returned no descriptions. Try a different model or check your API credits.',
      });
      return;
    }

    // Send results to UI for preview
    sendToUI({
      type: 'results',
      results: results,
      totalImages: imageNodes.length,
      skippedCount: skippedCount,
      fields: fields,
    });
  } catch (err: any) {
    const message = err?.message || String(err);
    sendToUI({
      type: 'error',
      message: message,
    });
  }
}

// ============================================================================
// Message Handler
// ============================================================================

figma.ui.onmessage = async (msg: UIMessage) => {
  switch (msg.type) {
    case 'load-settings': {
      const settings = await loadSettings();
      sendToUI({ type: 'settings', settings });
      break;
    }

    case 'save-settings': {
      await saveSettings(msg.settings);
      sendToUI({ type: 'status', message: 'Settings saved.' });
      break;
    }

    case 'generate': {
      await generateForFields(msg.source, msg.fields, msg.overwrite || false);
      break;
    }

    case 'apply-field': {
      try {
        const node = figma.getNodeById(msg.nodeId) as SceneNode | null;
        if (!node) {
          sendToUI({
            type: 'error',
            message: `Node not found: ${msg.nodeId}. It may have been deleted.`,
          });
          break;
        }
        const categoryIds = await ensureCategories([msg.field]);
        await writeFieldAnnotation(node, msg.field, msg.description, categoryIds);
        setRelaunchOnNode(node);
        sendToUI({
          type: 'field-applied',
          nodeId: msg.nodeId,
          field: msg.field,
        });
        const label = FIELD_CONFIGS[msg.field].categoryLabel;
        figma.notify(`${label} applied to "${node.name}".`);
      } catch (err: any) {
        sendToUI({
          type: 'error',
          message: `Failed to apply: ${err?.message || err}`,
        });
      }
      break;
    }

    case 'apply-node': {
      try {
        const node = figma.getNodeById(msg.nodeId) as SceneNode | null;
        if (!node) {
          sendToUI({
            type: 'error',
            message: `Node not found: ${msg.nodeId}. It may have been deleted.`,
          });
          break;
        }
        const fieldTypes = msg.fields.map(f => f.field);
        const categoryIds = await ensureCategories(fieldTypes);
        await writeMultipleFieldAnnotations(node, msg.fields, categoryIds);
        setRelaunchOnNode(node);

        for (const f of msg.fields) {
          sendToUI({
            type: 'field-applied',
            nodeId: msg.nodeId,
            field: f.field,
          });
        }

        const count = msg.fields.length;
        figma.notify(
          `${count} annotation${count !== 1 ? 's' : ''} applied to "${node.name}".`
        );
      } catch (err: any) {
        sendToUI({
          type: 'error',
          message: `Failed to apply: ${err?.message || err}`,
        });
      }
      break;
    }

    case 'apply-all': {
      let applied = 0;
      let failed = 0;

      // Collect all field types we need categories for
      const allFieldTypes = new Set<FieldType>();
      for (const nodeData of msg.nodes) {
        for (const f of nodeData.fields) {
          allFieldTypes.add(f.field);
        }
      }
      const categoryIds = await ensureCategories([...allFieldTypes]);

      for (const nodeData of msg.nodes) {
        try {
          const node = figma.getNodeById(nodeData.nodeId) as SceneNode | null;
          if (!node) {
            failed++;
            continue;
          }
          await writeMultipleFieldAnnotations(node, nodeData.fields, categoryIds);
          setRelaunchOnNode(node);

          for (const f of nodeData.fields) {
            sendToUI({
              type: 'field-applied',
              nodeId: nodeData.nodeId,
              field: f.field,
            });
          }
          applied++;
        } catch {
          failed++;
        }
      }

      const parts: string[] = [];
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
  }
};

// ============================================================================
// Plugin Entry Point
// ============================================================================

/**
 * Show the plugin UI panel and send initial settings.
 */
async function showPluginUI(command?: string): Promise<void> {
  figma.showUI(__html__, {
    width: 380,
    height: 600,
    themeColors: true,
    title: 'Visionati',
  });

  // Send initial settings to UI
  const settings = await loadSettings();
  sendToUI({ type: 'settings', settings });

  // If launched with a specific command, tell the UI
  if (command && command !== 'settings') {
    sendToUI({ type: 'auto-generate', source: command as 'selection' | 'all-images' });
  }
}

// Handle plugin run from menu commands
figma.on('run', async ({ command }: RunEvent) => {
  switch (command) {
    case 'selection':
    case 'all-images':
    case 'settings':
      await showPluginUI(command);
      break;
    default:
      await showPluginUI();
      break;
  }
});