// Image provider: raster generation for the design stations, used only when the operator
// configures it (OUTPOST_IMAGE_PROVIDER=openai + OPENAI_API_KEY). The API key stays in this
// closure; it is never logged, put in events, or echoed in errors.

export const OPENAI_IMAGES_URL = 'https://api.openai.com/v1/images/generations';
// GPT Image 2 (snapshot gpt-image-2-2026-04-21), per the model list in OpenAI's official SDK
// (github.com/openai/openai-node, src/resources/images.ts). Override with OUTPOST_IMAGE_MODEL.
export const DEFAULT_IMAGE_MODEL = 'gpt-image-2';
export const IMAGE_QUALITY = 'medium';

// Estimated USD per image at quality "medium", by model and size, from OpenAI's image pricing
// (https://developers.openai.com/api/docs/pricing; OpenAI bills image generation by tokens, these
// are its published per-image equivalents). Unknown model/size -> null: the spend event then
// records $0 with detail 'price unknown' rather than a guess.
const PRICE_PER_IMAGE_USD = {
  'gpt-image-2': { '1024x1024': 0.053, '1536x1024': 0.041, '1024x1536': 0.041 },
  'gpt-image-1.5': { '1024x1024': 0.034, '1536x1024': 0.05, '1024x1536': 0.05 },
  'gpt-image-1': { '1024x1024': 0.042, '1536x1024': 0.063, '1024x1536': 0.063 },
};

/**
 * Per-image cost estimate for the quality Outpost requests.
 * @returns {number|null}
 */
export function estimateImageCostUsd(model, size) {
  const base = String(model).replace(/-\d{4}-\d{2}-\d{2}$/, ''); // dated snapshots share the alias price
  return PRICE_PER_IMAGE_USD[base]?.[size] ?? null;
}

/** Identify PNG/JPEG/WebP by magic bytes; the API's output_format is trusted only after this check. */
export function sniffImageMime(buf) {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function apiErrorMessage(text) {
  try {
    return JSON.parse(text)?.error?.message || text;
  } catch {
    return text;
  }
}

/**
 * @param {{provider:string|null, model:string|null, apiKey:string|null}|null|undefined} config config.image
 * @param {{fetchImpl?: typeof fetch}} [deps]
 * @returns {null|{name:string, model:string, generate:(req:{prompt:string, size:string}) =>
 *   Promise<{buffer:Buffer, mime:string, requestId:string|null, estimatedCostUsd:number|null}>}}
 *   null when no provider is configured (or its key is missing)
 */
export function createImageProvider(config, { fetchImpl = fetch } = {}) {
  if (!config?.provider || !config.apiKey) return null;
  if (config.provider !== 'openai') throw new Error(`unsupported image provider "${config.provider}" (supported: openai)`);
  const { apiKey } = config;
  const model = config.model || DEFAULT_IMAGE_MODEL;
  const redact = (s) => String(s).split(apiKey).join('[redacted]');

  return {
    name: 'openai',
    model,
    async generate({ prompt, size }) {
      const res = await fetchImpl(OPENAI_IMAGES_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, prompt, size, quality: IMAGE_QUALITY, n: 1, output_format: 'png' }),
      });
      const requestId = res.headers?.get?.('x-request-id') ?? null;
      const text = await res.text();
      if (!res.ok) throw new Error(redact(`OpenAI images API HTTP ${res.status}: ${apiErrorMessage(text).slice(0, 300)}`));
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        throw new Error('OpenAI images API returned a non-JSON response');
      }
      const b64 = body?.data?.[0]?.b64_json;
      if (typeof b64 !== 'string' || !b64) throw new Error('OpenAI images API response has no data[0].b64_json');
      const buffer = Buffer.from(b64, 'base64');
      const mime = sniffImageMime(buffer);
      if (!mime) throw new Error('OpenAI images API returned bytes that are not a PNG, JPEG or WebP image');
      return { buffer, mime, requestId, estimatedCostUsd: estimateImageCostUsd(model, size) };
    },
  };
}
