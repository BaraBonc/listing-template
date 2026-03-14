'use strict';
const express = require('express');
const fs      = require('fs');
const path    = require('path');
const config  = require('./config');
const engine  = require('./engine');

// Boot the scheduler (registers cron jobs, no side effects on require)
require('./scheduler');

const app = express();
app.use(express.json());

// In-memory log buffer for the currently-running engine pass
let currentLogs = [];

// In-memory store for the last successful AI-migrate result (single item)
let lastAiMigrate = null; // { itemId, title, finalHtml }

// ─── Routes ───────────────────────────────────────────────────────────────────

// Serve the dashboard
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard', 'index.html'));
});

// Serve dry-run test output
app.get('/test-output', (req, res) => {
  const f = path.join(__dirname, 'test_output.html');
  if (!fs.existsSync(f)) return res.status(404).send('No test output yet — run test-single.js first.');
  res.sendFile(f);
});

// GET /status — current season, running flag, log buffer, last run info
app.get('/status', (req, res) => {
  let lastRun = null;
  try {
    lastRun = JSON.parse(fs.readFileSync(path.join(__dirname, 'lastRun.json'), 'utf8'));
  } catch (_) { /* no run yet */ }

  res.json({
    isRunning:     engine.isEngineRunning(),
    currentSeason: engine.getCurrentSeason(),
    logs:          engine.isEngineRunning() ? currentLogs : [],
    lastRun,
  });
});

// POST /preview-single — full pipeline but NO ReviseItem; saves to test_output.html
app.post('/preview-single', async (req, res) => {
  const { itemId } = req.body || {};
  if (!itemId || !/^\d+$/.test(String(itemId))) {
    return res.status(400).json({ success: false, error: 'Invalid or missing itemId' });
  }

  try {
    const season   = engine.getCurrentSeason();
    const template = engine.getTemplate(season);
    const listing  = await engine.fetchSingleItem(String(itemId));
    const { title, description, conditionLabel } = listing;

    const rawContent     = engine.stripOldTemplate(description);
    const productContent = engine.wrapRawContent(rawContent);
    const finalHtml      = engine.injectTemplate(template, productContent, title, description, conditionLabel);

    fs.writeFileSync(path.join(__dirname, 'test_output.html'), finalHtml, 'utf8');

    console.log(`[preview-single] Preview saved for ${itemId} — ${title} [${conditionLabel || 'no condition'}]`);
    res.json({
      success: true,
      itemId:        String(itemId),
      title,
      conditionLabel,
      originalLength: description.length,
      finalLength:    finalHtml.length,
    });
  } catch (err) {
    console.error(`[preview-single] Error for ${itemId}: ${err.message}`);
    res.status(500).json({ success: false, itemId: String(itemId), error: err.message });
  }
});

// POST /ai-migrate-single — AI-assisted migration via Anthropic: reformat content into v6 sections
app.post('/ai-migrate-single', async (req, res) => {
  const { itemId } = req.body || {};
  if (!itemId || !/^\d+$/.test(String(itemId))) {
    return res.status(400).json({ success: false, error: 'Invalid or missing itemId' });
  }
  if (!config.anthropicApiKey) {
    return res.status(500).json({ success: false, error: 'ANTHROPIC_API_KEY is not configured on the server' });
  }

  try {
    const result = await engine.aiMigrateSingleListing(String(itemId));
    lastAiMigrate = { itemId: result.itemId, title: result.title, finalHtml: result.finalHtml };
    console.log(`[ai-migrate-single] AI migration saved for ${itemId} — ${result.title}`);
    res.json(result);
  } catch (err) {
    console.error(`[ai-migrate-single] Error for ${itemId}: ${err.message}`);
    res.status(500).json({ success: false, itemId: String(itemId), error: err.message });
  }
});

// POST /ai-migrate-publish — publish the last AI-migrated result via ReviseItem
app.post('/ai-migrate-publish', async (req, res) => {
  const { itemId } = req.body || {};
  if (!itemId || !/^\d+$/.test(String(itemId))) {
    return res.status(400).json({ success: false, error: 'Invalid or missing itemId' });
  }
  if (!lastAiMigrate) {
    return res.status(400).json({ success: false, error: 'No AI migration result stored — run AI Migrate first' });
  }
  if (lastAiMigrate.itemId !== String(itemId)) {
    return res.status(400).json({ success: false, error: `Preview is for item ${lastAiMigrate.itemId}, not ${itemId} — run AI Migrate first` });
  }

  try {
    await engine.updateListing(String(itemId), lastAiMigrate.finalHtml);
    console.log(`[ai-migrate-publish] Published ${itemId} — ${lastAiMigrate.title}`);
    res.json({ success: true, itemId: String(itemId), title: lastAiMigrate.title });
  } catch (err) {
    console.error(`[ai-migrate-publish] Error for ${itemId}: ${err.message}`);
    res.status(500).json({ success: false, itemId: String(itemId), error: err.message });
  }
});

// POST /test-single — run the full pipeline on one listing and update it
app.post('/test-single', async (req, res) => {
  const { itemId } = req.body || {};
  if (!itemId || !/^\d+$/.test(String(itemId))) {
    return res.status(400).json({ success: false, error: 'Invalid or missing itemId' });
  }
  if (engine.isEngineRunning()) {
    return res.status(409).json({ success: false, error: 'Full engine run is in progress — try again after it finishes.' });
  }

  try {
    const season   = engine.getCurrentSeason();
    const template = engine.getTemplate(season);

    // Fetch the single listing via GetItem
    const listing = await engine.fetchSingleItem(String(itemId));
    const { title, description, conditionLabel } = listing;

    const rawContent     = engine.stripOldTemplate(description);
    const productContent = engine.wrapRawContent(rawContent);
    const newDesc        = engine.injectTemplate(template, productContent, title, description, conditionLabel);
    await engine.updateListing(String(itemId), newDesc);

    console.log(`[test-single] Updated ${itemId} — ${title} [${conditionLabel || 'no condition'}]`);
    res.json({ success: true, itemId: String(itemId), title, conditionLabel });
  } catch (err) {
    console.error(`[test-single] Error for ${itemId}: ${err.message}`);
    res.status(500).json({ success: false, itemId: String(itemId), error: err.message });
  }
});

// POST /run-season — trigger a manual run
app.post('/run-season', (req, res) => {
  const VALID = ['spring', 'summer', 'autumn', 'winter'];
  const { season } = req.body || {};

  if (!VALID.includes(season)) {
    return res.status(400).json({ error: `Invalid season. Must be one of: ${VALID.join(', ')}` });
  }
  if (engine.isEngineRunning()) {
    return res.status(409).json({ error: 'Engine is already running. Wait for it to finish.' });
  }

  // Acknowledge immediately so the client can start polling
  res.json({ ok: true, message: `Season engine starting for: ${season}` });

  // Clear log buffer and run in background
  currentLogs = [];

  const logger = (msg) => {
    const entry = { ts: new Date().toISOString(), msg };
    console.log(`[engine] ${msg}`);
    currentLogs.push(entry);
  };

  engine.runSeasonEngine(season, logger).catch(err => {
    logger(`FATAL: ${err.message}`);
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(config.port, () => {
  const season = engine.getCurrentSeason();
  console.log(`\n🌿 Syraholic Season Engine`);
  console.log(`   Server  : http://localhost:${config.port}`);
  console.log(`   Season  : ${season}`);
  console.log(`   Scheduler: 4 cron jobs registered (Mar/Jun/Sep/Dec 1st 00:00 London)\n`);
});
