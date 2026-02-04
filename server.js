// Web app: run weekly snapshot and view previous snapshots.
// Usage: node server.js   then open http://localhost:3000
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;
const SNAPSHOTS_DIR = path.join(__dirname, 'snapshots');
const STATE_FILE = path.join(__dirname, '.snapshot-run-state.json');
const WEEKLY_REPORT_STATE_FILE = path.join(__dirname, '.weekly-report-run-state.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function appSlug(url) {
  if (!url) return 'unknown';
  const m = String(url).match(/apps\.shopify\.com\/([^/]+)/);
  return m ? m[1] : url;
}

// Get Monday–Sunday week that ends on or before the given date (YYYY-MM-DD).
// So for Feb 3 (Tue) we get Jan 26 (Mon) – Feb 1 (Sun). Returns { start, end }.
function getWeekMondayToSunday(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  const day = d.getUTCDay(); // 0 = Sunday, 1 = Monday, ...
  const sundayOffset = day === 0 ? 0 : -day;
  const sunday = new Date(d);
  sunday.setUTCDate(d.getUTCDate() + sundayOffset);
  const monday = new Date(sunday);
  monday.setUTCDate(sunday.getUTCDate() - 6);
  return {
    start: monday.toISOString().slice(0, 10),
    end: sunday.toISOString().slice(0, 10),
  };
}

// Shift YYYY-MM-DD by n days.
function shiftDate(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Last Sunday (week-end) for weekly report default.
function getLastSunday() {
  const d = new Date();
  const day = d.getUTCDay();
  const sundayOffset = day === 0 ? -7 : -day;
  d.setUTCDate(d.getUTCDate() + sundayOffset);
  return d.toISOString().slice(0, 10);
}

// Build summary for a snapshot: per-app totals and count in date range.
// rangeStart/rangeEnd: YYYY-MM-DD (inclusive). If null, use Monday–Sunday week containing snapshotDate.
function snapshotSummary(data, rangeStart, rangeEnd) {
  const snapshotDate = data.snapshotDate || null;
  let rangeStartResolved = rangeStart;
  let rangeEndResolved = rangeEnd;
  if (!rangeStartResolved || !rangeEndResolved) {
    const refDate = rangeEnd || snapshotDate || new Date().toISOString().slice(0, 10);
    const week = getWeekMondayToSunday(refDate);
    rangeStartResolved = rangeStart || week.start;
    rangeEndResolved = rangeEnd || week.end;
  }
  const apps = [];
  let totalArchived = 0;
  let totalInRange = 0;
  const totalStars = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, unknown: 0 };
  for (const app of data.apps || []) {
    const slug = appSlug(app.appReviewsUrl);
    const reviews = app.archivedReviews || [];
    let inRange = 0;
    const inRangeRatings = []; // star rating (1-5) or null per in-range review, so we can show e.g. "2 (5★, 5★)"
    let lastDateISO = null;
    const appStars = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, unknown: 0 };
    for (const r of reviews) {
      totalArchived++;
      const star = r.rating != null && r.rating >= 1 && r.rating <= 5 ? Math.round(Number(r.rating)) : null;
      if (star != null) {
        appStars[star]++;
        totalStars[star]++;
      } else {
        appStars.unknown++;
        totalStars.unknown++;
      }
      let isInRange = false;
      const d = r.dateISO;
      if (d) {
        if (!lastDateISO || d > lastDateISO) lastDateISO = d;
        if (rangeStartResolved && rangeEndResolved && d >= rangeStartResolved && d <= rangeEndResolved) {
          inRange++;
          inRangeRatings.push(star);
          isInRange = true;
        }
      }
      if (!isInRange && rangeStartResolved && rangeEndResolved && r.dateText) {
        const parsed = new Date(r.dateText);
        if (!Number.isNaN(parsed.getTime())) {
          const iso = parsed.toISOString().slice(0, 10);
          if (iso >= rangeStartResolved && iso <= rangeEndResolved) {
            inRange++;
            inRangeRatings.push(star);
          }
        }
      }
    }
    totalInRange += inRange;
    apps.push({
      app: slug,
      totalArchived: reviews.length,
      lastDateISO: lastDateISO || null,
      inRange,
      inRangeRatings,
      stars: appStars,
    });
  }
  return {
    snapshotDate,
    rangeStart: rangeStartResolved,
    rangeEnd: rangeEndResolved,
    apps,
    totalArchived,
    totalInRange,
    stars: totalStars,
  };
}

