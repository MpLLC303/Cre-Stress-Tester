// Recipes: named multi-stage workflows the operator (or a schedule) can launch.
//
// A stage runs when the stages listed in `after` are done (default: the previous stage; [] for
// the first). Briefs open with labelled `Key: "value"` lines so both models and the offline
// scripts read the parameters the same way, and every brief carries the originality rule and
// says which artifact the stage must produce.

export const ORIGINALITY_RULE =
  'Originality rule: research produces themes and patterns, never copies. Do not reproduce or imitate any specific ' +
  "existing design, artwork, wording, character, logo or trademark, and do not tell a teammate to copy a competitor's work.";

const MAX_PARAM_CHARS = 200;

function brief(fields, body, produce) {
  const head = Object.entries(fields).map(([k, v]) => `${k}: "${v}"`).join('\n');
  return [head, body, ORIGINALITY_RULE, `Produce: ${produce}`].filter(Boolean).join('\n\n');
}

/**
 * @type {Record<string, {title:string, description:string, params:Record<string,string>,
 *   stages:Array<{agent:string, title:string, brief:(params:object)=>string, after?:number[]}>}>}
 */
export const RECIPES = {
  pod_listing: {
    title: 'Print-on-demand listing',
    description: 'Research a niche, design an original typography print, write an Etsy listing draft, then the commander reviews it and requests publication (operator-approved; a dry run unless Etsy is connected).',
    params: { niche: 'botanical typography sweatshirts', audience: 'women 25-40 who garden' },
    stages: [
      {
        agent: 'nova',
        title: 'Research niche',
        brief: (p) => brief(
          { Niche: p.niche, Audience: p.audience },
          'Research demand for this print-on-demand niche: recurring themes and motifs, typography styles, palettes, price bands for comparable items (cite sources), and gaps. Describe patterns across many listings, not any single listing. Propose one original working headline phrase of 2-4 words.',
          'a markdown research brief saved with write_file, containing the themes, a price band with sources, 10-15 candidate tags of at most 20 characters, and a line formatted exactly as: Working headline: "<phrase>".',
        ),
      },
      {
        agent: 'pixel',
        title: 'Design original artwork',
        brief: (p) => brief(
          { Niche: p.niche, Audience: p.audience },
          'Using the research brief in your inputs, create one original typography-first apparel design built around its working headline. Print-ready: transparent background, 4500x5400 viewBox, no external fonts or images.',
          'one svg artifact via render_svg_design, with notes on palette, garment colours and print preparation.',
        ),
      },
      {
        agent: 'quill',
        title: 'Write listing draft',
        after: [0, 1],
        brief: (p) => brief(
          { Niche: p.niche, Audience: p.audience },
          'Write an Etsy listing for the design in your inputs, using the research brief for tags and price. Keep every claim truthful; disclose AI assistance; explain why the design is original.',
          'one listing_draft artifact via create_listing_draft (title within 140 characters, up to 13 tags of at most 20 characters, price within the researched band).',
        ),
      },
      {
        agent: 'orion',
        title: 'Review listing and request publication',
        brief: (p) => brief(
          { Niche: p.niche, Audience: p.audience },
          'Review the listing draft and its design against the research brief: originality, truthful copy, Etsy limits, AI disclosure. If it passes, delegate publication to the agent who wrote the draft (the Production Bay holds the publish gate); publishing pauses for operator approval and is a dry run unless an Etsy connector is configured. If it fails, delegate a revision with specific fixes.',
          'a delegated publish (or revision) task and a short review summary; the bridge writes no files.',
        ),
      },
    ],
  },

  thumbnail_order: {
    title: 'Thumbnail order',
    description: 'Turn a client thumbnail order into a spec, draft and score three variants, package the winner, then the commander reviews it and requests a manual delivery (operator-approved).',
    params: { video_title: 'I Survived 7 Days in a Cabin During a Blizzard', order_ref: 'DEMO-ORDER-1', style: 'dramatic, high contrast' },
    stages: [
      {
        agent: 'vega',
        title: 'Order intake',
        brief: (p) => brief(
          { 'Order ref': p.order_ref, 'Video title': p.video_title, Style: p.style },
          'Turn this order into a production spec: two or three on-image text options of 2-3 words, focal subject, emotion, palette, composition notes, and legibility requirements at small sizes. Deliverable: 1280x720 thumbnails.',
          'a markdown intake spec saved with write_file, including a line formatted as: Text options: "<A>" | "<B>" | "<C>".',
        ),
      },
      {
        agent: 'flux',
        title: 'Design, score and package',
        brief: (p) => brief(
          { 'Order ref': p.order_ref, 'Video title': p.video_title, Style: p.style },
          'Using the intake spec in your inputs, draft three distinct 1280x720 thumbnail variants (bold 2-3 word text, high contrast, different compositions), score each for small-size legibility, contrast and hook clarity, and package the winner with the scorecard.',
          `three svg artifacts via render_svg_design, a markdown scorecard via write_file, and one package via package_deliverable whose notes include the line Order ref: ${p.order_ref}.`,
        ),
      },
      {
        agent: 'orion',
        title: 'Review package and request delivery',
        brief: (p) => brief(
          { 'Order ref': p.order_ref, 'Video title': p.video_title },
          'Review the package against the intake spec and the order. If it passes, delegate delivery to the agent who packaged it (the Output Studio holds the delivery gate), quoting the order ref; delivery pauses for operator approval and is a manual hand-off because Fiverr has no seller API. If it fails, delegate a revision with specific fixes.',
          'a delegated delivery (or revision) task and a short review summary; the bridge writes no files.',
        ),
      },
    ],
  },

  competitor_scan: {
    title: 'Competitor scan',
    description: 'Demand and competitor research in parallel, then a commander synthesis of opportunities.',
    params: { market: 'YouTube thumbnail design gigs' },
    stages: [
      {
        agent: 'nova',
        title: 'Demand scan',
        after: [],
        brief: (p) => brief(
          { Market: p.market },
          'Scan buyer demand in this market: what buyers search for and order, recurring requests, price bands and turnaround expectations, with sources.',
          'a markdown demand brief saved with write_file.',
        ),
      },
      {
        agent: 'vega',
        title: 'Competitor scan',
        after: [],
        brief: (p) => brief(
          { Market: p.market },
          'Study how sellers in this market position their offers: tiers, pricing, turnaround, revisions, quality bar, and gaps. Describe patterns across many sellers; never single out one seller\'s work to copy.',
          'a markdown competitor brief saved with write_file.',
        ),
      },
      {
        agent: 'orion',
        title: 'Opportunity synthesis',
        after: [0, 1],
        brief: (p) => brief(
          { Market: p.market },
          'Synthesize the demand brief and the competitor brief into the top three opportunities, positioning, prices to test, risks, and which room should act next. Base every point on the briefs and mark anything unverified.',
          'the synthesis as your final summary reply (the bridge writes no files).',
        ),
      },
    ],
  },

  ledger_report: {
    title: 'Ledger report',
    description: 'Sync connectors and report revenue strictly by provenance.',
    params: {},
    stages: [
      {
        agent: 'tally',
        title: 'Ledger report',
        brief: () => brief(
          {},
          'Sync configured connectors (if none is configured, say so), then read the ledger and report revenue strictly by provenance: verified (connector), operator-entered, and agent claims (never counted). Include evidence coverage, runtime spend today and in total, and any gap between claims and verified data. Never estimate or invent figures.',
          'a ledger report note saved with memory_write under the key ledger-report, summarized in your reply (Ops has no workbench, so no file artifact).',
        ),
      },
    ],
  },
};

