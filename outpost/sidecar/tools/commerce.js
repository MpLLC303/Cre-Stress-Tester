// Commerce tools: Etsy-shaped listing drafts, publishing (approval-gated, draft-only or dry run),
// and client deliveries (approval-gated, always a manual hand-off: Fiverr has no seller API).
// Every publish receipt carries BEFORE_ACTIVATION: Outpost never activates a listing, and the
// "How it's made" / AI disclosure is a Shop Manager step because Etsy's API does not expose it.

import { basename } from 'node:path';
import { checkArtifactIds, loadArtifact, saveArtifact } from './files.js';

export const ETSY_WHEN_MADE = ['made_to_order', '2020_2026', '2010_2019', '2007_2009', 'before_2007'];
/** Etsy's who_made values: "I did", "Another company or person", "A member of my shop". */
export const ETSY_WHO_MADE = ['i_did', 'someone_else', 'collective'];
export const ETSY_LIMITS = { titleMax: 140, tagsMax: 13, tagMax: 20, priceMinUsd: 0.2, priceMaxUsd: 50000, quantityMax: 999, productionPartnersMax: 10 };
export const DRY_RUN_NOTE = 'Nothing was sent to any marketplace. Configure ETSY_* env vars to create real Etsy drafts.';
export const SVG_NOT_UPLOADABLE = 'Etsy does not accept SVG listing images: rasterize designs to PNG or JPEG before upload.';
export const PARTNER_GUIDANCE = "For print-on-demand or anything made by a production partner, Etsy's reported guidance is to declare that partner on the listing (production_partner_ids); re-verify on etsy.com.";

/**
 * What every publish receipt (dry run or Etsy draft) tells the operator. The AI / "How it's made"
 * disclosure is not exposed by Etsy's API, so it can only be set by a person in Shop Manager.
 */
export const BEFORE_ACTIVATION = Object.freeze([
  'Outpost only ever creates Etsy listings as DRAFTS and never activates them: activation is a manual step in Etsy Shop Manager.',
  "Before activating, set Etsy's \"How it's made\" / AI-generator disclosure in Shop Manager: Etsy's API does not expose that field, so Outpost cannot set it.",
  'SVG designs must be rasterized to PNG or JPEG before upload: Etsy does not accept SVG listing images.',
  `Check "who made it" and the production partner match how the item is really produced. ${PARTNER_GUIDANCE}`,
]);

/**
 * create_listing_draft tool text and the maker fields of its input schema (tools/index.js builds
 * the tool from these). The schema stays strict-compatible: nullable fields are type unions with
 * null and are listed in `required` like every other property.
 */
export const LISTING_DRAFT_DESCRIPTION = `Validate and save an Etsy-shaped listing draft (artifact kind listing_draft); nothing is published. Etsy limits are enforced (title up to ${ETSY_LIMITS.titleMax} characters; 1-${ETSY_LIMITS.tagsMax} tags of up to ${ETSY_LIMITS.tagMax} characters using letters, numbers, spaces, hyphens and apostrophes, no ™©®; price at least $${ETSY_LIMITS.priceMinUsd.toFixed(2)}; quantity 1-${ETSY_LIMITS.quantityMax}; is_supply false), and an AI-assistance disclosure, an originality note and at least one svg or image design artifact are required. who_made must state truthfully who makes the item; for print-on-demand made by a production partner, Etsy's reported guidance is to declare that partner in production_partner_ids (re-verify on etsy.com), and production_partner_ids is null when there is none or the id is unknown.`;
export const LISTING_MAKER_PROPERTIES = {
  who_made: {
    type: 'string',
    enum: ETSY_WHO_MADE,
    description: 'Who makes the item, as Etsy asks it: "i_did" (I did), "collective" (a member of my shop), "someone_else" (another company or person).',
  },
  production_partner_ids: {
    type: ['array', 'null'],
    description: "Etsy production partner ids (the shop's production partners, set up in Shop Manager) for whoever produces the item, e.g. a print-on-demand provider; null if none or unknown.",
    items: { type: 'integer', description: 'Production partner id.', minimum: 1 },
    maxItems: ETSY_LIMITS.productionPartnersMax,
  },
};
const FIVERR_MANUAL = 'manual delivery required: Fiverr has no seller API';
const DESIGN_KINDS = ['svg', 'image'];
const UPLOADABLE_MIME = ['image/png', 'image/jpeg'];

