'use strict';
const https   = require('https');
const fs      = require('fs');
const path    = require('path');
const xml2js  = require('xml2js');
const config  = require('./config');

// ─── Module-level running flag ────────────────────────────────────────────────
let _running = false;
function isEngineRunning() { return _running; }

// ─── Season detection ─────────────────────────────────────────────────────────
function getCurrentSeason() {
  const month = new Date().getMonth(); // 0-indexed
  if (month >= 2 && month <= 4) return 'spring';  // Mar–May
  if (month >= 5 && month <= 7) return 'summer';  // Jun–Aug
  if (month >= 8 && month <= 10) return 'autumn'; // Sep–Nov
  return 'winter';                                 // Dec–Feb
}

// ─── Template file reader ─────────────────────────────────────────────────────
function getTemplate(season) {
  const file = path.join(__dirname, 'templates', `${season}.html`);
  return fs.readFileSync(file, 'utf8');
}

// ─── Strip old season wrapper from a description ─────────────────────────────
// Four cases:
//   1. Contains <!-- PRODUCT_CONTENT --> → engine-generated template, no real
//      product content exists yet. Return empty string.
//   2. Contains <div class="season-strip"> but NOT <!-- PRODUCT_CONTENT --> →
//      older manually-built template. Strip header + illus-banner, strip from
//      <div class="security-notice"> to end. Return what's in between.
//   3. Contains SyraBargains / old-2015 template markers → strip CSS/header
//      down to after the "Item Description" section header, and strip from
//      the first Payment/Shipping/Return/Feedback/copyright section onwards.
//   4. Neither → plain description, return unchanged.
function stripOldTemplate(description) {
  // Case 1 — new engine-generated template: no real product content yet
  if (description.includes('<!-- PRODUCT_CONTENT -->')) {
    return '';
  }

  // Case 3 — old 2015 SyraBargains charcoal/orange template
  const OLD_TEMPLATE_MARKERS = ['Thank You for visiting', 'SyraBargains', 'Items for sale'];
  if (OLD_TEMPLATE_MARKERS.some(m => description.includes(m))) {
    // Find content start: after "Item Description" header + its spacer div.
    // Limit the SPACER search to 300 chars so it can't accidentally land on
    // a later spacer inside the Payment/Shipping sections.
    const ITEM_DESC  = 'Item Description';
    const SPACER     = 'height:15px;"></div>';
    const itemDescIdx = description.indexOf(ITEM_DESC);
    let contentStart = 0;
    if (itemDescIdx !== -1) {
      const rawSpacerIdx = description.indexOf(SPACER, itemDescIdx);
      const spacerIdx = (rawSpacerIdx !== -1 && rawSpacerIdx - itemDescIdx <= 300)
        ? rawSpacerIdx : -1;
      contentStart = spacerIdx !== -1 ? spacerIdx + SPACER.length : itemDescIdx + ITEM_DESC.length;
    }

    // Find content end: earliest of Payment / Shipping / Return / Feedback section
    // headers or the copyright footer. Walk back to nearest '<' to avoid
    // clipping mid-tag.
    const BOTTOM_MARKERS = [
      '<b>Payment</b>', '<b><font size="4">Payment',   // various encodings
      '>Payment<',
      '<b>Shipping</b>', '<b><font size="4">Shipping',
      '>Shipping<',
      '<b>Return</b>', '<b><font size="4">Return',
      '>Return<',
      '<b>Feedback</b>', '<b><font size="4">Feedback',
      '>Feedback<',
      'Thank You for visiting',
      '<div class="othercontent"',        // SyraBargains section separator (Payment, Shipping, etc.)
      'We accept payment only through',   // PayPal boilerplate line
    ];
    let contentEnd = description.length;
    for (const marker of BOTTOM_MARKERS) {
      const idx = description.indexOf(marker, contentStart);
      if (idx !== -1 && idx < contentEnd) {
        // Walk back to the start of the enclosing tag
        let tagStart = idx;
        while (tagStart > contentStart && description[tagStart] !== '<') tagStart--;
        contentEnd = tagStart;
      }
    }

    return stripBoilerplate(description.slice(contentStart, contentEnd)).trim();
  }

  // Case 4 — no template at all
  if (!description.includes('<div class="season-strip">')) {
    return description;
  }

  // Case 2 — older manually-built template
  // Find the boundary between the illus-banner block and the wrap div
  const WRAP_BOUNDARY  = '</div>\n\n<div class="wrap">';
  const SECURITY_OPEN  = '<div class="security-notice">';

  const boundaryIdx = description.indexOf(WRAP_BOUNDARY);
  if (boundaryIdx === -1) {
    // Boundary not found — fall back to returning everything after the
    // season-strip closing div
    const seasonOpen = description.indexOf('<div class="season-strip">');
    let depth = 0, i = seasonOpen, len = description.length;
    while (i < len) {
      if (description.startsWith('<div', i) && /[\s>]/.test(description[i + 4] || '')) {
        depth++; i += 4;
      } else if (description.startsWith('</div>', i)) {
        depth--;
        if (depth === 0) { i += 6; break; }
        i += 6;
      } else { i++; }
    }
    const secIdx = description.indexOf(SECURITY_OPEN, i);
    const raw = description.slice(i, secIdx === -1 ? description.length : secIdx);
    return stripBoilerplate(raw).trim();
  }

  // productStart = just after the </div>\n\n boundary, at the opening of <div class="wrap">
  // We want the content INSIDE the wrap, so step past <div class="wrap"> itself.
  const afterBoundary = boundaryIdx + WRAP_BOUNDARY.length;
  // afterBoundary now points to the first char inside <div class="wrap">

  const securityIdx = description.indexOf(SECURITY_OPEN, afterBoundary);
  const productEnd  = securityIdx === -1 ? description.length : securityIdx;

  const raw = description.slice(afterBoundary, productEnd);
  return stripBoilerplate(raw).trim();
}