/** Stage dependencies with the default applied: the previous stage, or none for the first. */
export function stageAfter(stage, index) {
  return stage.after ?? (index === 0 ? [] : [index - 1]);
}

/**
 * Resolve a recipe run: merge params over defaults and render every stage.
 * @param {string} name
 * @param {Record<string, string>} [params]
 * @returns {{name:string, title:string, params:Record<string,string>,
 *   stages:Array<{index:number, agent:string, title:string, brief:string, after:number[]}>}}
 * @throws {Error} on an unknown recipe or invalid params
 */
export function planRecipe(name, params = {}) {
  const recipe = Object.hasOwn(RECIPES, name) ? RECIPES[name] : null;
  if (!recipe) throw new Error(`unknown recipe "${name}" (available: ${Object.keys(RECIPES).join(', ')})`);
  if (params === null || typeof params !== 'object' || Array.isArray(params)) throw new Error('params must be an object');
  const merged = { ...recipe.params };
  for (const [key, value] of Object.entries(params)) {
    if (!Object.hasOwn(recipe.params, key)) throw new Error(`recipe ${name} has no param "${key}"`);
    if (typeof value !== 'string' || !value.trim() || value.length > MAX_PARAM_CHARS || /[\r\n]/.test(value)) {
      throw new Error(`param "${key}" must be a single-line string of 1-${MAX_PARAM_CHARS} characters`);
    }
    merged[key] = value.trim();
  }
  const detail = Object.values(merged)[0];
  return {
    name,
    title: detail ? `${recipe.title}: ${detail}` : recipe.title,
    params: merged,
    stages: recipe.stages.map((stage, index) => ({
      index,
      agent: stage.agent,
      title: stage.title,
      brief: stage.brief(merged),
      after: stageAfter(stage, index),
    })),
  };
}