// List snapshot files (newest first by mtime)
app.get('/api/snapshots', (req, res) => {
  try {
    const files = fs.readdirSync(SNAPSHOTS_DIR)
      .filter((f) => f.endsWith('.json') && f.startsWith('archived-'))
      .map((f) => {
        const filePath = path.join(SNAPSHOTS_DIR, f);
        const stat = fs.statSync(filePath);
        let snapshotDate = null;
        try {
          const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
          snapshotDate = data.snapshotDate || null;
        } catch {
          // ignore
        }
        return {
          filename: f,
          mtime: stat.mtime.toISOString(),
          snapshotDate,
        };
      })
      .sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
    res.json({ snapshots: files });
  } catch (err) {
    res.status(500).json({ error: String(err.message) });
  }
});

// Get trend data: summary for each snapshot (for charts over time)
app.get('/api/trend', (req, res) => {
  try {
    if (!fs.existsSync(SNAPSHOTS_DIR)) {
      return res.json({ trend: [] });
    }
    const files = fs.readdirSync(SNAPSHOTS_DIR)
      .filter((f) => f.endsWith('.json') && f.startsWith('archived-'))
      .sort((a, b) => {
        const pathA = path.join(SNAPSHOTS_DIR, a);
        const pathB = path.join(SNAPSHOTS_DIR, b);
        return fs.statSync(pathB).mtime - fs.statSync(pathA).mtime;
      });
    const points = [];
    for (const f of files) {
      try {
        const filePath = path.join(SNAPSHOTS_DIR, f);
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const summary = snapshotSummary(data, null, null);
        points.push({
          snapshotDate: summary.snapshotDate,
          filename: f,
          totalArchived: summary.totalArchived,
          totalInRange: summary.totalInRange,
          stars: summary.stars,
          apps: summary.apps.map((a) => ({ app: a.app, totalArchived: a.totalArchived, inRange: a.inRange, stars: a.stars })),
        });
      } catch (fileErr) {
        // Skip broken or invalid snapshot files
        continue;
      }
    }
    res.json({ trend: points });
  } catch (err) {
    res.status(500).json({ error: String(err.message) });
  }
});

// Generate weekly Slack post (uses latest snapshot + weekly-report-{weekEnd}.json if present)
app.get('/api/slack-post', (req, res) => {
  try {
    const { generateSlackPost } = require(path.join(__dirname, 'generate-slack-post.js'));
    const weekEnd = req.query.weekEnd || null;
    const text = generateSlackPost({ weekEnd: weekEnd || undefined });
    res.json({ text });
  } catch (err) {
    res.status(500).json({ error: String(err.message) });
  }
});

// Get one snapshot (full JSON or summary only)
app.get('/api/snapshots/:filename', (req, res) => {
  const filename = path.basename(req.params.filename);
  if (!filename.endsWith('.json') || filename.includes('..')) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  const filePath = path.join(SNAPSHOTS_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const summaryOnly = req.query.summary === '1' || req.query.summary === 'true';
    const weekOverWeek = req.query.weekOverWeek === '1' || req.query.weekOverWeek === 'true';
    const rangeStart = req.query.rangeStart || null;
    const rangeEnd = req.query.rangeEnd || null;
    if (summaryOnly) {
      const summary = snapshotSummary(data, rangeStart, rangeEnd);
      if (weekOverWeek && summary.rangeStart && summary.rangeEnd) {
        const prevStart = shiftDate(summary.rangeStart, -7);
        const prevEnd = shiftDate(summary.rangeEnd, -7);
        const previousWeek = snapshotSummary(data, prevStart, prevEnd);
        summary.previousWeek = {
          rangeStart: prevStart,
          rangeEnd: prevEnd,
          totalInRange: previousWeek.totalInRange,
          apps: previousWeek.apps.map((a) => ({ app: a.app, inRange: a.inRange })),
        };
      }
      res.json(summary);
    } else {
      res.json(data);
    }
  } catch (err) {
    res.status(500).json({ error: String(err.message) });
  }
});

