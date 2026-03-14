'use strict';
const cron   = require('node-cron');
const engine = require('./engine');

function scheduleSeasonRun(cronExpr, season) {
  cron.schedule(cronExpr, async () => {
    console.log(`[scheduler] Cron triggered: running ${season} engine…`);
    try {
      const result = await engine.runSeasonEngine(season);
      console.log(`[scheduler] ${season} run complete — updated: ${result.updated}, errors: ${result.errors}`);
    } catch (err) {
      console.error(`[scheduler] ${season} run failed: ${err.message}`);
    }
  }, { timezone: 'Europe/London' });

  console.log(`[scheduler] Scheduled: ${season} on "${cronExpr}" (Europe/London)`);
}

// 1st March  00:00 → spring
scheduleSeasonRun('0 0 1 3 *',  'spring');
// 1st June   00:00 → summer
scheduleSeasonRun('0 0 1 6 *',  'summer');
// 1st Sept   00:00 → autumn
scheduleSeasonRun('0 0 1 9 *',  'autumn');
// 1st Dec    00:00 → winter
scheduleSeasonRun('0 0 1 12 *', 'winter');