// Strip store boilerplate (listing info / trust row etc.) from extracted product content.
// These markers always belong to the template, never to the product itself.
function stripBoilerplate(content) {
  const BOILERPLATE_MARKERS = [
    '<div class="info-grid"',
    '<div class="trust-row"',
    '<p class="section-label">Listing info',
    '<!-- ── LISTING INFO',
    // Old SyraBargains cross-sell / store-nav sections — these floated divs
    // are never closed properly and break the layout if left in
    '<div class="othercontent"',
    '<div class="othercontentL"',
    'class="othercontentR"',
    // Payment boilerplate — must be stripped regardless of position
    'We accept payment only through',
  ];
  let cutAt = content.length;
  for (const marker of BOILERPLATE_MARKERS) {
    const idx = content.indexOf(marker);
    if (idx !== -1 && idx < cutAt) cutAt = idx;
  }
  return content.slice(0, cutAt);
}

// ─── RRP extraction ───────────────────────────────────────────────────────────
function extractRRP(title, description) {
  const plain = description.replace(/<[^>]+>/g, ' ');
  const text  = title + ' ' + plain;

  // Priority: explicit RRP/Was/Retail label first, then any bare £ price
  const patterns = [
    /RRP\s*:?\s*£\s*(\d+(?:\.\d{1,2})?)/i,
    /Was\s*:?\s*£\s*(\d+(?:\.\d{1,2})?)/i,
    /Retail\s*:?\s*£\s*(\d+(?:\.\d{1,2})?)/i,
    /£\s*(\d+(?:\.\d{1,2})?)/,
  ];

  for (const re of patterns) {
    const m = text.match(re);
    if (m) return `£${m[1]}`;
  }
  return null;
}

// Balance excess trailing </div> tags caused by mid-HTML cuts
function balanceDivs(html) {
  const opens  = (html.match(/<div[\s>]/gi) || []).length;
  const closes = (html.match(/<\/div>/gi) || []).length;
  const excess = closes - opens;
  if (excess <= 0) return html;
  let result = html;
  for (let i = 0; i < excess; i++) {
    const last = result.lastIndexOf('</div>');
    if (last === -1) break;
    result = result.slice(0, last) + result.slice(last + 6);
  }
  return result.trimEnd();
}