const TAG_CHARS = /^[\p{L}\p{N} '-]+$/u;
const TRADEMARK_SYMBOLS = /[™©®]/;

function listingProblems(input) {
  const problems = [];
  const title = input.title.trim();
  if (!title) problems.push('title is empty');
  if (title.length > ETSY_LIMITS.titleMax) problems.push(`title is ${title.length} characters; Etsy allows ${ETSY_LIMITS.titleMax}`);
  if (!input.description.trim()) problems.push('description is empty');

  const tags = input.tags.map((t) => t.trim());
  if (tags.length < 1 || tags.length > ETSY_LIMITS.tagsMax) problems.push(`provide 1 to ${ETSY_LIMITS.tagsMax} tags (got ${tags.length})`);
  const seen = new Set();
  for (const tag of tags) {
    if (!tag) problems.push('tags may not be empty');
    else if (tag.length > ETSY_LIMITS.tagMax) problems.push(`tag "${tag}" is ${tag.length} characters; Etsy allows ${ETSY_LIMITS.tagMax}`);
    else if (TRADEMARK_SYMBOLS.test(tag)) problems.push(`tag "${tag}" contains ™, © or ®, which Etsy tags do not allow`);
    else if (!TAG_CHARS.test(tag)) problems.push(`tag "${tag}" may only contain letters, numbers, spaces, hyphens and apostrophes`);
    if (seen.has(tag.toLowerCase())) problems.push(`tag "${tag}" is duplicated`);
    seen.add(tag.toLowerCase());
  }

  if (!(input.price_usd >= ETSY_LIMITS.priceMinUsd && input.price_usd <= ETSY_LIMITS.priceMaxUsd)) {
    problems.push(`price_usd must be between ${ETSY_LIMITS.priceMinUsd.toFixed(2)} and ${ETSY_LIMITS.priceMaxUsd} (Etsy limits)`);
  }
  if (!Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > ETSY_LIMITS.quantityMax) {
    problems.push(`quantity must be a whole number from 1 to ${ETSY_LIMITS.quantityMax}`);
  }
  if (!ETSY_WHEN_MADE.includes(input.when_made)) problems.push(`when_made must be one of ${ETSY_WHEN_MADE.join(', ')}`);
  if (!ETSY_WHO_MADE.includes(input.who_made)) problems.push(`who_made must be one of ${ETSY_WHO_MADE.join(', ')}`);
  const partners = input.production_partner_ids;
  if (partners != null) {
    if (!Array.isArray(partners)) problems.push('production_partner_ids must be an array of Etsy production partner ids, or null');
    else {
      if (partners.length > ETSY_LIMITS.productionPartnersMax) problems.push(`at most ${ETSY_LIMITS.productionPartnersMax} production_partner_ids`);
      if (partners.some((id) => !Number.isSafeInteger(id) || id < 1)) problems.push('production_partner_ids must be positive whole numbers (Etsy production partner ids)');
      if (new Set(partners).size !== partners.length) problems.push('production_partner_ids has duplicates');
    }
  }
  if (!input.ai_disclosure.trim()) problems.push('ai_disclosure is required: say truthfully how AI assisted');
  if (!input.originality_note.trim()) problems.push('originality_note is required: say why the design is original');
  if (input.artifact_ids.length < 1) problems.push('attach at least one design (svg or image artifact)');
  return problems;
}

/** create_listing_draft: validate against Etsy's limits and store an Etsy-shaped draft. */
export async function createListingDraft(input, ctx) {
  const problems = listingProblems(input);
  const badArtifact = checkArtifactIds(ctx, input.artifact_ids, DESIGN_KINDS);
  if (badArtifact) problems.push(badArtifact);
  if (problems.length) return { ok: false, output: `listing draft rejected:\n- ${problems.join('\n- ')}` };

  const draft = {
    schema: 'outpost.listing_draft/1',
    marketplace: 'etsy',
    title: input.title.trim(),
    description: input.description.trim(),
    tags: input.tags.map((t) => t.trim()),
    price_usd: Math.round(input.price_usd * 100) / 100,
    quantity: input.quantity,
    who_made: input.who_made,
    production_partner_ids: input.production_partner_ids?.length ? [...input.production_partner_ids] : null,
    when_made: input.when_made,
    is_supply: false,
    artifact_ids: input.artifact_ids,
    ai_disclosure: input.ai_disclosure.trim(),
    originality_note: input.originality_note.trim(),
    created_by: ctx.agent.id,
  };
  const art = saveArtifact(ctx, {
    kind: 'listing_draft',
    title: `Listing draft: ${draft.title}`,
    filename: 'listing-draft.json',
    content: JSON.stringify(draft, null, 2),
  });
  const output = {
    artifact_id: art.artifactId,
    title: draft.title,
    tags: draft.tags.length,
    price_usd: draft.price_usd,
    who_made: draft.who_made,
    production_partner_ids: draft.production_partner_ids,
    note: 'Draft only. Publishing needs the publish gate and operator approval.',
  };
  if (!draft.production_partner_ids) output.partner_note = `No production partner declared. ${PARTNER_GUIDANCE}`;
  return { ok: true, output, artifactIds: [art.artifactId] };
}

function readJsonArtifact(ctx, id, kind) {
  const meta = ctx.store.state.artifacts[id];
  if (!meta) throw new Error(`unknown artifact ${id}`);
  if (meta.kind !== kind) throw new Error(`artifact ${id} is a ${meta.kind}, not a ${kind}`);
  return JSON.parse(loadArtifact(ctx, id).content.toString('utf8'));
}

/**
 * The fields Etsy receives: the AI disclosure is part of the buyer-visible description.
 * Drafts saved before who_made became an input carry 'i_did' and no partners.
 */
function etsyPayload(draft) {
  const description = draft.description.includes(draft.ai_disclosure)
    ? draft.description
    : `${draft.description}\n\n${draft.ai_disclosure}`;
  const payload = {
    title: draft.title,
    description,
    price: draft.price_usd,
    quantity: draft.quantity,
    who_made: draft.who_made,
    when_made: draft.when_made,
    is_supply: draft.is_supply,
    tags: draft.tags,
  };
  if (Array.isArray(draft.production_partner_ids) && draft.production_partner_ids.length) payload.production_partner_ids = draft.production_partner_ids;
  return payload;
}

const BEFORE_ACTIVATION_SHORT = "Outpost never activates it; before activating in Shop Manager, set Etsy's \"How it's made\" / AI disclosure there (not in the API) and rasterize any SVG design to PNG/JPEG.";

export const HALTED_NOT_UPLOADED = 'not uploaded: the run was halted (E-STOP or cancel) before this upload started';

async function uploadImages(ctx, etsy, listingId, artifactIds) {
  const uploaded = [];
  const skipped = [];
  for (const id of artifactIds) {
    // A halted run starts no new outbound request; the draft that already exists is still recorded.
    if (ctx.signal?.aborted) {
      skipped.push({ artifact_id: id, reason: HALTED_NOT_UPLOADED });
      continue;
    }
    const meta = ctx.store.state.artifacts[id];
    if (!UPLOADABLE_MIME.includes(meta?.mime)) {
      skipped.push({ artifact_id: id, reason: meta?.kind === 'svg' ? SVG_NOT_UPLOADABLE : `${meta?.mime ?? 'unknown'} is not a PNG or JPEG` });
      continue;
    }
    try {
      const { content } = loadArtifact(ctx, id);
      const { imageId } = await etsy.uploadListingImage(listingId, content, basename(meta.path), { signal: ctx.signal });
      uploaded.push({ artifact_id: id, listing_image_id: imageId });
    } catch (err) {
      skipped.push({ artifact_id: id, reason: `upload failed: ${err.message}` });
    }
  }
  return { uploaded, skipped };
}

/** publish_listing: Etsy draft (never activated) when the connector is configured, else a labelled dry run. */
export async function publishListing(input, ctx) {
  const draft = readJsonArtifact(ctx, input.draft_artifact_id, 'listing_draft');
  const payload = etsyPayload(draft);
  const etsy = ctx.connectors?.etsy;
  let receipt;
  let output;
  if (etsy?.configured) {
    const { listingId, url } = await etsy.createDraftListing(payload, { signal: ctx.signal });
    // From here the draft exists on Etsy: whatever happens next, the receipt below is written.
    const images = await uploadImages(ctx, etsy, listingId, draft.artifact_ids);
    receipt = {
      mode: 'etsy_draft',
      listingId,
      url,
      state: 'draft',
      draft_artifact_id: input.draft_artifact_id,
      ...(ctx.signal?.aborted ? { halted: 'the run was halted after the draft was created: remaining image uploads were skipped' } : {}),
      images,
      note: `Created as an Etsy DRAFT listing; it is not live until you add anything missing (images, shipping, returns) and activate it yourself in Shop Manager. ${SVG_NOT_UPLOADABLE}`,
      before_activation: [...BEFORE_ACTIVATION],
    };
    output = `Created Etsy DRAFT listing ${listingId} (not active): ${url}. Uploaded ${images.uploaded.length} image(s); ${images.skipped.length} skipped. The operator activates it in Etsy Shop Manager: ${BEFORE_ACTIVATION_SHORT}`;
  } else {
    receipt = {
      mode: 'dry_run',
      draft_artifact_id: input.draft_artifact_id,
      note: DRY_RUN_NOTE,
      would_send: payload,
      design_artifact_ids: draft.artifact_ids,
      image_note: SVG_NOT_UPLOADABLE,
      before_activation: [...BEFORE_ACTIVATION],
    };
    output = `DRY RUN: ${DRY_RUN_NOTE} With the connector configured this would create an Etsy DRAFT listing: ${BEFORE_ACTIVATION_SHORT}`;
  }
  receipt.recorded_by = ctx.agent.id;
  const art = saveArtifact(ctx, {
    kind: 'publish_receipt',
    title: `${receipt.mode === 'dry_run' ? 'Dry-run receipt' : 'Etsy draft receipt'}: ${draft.title}`,
    filename: 'publish-receipt.json',
    content: JSON.stringify(receipt, null, 2),
  });
  return { ok: true, output: `${output} Receipt: ${art.artifactId}.`, artifactIds: [art.artifactId] };
}

function verifiedFile(ctx, id) {
  const { meta } = loadArtifact(ctx, id); // throws on a missing file or sha256 mismatch
  return { artifact_id: id, kind: meta.kind, title: meta.title, path: meta.path, mime: meta.mime, sha256: meta.sha256, bytes: meta.bytes };
}

/** package_deliverable: a manifest of verified files (sha256 re-checked on disk). */
export async function packageDeliverable(input, ctx) {
  if (!input.artifact_ids.length) return { ok: false, output: 'a package needs at least one artifact' };
  const bad = checkArtifactIds(ctx, input.artifact_ids);
  if (bad) return { ok: false, output: bad };
  const files = input.artifact_ids.map((id) => verifiedFile(ctx, id));
  const manifest = {
    schema: 'outpost.package/1',
    title: input.title,
    notes: input.notes,
    packaged_by: ctx.agent.id,
    files,
    total_bytes: files.reduce((n, f) => n + f.bytes, 0),
    paths_relative_to: 'the Outpost data directory',
  };
  const art = saveArtifact(ctx, { kind: 'package', title: input.title, filename: 'package.json', content: JSON.stringify(manifest, null, 2) });
  return { ok: true, output: { artifact_id: art.artifactId, files: files.length, total_bytes: manifest.total_bytes }, artifactIds: [art.artifactId] };
}

/** deliver_order: an operator hand-off sheet; nothing is sent anywhere. */
export async function deliverOrder(input, ctx) {
  const manifest = readJsonArtifact(ctx, input.package_artifact_id, 'package');
  const files = manifest.files.map((f) => verifiedFile(ctx, f.artifact_id));
  const sheet = {
    schema: 'outpost.delivery/1',
    order_ref: input.order_ref,
    platform: 'fiverr',
    status: FIVERR_MANUAL,
    package_artifact_id: input.package_artifact_id,
    message_to_buyer: input.message,
    files,
    paths_relative_to: 'the Outpost data directory (or download each artifact from the station UI)',
    steps: [
      `Open order ${input.order_ref} on Fiverr and choose Deliver Now.`,
      'Attach every file listed here. Export SVG files to PNG or JPG at their native size first: thumbnails and marketplaces do not take SVG.',
      'Check each file against its sha256 if it was copied around.',
      'Paste message_to_buyer, review it, and submit the delivery.',
    ],
    prepared_by: ctx.agent.id,
  };
  const art = saveArtifact(ctx, {
    kind: 'delivery',
    title: `Delivery hand-off: ${input.order_ref}`,
    filename: 'delivery-handoff.json',
    content: JSON.stringify(sheet, null, 2),
  });
  return {
    ok: true,
    output: `Manual delivery required: Fiverr has no seller API, so nothing was sent. Hand-off sheet ${art.artifactId} lists ${files.length} verified file(s) and the message to paste for order ${input.order_ref}.`,
    artifactIds: [art.artifactId],
  };
}