// Run state (for polling)
function getRunState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { running: false };
  }
}

function setRunState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

// Start weekly snapshot
app.post('/api/snapshot/run', (req, res) => {
  if (getRunState().running) {
    return res.status(409).json({ error: 'A snapshot is already running.', running: true });
  }
  const date = new Date().toISOString().slice(0, 10);
  const outFile = path.join(SNAPSHOTS_DIR, `archived-${date}.json`);
  const scriptPath = path.join(__dirname, 'shopify-archived-reviews.js');
  const child = spawn(
    process.execPath,
    [scriptPath, '--out', outFile],
    {
      cwd: __dirname,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    }
  );
  setRunState({
    running: true,
    startedAt: new Date().toISOString(),
    date,
    pid: child.pid,
  });
  let stderr = '';
  child.stderr.on('data', (ch) => { stderr += ch; });
  child.on('close', (code) => {
    setRunState({
      running: false,
      finishedAt: new Date().toISOString(),
      date,
      exitCode: code,
      error: code !== 0 ? (stderr.slice(-500) || `Exit code ${code}`) : null,
    });
  });
  res.status(202).json({
    started: true,
    date,
    message: 'Snapshot started. This may take a few minutes. Refresh the list when it finishes.',
  });
});

// Poll snapshot run status
app.get('/api/snapshot/status', (req, res) => {
  res.json(getRunState());
});

// Weekly report run state
function getWeeklyReportState() {
  try {
    return JSON.parse(fs.readFileSync(WEEKLY_REPORT_STATE_FILE, 'utf8'));
  } catch {
    return { running: false };
  }
}

function setWeeklyReportState(state) {
  fs.writeFileSync(WEEKLY_REPORT_STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

// Start weekly report (new reviews + current rating per app)
app.post('/api/weekly-report/run', (req, res) => {
  if (getWeeklyReportState().running) {
    return res.status(409).json({ error: 'A weekly report is already running.', running: true });
  }
  const weekEnd = req.body?.weekEnd || req.query?.weekEnd || getLastSunday();
  const outFile = path.join(SNAPSHOTS_DIR, `weekly-report-${weekEnd}.json`);
  const scriptPath = path.join(__dirname, 'weekly-report.js');
  const child = spawn(
    process.execPath,
    [scriptPath, '--week-end', weekEnd, '--out', outFile],
    {
      cwd: __dirname,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    }
  );
  setWeeklyReportState({
    running: true,
    startedAt: new Date().toISOString(),
    weekEnd,
    outFile,
    pid: child.pid,
  });
  let stderr = '';
  child.stderr.on('data', (ch) => { stderr += ch; });
  child.on('close', (code) => {
    setWeeklyReportState({
      running: false,
      finishedAt: new Date().toISOString(),
      weekEnd,
      outFile,
      exitCode: code,
      error: code !== 0 ? (stderr.slice(-500) || `Exit code ${code}`) : null,
    });
  });
  res.status(202).json({
    started: true,
    weekEnd,
    message: 'Weekly report started (new reviews + ratings). This may take a few minutes.',
  });
});

app.get('/api/weekly-report/status', (req, res) => {
  res.json(getWeeklyReportState());
});

app.listen(PORT, () => {
  console.log(`Archived Review Tracker web app: http://localhost:${PORT}`);
});