// ─── Wrap raw/unstructured product content ────────────────────────────────────
// Detects whether the content already has v6 template structure. If not,
// wraps it in a styled div, converts <font face> tags to <span>, and strips
// font-family overrides from inline styles (preserving bold, italic, size, color).
function wrapRawContent(html) {
  if (!html) return html;

  // Already structured — leave untouched
  const STRUCTURE_MARKERS = ['class="section-label"', 'class="detail-item"',
                              'class="item-title"', 'class="meta-row"'];
  if (STRUCTURE_MARKERS.some(m => html.includes(m))) return html;

  // Convert <font face="..."> to <span> (drop face attr, keep others)
  let clean = html.replace(/<font\b([^>]*)>/gi, (_, attrs) => {
    const stripped = attrs.replace(/\s*face\s*=\s*(?:"[^"]*"|'[^']*'|\S+)/gi, '').trim();
    return stripped ? `<span ${stripped}>` : '<span>';
  }).replace(/<\/font>/gi, '</span>');

  // Remove font-family from inline styles, preserve everything else
  clean = clean.replace(/style\s*=\s*"([^"]*)"/gi, (_, s) => {
    const kept = s.split(';')
      .map(p => p.trim())
      .filter(p => p && !/^font-family/i.test(p))
      .join('; ');
    return kept ? `style="${kept}"` : '';
  });

  return `<div style="font-size:15px;line-height:1.7;color:inherit;padding:8px 0;">${balanceDivs(clean)}</div>`;
}

// ─── Template injection ───────────────────────────────────────────────────────
// title + originalDesc are used for RRP detection.
// conditionLabel (e.g. "Pre-owned") is optional — omitted from bulk runs.
function injectTemplate(template, productContent, title = '', originalDesc = '', conditionLabel = '') {
  let result = template;

  const rrp = extractRRP(title, originalDesc);
  if (rrp) {
    result = result
      .replace('<!-- RRP_VALUE -->', rrp)
      .replace('<!-- RRP_START -->', '')
      .replace('<!-- RRP_END -->', '');
  } else {
    result = result.replace(/<!-- RRP_START -->[\s\S]*?<!-- RRP_END -->/g, '');
  }

  if (conditionLabel) {
    result = result
      .replace('<!-- CONDITION_VALUE -->', conditionLabel)
      .replace('<!-- CONDITION_START -->', '')
      .replace('<!-- CONDITION_END -->', '');
  } else {
    result = result.replace(/<!-- CONDITION_START -->[\s\S]*?<!-- CONDITION_END -->/g, '');
  }

  result = result.replace('<!-- PRODUCT_CONTENT -->', productContent);
  return result;
}

