// Design station tools: vector designs (always available) and raster images (only when an image
// provider is configured; every generated image is recorded as spend so budgets see it).

import { estimateImageCostUsd } from '../images.js';
import { sanitizeSvg } from '../svg.js';
import { saveArtifact } from './files.js';

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'design';
const xmlEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Keep the designer's notes inside the file as <desc>, so they travel with the design. */
function withNotes(svg, notes) {
  if (!notes.trim()) return svg;
  const at = svg.match(/^(?:\s|<\?xml[^>]*\?>|<!--[\s\S]*?-->)*<svg\b[^>]*>/)[0].length;
  return `${svg.slice(0, at)}<desc>${xmlEscape(notes)}</desc>${svg.slice(at)}`;
}

export const IMAGE_PROVIDER_HELP =
  'No image provider is configured, so nothing was generated. To enable raster images set OUTPOST_IMAGE_PROVIDER=openai, ' +
  'OPENAI_API_KEY, and optionally OUTPOST_IMAGE_MODEL, then restart the sidecar. Use render_svg_design for vector designs meanwhile.';

/** render_svg_design: sanitize an SVG and store it as an artifact of kind svg. */
export async function renderSvgDesign(input, ctx) {
  const clean = sanitizeSvg(input.svg);
  if (!clean.ok) return { ok: false, output: `svg rejected: ${clean.reason}` };
  const svg = withNotes(clean.svg, input.notes);
  const art = saveArtifact(ctx, { kind: 'svg', title: input.title, filename: `${slug(input.title)}.svg`, content: svg });
  return { ok: true, output: { artifact_id: art.artifactId, title: art.title, bytes: art.bytes, sha256: art.sha256 }, artifactIds: [art.artifactId] };
}

/** generate_image: call the image provider, record the spend, store the image as an artifact. */
export async function generateImage(input, ctx) {
  const provider = ctx.imageProvider;
  if (!provider) return { ok: false, output: IMAGE_PROVIDER_HELP };
  // Refuse before paying: the run or station budget is already spent (ctx.budgetBlock, loop.js).
  const blocked = ctx.budgetBlock?.();
  if (blocked) return { ok: false, output: `not generated, budget exceeded: ${blocked}` };
  const estimate = estimateImageCostUsd(provider.model, input.size);
  const room = ctx.budgetRemainingUsd?.();
  if (estimate !== null && Number.isFinite(room) && estimate > room) {
    return { ok: false, output: `not generated: this image costs about $${estimate.toFixed(3)}, more than the $${Math.max(0, room).toFixed(3)} left in the run and station budgets` };
  }
  const img = await provider.generate({ prompt: input.prompt, size: input.size, signal: ctx.signal });
  // Spend first: the money is gone once the API answered, even if storing the file fails.
  const priced = typeof img.estimatedCostUsd === 'number';
  ctx.store.append('spend.recorded', {
    agentId: ctx.agent.id,
    runId: ctx.runId,
    category: 'image',
    model: provider.model,
    usd: priced ? img.estimatedCostUsd : 0,
    detail: priced ? `estimate for one ${input.size} image` : 'price unknown',
  }, ctx.agent.id);
  const ext = img.mime === 'image/jpeg' ? 'jpg' : img.mime === 'image/webp' ? 'webp' : 'png';
  const art = saveArtifact(ctx, { kind: 'image', title: input.title, filename: `image.${ext}`, content: img.buffer, mime: img.mime });
  return {
    ok: true,
    output: {
      artifact_id: art.artifactId,
      title: art.title,
      mime: art.mime,
      bytes: art.bytes,
      model: provider.model,
      estimated_cost_usd: priced ? img.estimatedCostUsd : null,
    },
    artifactIds: [art.artifactId],
  };
}