// ─── eBay HTTP helper ─────────────────────────────────────────────────────────
function ebayRequest(callName, xmlBody) {
  return new Promise((resolve, reject) => {
    const buf  = Buffer.from(xmlBody, 'utf8');
    const url  = new URL(config.endpoint);

    const req = https.request({
      hostname: url.hostname,
      path:     url.pathname,
      method:   'POST',
      timeout:  60000,
      headers: {
        'Content-Type':                       'text/xml',
        'X-EBAY-API-COMPATIBILITY-LEVEL':     config.compatLevel,
        'X-EBAY-API-DEV-NAME':                config.devId,
        'X-EBAY-API-APP-NAME':                config.appId,
        'X-EBAY-API-CERT-NAME':               config.certId,
        'X-EBAY-API-CALL-NAME':               callName,
        'X-EBAY-API-SITEID':                  config.siteId,
        'Content-Length':                      buf.length,
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve(data));
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    req.write(buf);
    req.end();
  });
}

function parseXml(xml) {
  return new Promise((resolve, reject) => {
    xml2js.parseString(xml, { explicitArray: false }, (err, result) => {
      if (err) reject(err); else resolve(result);
    });
  });
}

function decodeXmlEntities(str = '') {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

// Extract items using regex — safer than xml2js for HTML-inside-XML descriptions
function extractItemsFromXml(xml) {
  const items = [];
  const itemRe = /<Item>([\s\S]*?)<\/Item>/g;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const chunk  = m[1];
    const itemId = (chunk.match(/<ItemID>(.*?)<\/ItemID>/) || [])[1];
    if (!itemId) continue;

    const title = decodeXmlEntities((chunk.match(/<Title>(.*?)<\/Title>/) || [])[1] || '');

    let description = '';
    const cdataM = chunk.match(/<Description><!\[CDATA\[([\s\S]*?)\]\]><\/Description>/);
    if (cdataM) {
      description = cdataM[1];
    } else {
      const plainM = chunk.match(/<Description>([\s\S]*?)<\/Description>/);
      if (plainM) description = decodeXmlEntities(plainM[1]);
    }

    items.push({ itemId, title, description });
  }
  return items;
}

// ─── GetSellerList (single page) ──────────────────────────────────────────────
async function getSellerListPage(startTime, endTime, page) {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<GetSellerListRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${config.token}</eBayAuthToken></RequesterCredentials>
  <DetailLevel>ReturnAll</DetailLevel>
  <Pagination>
    <EntriesPerPage>${config.itemsPerPage}</EntriesPerPage>
    <PageNumber>${page}</PageNumber>
  </Pagination>
  <StartTimeFrom>${startTime}</StartTimeFrom>
  <StartTimeTo>${endTime}</StartTimeTo>
  <IncludeDescription>true</IncludeDescription>
</GetSellerListRequest>`;

  const raw    = await ebayRequest('GetSellerList', xml);
  const parsed = await parseXml(raw).catch(() => null);
  const resp   = parsed?.GetSellerListResponse;

  if (!resp) throw new Error('Could not parse GetSellerList response');

  if (resp.Ack === 'Failure') {
    const errs = [].concat(resp.Errors || []);
    throw new Error(errs.map(e => e.ShortMessage || e.LongMessage).join('; ') || 'GetSellerList failed');
  }

  const hasMore    = resp.HasMoreItems === 'true';
  const totalPages = parseInt(resp.PaginationResult?.TotalNumberOfPages || '1', 10);
  const items      = extractItemsFromXml(raw);

  return { items, hasMore, totalPages };
}

// ─── Fetch ALL listings (paginated, up to fetchWindowDays back) ───────────────
async function fetchAllListings(logger = console.log) {
  const allItems = new Map(); // itemId → item (deduplicates across date windows)
  const now      = new Date();

  // Walk backwards in 120-day windows until we've covered fetchWindowDays
  // (for GTC listings — they renew monthly so one 120-day window normally suffices)
  const windowMs = config.fetchWindowDays * 24 * 60 * 60 * 1000;
  let windowEnd  = new Date(now);
  let windowStart = new Date(now.getTime() - windowMs);

  let windowIndex = 0;
  const maxWindows = 1; // increase in config if you have very old GTC listings

  while (windowIndex < maxWindows) {
    const from = windowStart.toISOString();
    const to   = windowEnd.toISOString();
    logger(`  Fetching window ${windowIndex + 1}: ${from.slice(0,10)} → ${to.slice(0,10)}`);

    let page = 1;
    let totalPages = 1;

    do {
      const result = await getSellerListPage(from, to, page);
      result.items.forEach(item => allItems.set(item.itemId, item));
      totalPages = result.totalPages;
      logger(`    Page ${page}/${totalPages} — ${result.items.length} items (running total: ${allItems.size})`);
      page++;
      if (result.items.length > 0) {
        await sleep(config.requestDelayMs);
      }
    } while (page <= totalPages);

    windowEnd   = new Date(windowStart.getTime() - 1);
    windowStart = new Date(windowEnd.getTime() - windowMs);
    windowIndex++;
  }

  return Array.from(allItems.values());
}

// ─── ReviseItem ───────────────────────────────────────────────────────────────
async function updateListing(itemId, newDescription) {
  // Escape any ]]> sequences that would break CDATA
  const safeDesc = newDescription.replace(/]]>/g, ']]]]><![CDATA[>');

  const xml = `<?xml version="1.0" encoding="utf-8"?>
<ReviseItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${config.token}</eBayAuthToken></RequesterCredentials>
  <Item>
    <ItemID>${itemId}</ItemID>
    <Description><![CDATA[${safeDesc}]]></Description>
  </Item>
</ReviseItemRequest>`;

  const raw    = await ebayRequest('ReviseItem', xml);
  const parsed = await parseXml(raw).catch(() => null);
  const resp   = parsed?.ReviseItemResponse;

  if (!resp) throw new Error('Could not parse ReviseItem response');
  if (resp.Ack === 'Failure') {
    const errs = [].concat(resp.Errors || []);
    throw new Error(errs.map(e => e.ShortMessage || e.LongMessage).join('; ') || 'ReviseItem failed');
  }

  return true;
}

// ─── Utilities ────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Main engine runner ───────────────────────────────────────────────────────
async function runSeasonEngine(season, logger = console.log) {
  if (_running) throw new Error('Engine is already running');
  _running = true;

  const result = { season, total: 0, updated: 0, errors: 0, errorItems: [] };

  try {
    logger(`Starting season engine for: ${season}`);

    const template = getTemplate(season);
    logger(`Template loaded: templates/${season}.html`);

    logger('Fetching all listings…');
    const listings = await fetchAllListings(logger);
    result.total   = listings.length;
    logger(`Total listings fetched: ${result.total}`);

    if (result.total === 0) {
      logger('No listings found — nothing to update.');
      return result;
    }

    for (let i = 0; i < listings.length; i++) {
      const { itemId, title, description } = listings[i];

      try {
        const productContent = stripOldTemplate(description);
        const newDesc        = injectTemplate(template, productContent, title, description);
        await updateListing(itemId, newDesc);
        result.updated++;
      } catch (err) {
        result.errors++;
        result.errorItems.push({ itemId, title, error: err.message });
        logger(`  ERROR [${itemId}] ${title.slice(0, 50)}: ${err.message}`);
      }

      if ((i + 1) % 10 === 0 || i + 1 === listings.length) {
        logger(`Updated ${i + 1}/${result.total} — OK: ${result.updated}, Errors: ${result.errors}`);
      }

      if (i + 1 < listings.length) await sleep(config.requestDelayMs);
    }

    logger(`Done. ${result.updated} updated, ${result.errors} errors.`);

    // Persist last run result
    const runRecord = { ...result, timestamp: new Date().toISOString() };
    fs.writeFileSync(path.join(__dirname, 'lastRun.json'), JSON.stringify(runRecord, null, 2));

    return runRecord;

  } finally {
    _running = false;
  }
}

// ─── Fetch a single listing via GetItem ──────────────────────────────────────
async function fetchSingleItem(itemId) {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${config.token}</eBayAuthToken></RequesterCredentials>
  <ItemID>${itemId}</ItemID>
  <DetailLevel>ReturnAll</DetailLevel>
  <IncludeItemSpecifics>true</IncludeItemSpecifics>
</GetItemRequest>`;

  const raw    = await ebayRequest('GetItem', xml);
  const parsed = await parseXml(raw).catch(() => null);
  const resp   = parsed?.GetItemResponse;

  if (!resp) throw new Error('Could not parse GetItem response');
  if (resp.Ack === 'Failure') {
    const errs = [].concat(resp.Errors || []);
    throw new Error(errs.map(e => e.ShortMessage || e.LongMessage).join('; ') || 'GetItem failed');
  }

  const title          = decodeXmlEntities(resp.Item?.Title || '');
  const conditionLabel = decodeXmlEntities(resp.Item?.ConditionDisplayName || '');

  // Extract Size from ItemSpecifics NameValueList
  let sizeLabel = '';
  const specifics = resp.Item?.ItemSpecifics?.NameValueList;
  if (specifics) {
    const list = Array.isArray(specifics) ? specifics : [specifics];
    const sizeSpec = list.find(s => /^(size|uk size|us size|eu size|eur size|shoe size)$/i.test((s.Name || '').trim()));
    if (sizeSpec) {
      const rawVal = decodeXmlEntities(String(sizeSpec.Value || '').trim());
      // If value is bare numeric (e.g. "14"), try to extract the richer size string from the title
      // e.g. title contains "SIZE UK 14" → use "UK 14"
      if (/^\d+$/.test(rawVal)) {
        const titleSize = title.match(/\bsize\s+((?:uk|us|eu|eur)\s+\d+(?:[./]\d+)?|\d+(?:[./]\d+)?|xs|s|m|l|xl|xxl|xxxl)\b/i);
        sizeLabel = titleSize ? titleSize[1].replace(/\s+/g, ' ').trim() : rawVal;
      } else {
        sizeLabel = rawVal;
      }
    }
  }

  let description = '';
  const cdataM = raw.match(/<Description><!\[CDATA\[([\s\S]*?)\]\]><\/Description>/);
  if (cdataM) {
    description = cdataM[1];
  } else {
    const plainM = raw.match(/<Description>([\s\S]*?)<\/Description>/);
    if (plainM) description = decodeXmlEntities(plainM[1]);
  }

  return { itemId, title, description, conditionLabel, sizeLabel };
}

// ─── Dry-run test for a single listing ───────────────────────────────────────
async function testSingleListing(itemId) {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${config.token}</eBayAuthToken></RequesterCredentials>
  <ItemID>${itemId}</ItemID>
  <DetailLevel>ReturnAll</DetailLevel>
  <IncludeItemSpecifics>true</IncludeItemSpecifics>
</GetItemRequest>`;

  const raw    = await ebayRequest('GetItem', xml);
  const parsed = await parseXml(raw).catch(() => null);
  const resp   = parsed?.GetItemResponse;

  if (!resp) throw new Error('Could not parse GetItem response');
  if (resp.Ack === 'Failure') {
    const errs = [].concat(resp.Errors || []);
    throw new Error(errs.map(e => e.ShortMessage || e.LongMessage).join('; ') || 'GetItem failed');
  }

  // Extract title and description safely (description may be HTML — use regex)
  const title = decodeXmlEntities(resp.Item?.Title || '');

  let description = '';
  const cdataM = raw.match(/<Description><!\[CDATA\[([\s\S]*?)\]\]><\/Description>/);
  if (cdataM) {
    description = cdataM[1];
  } else {
    const plainM = raw.match(/<Description>([\s\S]*?)<\/Description>/);
    if (plainM) description = decodeXmlEntities(plainM[1]);
  }

  console.log('\n─────────────────────────────────────────────');
  console.log('ITEM TITLE:');
  console.log(title);

  console.log('\nORIGINAL DESCRIPTION (first 300 chars):');
  console.log(description.slice(0, 300));

  const productContent = stripOldTemplate(description);
  console.log('\nAFTER stripOldTemplate() (first 300 chars):');
  console.log(productContent.slice(0, 300));

  const season   = getCurrentSeason();
  const template = getTemplate(season);
  console.log(`\nCURRENT SEASON: ${season}`);
  console.log(`TEMPLATE: templates/${season}.html (${template.length} chars)`);

  const finalHtml = injectTemplate(template, productContent, title, description);
  console.log('\nFINAL INJECTED HTML (first 300 chars):');
  console.log(finalHtml.slice(0, 300));

  const outPath = path.join(__dirname, 'test_output.html');
  fs.writeFileSync(outPath, finalHtml, 'utf8');
  console.log(`\nFull output saved to: ${outPath} (${finalHtml.length} chars)`);
  console.log('─────────────────────────────────────────────\n');

  return { title, description, productContent, season, finalHtml };
}

// ─── Size extraction from AI output ──────────────────────────────────────────
// Scans the meas-table rows from the AI HTML output.
// Returns the value of the first row whose key is a clothing/shoe size label,
// or null if none found.
function extractSizeFromAiOutput(aiHtml) {
  const rows = [...aiHtml.matchAll(/<tr[^>]*>\s*<td[^>]*>(.*?)<\/td>\s*<td[^>]*>(.*?)<\/td>/gi)];
  for (const [, keyRaw, valRaw] of rows) {
    const key = keyRaw.replace(/<[^>]+>/g, '').trim();
    if (/^(size|uk|eur|eu|us|shoe)$/i.test(key)) {
      return valRaw.replace(/<[^>]+>/g, '').trim();
    }
  }
  return null;
}

// ─── Anthropic API call ───────────────────────────────────────────────────────
const ANTHROPIC_SYSTEM_PROMPT = `You are reformatting a secondhand fashion listing description into structured HTML sections.

KEY RULE: Preserve wording exactly — do NOT rephrase, summarise, or add anything. The one allowed exception is MATERIALS: if the composition facts (fibre percentages, Shell/Lining/Care lines) appear embedded inside a longer sentence, extract just the composition part verbatim for MATERIALS and put the surrounding sentence in ABOUT THIS PIECE.

Output only raw HTML. No markdown fences, no explanation, no preamble.
Do not add any font-family, font-size, or color styles to any element.

You MUST output ALL FIVE sections in EXACTLY this order — no exceptions. Never skip a section. If you have no content for a section, output a single dash (—) as a placeholder. Do not add any sections not listed here.

1. <div class="section-block"> ABOUT THIS PIECE
2. <div class="section-block"> DETAILS
3. <div class="section-block"> MATERIALS
4. <div class="condition-note">
5. <div class="section-block"> MEASUREMENTS

Between each section, output exactly: <div class="divider"></div>

Use this exact structure:

<div class="section-block">
  <div class="section-label">ABOUT THIS PIECE</div>
  <p class="product-intro">[intro paragraph(s) — the opening descriptive text, or — if none]</p>
</div>

<div class="divider"></div>

<div class="section-block">
  <div class="section-label">DETAILS</div>
  <ul class="detail-list">
    <li class="detail-item"><span class="detail-icon">✿</span>[feature bullet, or — if none]</li>
  </ul>
</div>

<div class="divider"></div>

<div class="section-block">
  <div class="section-label">MATERIALS</div>
  <ul class="detail-list">
    <li class="detail-item"><span class="detail-icon">✿</span>[material line, or — if none]</li>
  </ul>
</div>

<div class="divider"></div>

<div class="condition-note">[condition text Suzi wrote about the item's physical state, or — if none]</div>

<div class="divider"></div>

<div class="section-block">
  <div class="section-label">MEASUREMENTS</div>
  <table class="meas-table">
    <tr><td>[label]</td><td>[value]</td></tr>
  </table>
</div>

Rules:
- ABOUT THIS PIECE: the opening style/narrative sentences about what the item is, its aesthetic, and any storytelling sentences about the material's origin, properties, or craftsmanship. Basically: full sentences that a copywriter wrote about the item or its materials. Example: "This is a special blend of Manteco wool, featuring 70% post-consumer recycled wool." and "Hand-blended by artisans at a mill in Prato, Italy…" both belong here. If a sentence introduces the composition (e.g. "This is a heavy weight outerwear fabric from Manteco made of :") put that sentence in ABOUT THIS PIECE too — the bare percentages that follow go to MATERIALS.
- DETAILS: feature/style bullets (neckline, closure, lining, pockets, construction details). Also country of manufacture (e.g. "Sustainably made in Vietnam").
- MATERIALS: ONLY the raw composition facts extracted verbatim — fibre percentages (e.g. "70% Recycled Wool® / 12% Recycled Polyamide / 18% Polyamide"), Shell/Lining/Care label lines. Not full narrative sentences — those go in ABOUT THIS PIECE. If no materials info exists, output a single list item containing —.
- condition-note: only Suzi's own words about the physical condition of this specific item (e.g. "light pilling", "worn once", "small mark on sleeve"). If there is no condition text, output: <div class="condition-note">—</div>
- MEASUREMENTS: physical measurements only (shoulder to shoulder, armpit to armpit, armpit to cuff, shoulder to hem, waist, bust, etc.). Do NOT include size label rows — no "Size", "UK Size", "US Size", "EU Size" rows; size is shown separately in the pill above. Do NOT include any "Approx measurements" header or "All measurements were taken" note — those are added automatically. If no measurements exist, output: <tr><td>—</td><td>—</td></tr>
- Each piece of content appears in exactly one section — never duplicate.
- If content doesn't fit any category, put it in DETAILS.
- Preserve all asterisks, colons, capitalisation, punctuation exactly as in the original.
- Do not include RRP lines — those are handled separately by the engine.`;

function callAnthropicApi(rawText) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      system: ANTHROPIC_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: rawText }],
    });

    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.anthropicApiKey,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 60000,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error(parsed.error.message || 'Anthropic API error'));
          if (!parsed.content || !parsed.content[0]) return reject(new Error('Empty response from Anthropic API'));
          resolve(parsed.content[0].text);
        } catch (e) {
          reject(new Error(`Failed to parse Anthropic response: ${e.message}`));
        }
      });
    });

    req.on('timeout', () => { req.destroy(); reject(new Error('Anthropic API request timed out')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Clean up all-caps eBay title for display: title-case, strip *RRP suffix and trailing size/sold-out suffixes
function formatDisplayTitle(title) {
  let t = title.toLowerCase();
  // Strip trailing RRP / sold-out suffixes
  t = t.replace(/\s*\*?rrp\s*£[\d.]+.*/i, '');
  t = t.replace(/\s*-\s*sold\s*out\s*online\s*$/i, '');
  // Strip trailing size patterns (applied in order from most specific to least)
  const sizePatterns = [
    /\s+size\s+(?:uk|us|eu|eur)\s*\d+(?:[./]\d+)?\s*$/i,
    /\s+size\s+\d+(?:[./]\d+)?\s*$/i,
    /\s+size\s+(?:xs|s|m|l|xl|xxl|xxxl)\s*$/i,
    /\s+(?:uk|eu|eur|us)\s+\d+(?:[./]\d+)?\s*$/i,
  ];
  for (const re of sizePatterns) {
    t = t.replace(re, '');
  }
  return t.trim().replace(/\b\w/g, c => c.toUpperCase());
}

const MEASUREMENTS_NOTE = '( All measurements were taken across the garment while laid flat )';

async function aiMigrateSingleListing(itemId) {
  const season   = getCurrentSeason();
  const template = getTemplate(season);
  const listing  = await fetchSingleItem(String(itemId));
  const { title, description, conditionLabel, sizeLabel } = listing;

  const rawContent = stripOldTemplate(description);

  // Strip HTML tags; remove measurements header/note so the AI never sees it
  let plainText = rawContent.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  plainText = plainText
    .replace(/approx\.?\s*measurements\s*:?/gi, '')
    .replace(/all measurements were taken across the garment while laid flat/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  let aiText = await callAnthropicApi(plainText);
  aiText = aiText.trim();
  if (aiText.startsWith('```html')) aiText = aiText.slice(7);
  if (aiText.startsWith('```')) aiText = aiText.slice(3);
  if (aiText.endsWith('```')) aiText = aiText.slice(0, -3);
  aiText = aiText.trim();

  // Remove any meas-note the AI added; append fixed measurements note after every </table>
  aiText = aiText.replace(/<p class="meas-note">[\s\S]*?<\/p>/gi, '');
  aiText = aiText.replace(
    /<\/table>/gi,
    `</table>\n  <p class="measurements-note">${MEASUREMENTS_NOTE}</p>`
  );

  // Fix 4: condition-note fallback — if AI output placeholder "—", replace with eBay condition label
  if (conditionLabel) {
    aiText = aiText.replace(
      /<div class="condition-note">\s*—\s*<\/div>/i,
      `<div class="condition-note">${conditionLabel}</div>`
    );
  }

  // Build title-block with item-title + meta-row (size → condition → rrp)
  // matching v5 template structure exactly
  const displayTitle = formatDisplayTitle(title);
  const rrp          = extractRRP(title, description);
  let metaItems = '';
  if (sizeLabel)      metaItems += `<span class="pill pill-size">${sizeLabel}</span>`;
  if (conditionLabel) metaItems += `<span class="pill pill-cond">${conditionLabel}</span>`;
  if (rrp)            metaItems += `<span class="rrp">RRP ${rrp}</span>`;

  const titleBlock = [
    '<div class="title-block">',
    `  <h2 class="item-title">${displayTitle}</h2>`,
    `  <div class="meta-row">${metaItems}</div>`,
    '</div>',
  ].join('\n');

  const aiStructured = `${titleBlock}\n${aiText}`;

  // Inject template — RRP/condition/size placeholders still processed for standard pipeline;
  // their output in the top meta-row is then stripped below
  let finalHtml = injectTemplate(template, aiStructured, title, description, conditionLabel);

  // Remove the template's standalone top meta-row — the title-block in content has its own
  finalHtml = finalHtml.replace(
    /\s*<div class="meta-row" style="margin:8px 0 4px;">[\s\S]*?<\/div>/,
    ''
  );

  fs.writeFileSync(path.join(__dirname, 'test_output.html'), finalHtml, 'utf8');

  return {
    success:        true,
    itemId:         String(itemId),
    title,
    originalLength: description.length,
    finalLength:    finalHtml.length,
    finalHtml,
  };
}

module.exports = {
  getCurrentSeason,
  getTemplate,
  stripOldTemplate,
  wrapRawContent,
  injectTemplate,
  fetchSingleItem,
  fetchAllListings,
  updateListing,
  runSeasonEngine,
  isEngineRunning,
  testSingleListing,
  aiMigrateSingleListing,
};
