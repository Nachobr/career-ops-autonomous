import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname, join, resolve } from 'path';

const ROOT = resolve(dirname(new URL('../package.json', import.meta.url).pathname));

export const DB_PATH = process.env.CAREER_OPS_TRACKER_DB
  ? resolve(ROOT, process.env.CAREER_OPS_TRACKER_DB)
  : join(ROOT, 'data', 'applications.db');

function parseScoreNum(score) {
  const m = String(score || '').replace(/\*\*/g, '').match(/(\d+(\.\d+)?)/);
  return m ? parseFloat(m[1]) : null;
}

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS applications (
      id         INTEGER PRIMARY KEY,
      date       TEXT NOT NULL,
      company    TEXT NOT NULL,
      role       TEXT NOT NULL,
      score      TEXT,
      score_num  REAL,
      status     TEXT NOT NULL,
      pdf        TEXT,
      report     TEXT,
      notes      TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS follow_ups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      application_id INTEGER NOT NULL,
      kind TEXT, due_date TEXT, done INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY(application_id) REFERENCES applications(id)
    );
    CREATE TABLE IF NOT EXISTS dead_letter (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT, source TEXT, url TEXT, error TEXT, attempts INTEGER, run_id TEXT, meta TEXT
    );
  `);

  const columns = db.prepare('PRAGMA table_info(applications)').all().map((col) => col.name);
  if (!columns.includes('display_order')) {
    db.exec('ALTER TABLE applications ADD COLUMN display_order INTEGER');
  }
}

export function openDb(path = DB_PATH) {
  const dbPath = resolve(ROOT, path);
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  ensureSchema(db);
  return db;
}

export function upsertApplication(db, row) {
  const id = Number.parseInt(row.id ?? row.num, 10);
  if (!Number.isFinite(id) || id <= 0) throw new Error(`invalid application id: ${row.id ?? row.num}`);

  db.prepare(`
    INSERT INTO applications (
      id, date, company, role, score, score_num, status, pdf, report, notes, updated_at, display_order
    ) VALUES (
      @id, @date, @company, @role, @score, @score_num, @status, @pdf, @report, @notes, @updated_at, @display_order
    )
    ON CONFLICT(id) DO UPDATE SET
      date = excluded.date,
      company = excluded.company,
      role = excluded.role,
      score = excluded.score,
      score_num = excluded.score_num,
      status = excluded.status,
      pdf = excluded.pdf,
      report = excluded.report,
      notes = excluded.notes,
      updated_at = excluded.updated_at,
      display_order = COALESCE(excluded.display_order, applications.display_order)
  `).run({
    id,
    date: row.date || '',
    company: row.company || '',
    role: row.role || '',
    score: row.score || '',
    score_num: parseScoreNum(row.score),
    status: row.status || 'Evaluated',
    pdf: row.pdf || '',
    report: row.report || '',
    notes: row.notes || '',
    updated_at: new Date().toISOString(),
    display_order: row.display_order ?? null,
  });
}

export function syncApplications(db, rows) {
  const tx = db.transaction((items) => {
    const ids = items.map((row) => Number.parseInt(row.id ?? row.num, 10)).filter((id) => Number.isFinite(id) && id > 0);
    if (ids.length === 0) {
      db.prepare('DELETE FROM applications').run();
      return;
    }
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`DELETE FROM applications WHERE id NOT IN (${placeholders})`).run(...ids);
    for (let i = 0; i < items.length; i++) {
      upsertApplication(db, { ...items[i], display_order: items[i].display_order ?? i });
    }
  });
  tx(rows || []);
}

export function getApplications(db) {
  return db.prepare(`
    SELECT id, date, company, role, score, score_num, status, pdf, report, notes, updated_at, display_order
    FROM applications
    ORDER BY display_order IS NULL ASC, display_order ASC, id ASC
  `).all();
}

export function deleteApplication(db, id) {
  return db.prepare('DELETE FROM applications WHERE id = ?').run(id);
}

export function rowCount(db) {
  return db.prepare('SELECT COUNT(*) AS count FROM applications').get().count;
}

export function closeDb(db) {
  if (db?.open) db.close();
}

export function parseTrackerMarkdown(text) {
  return String(text || '')
    .split('\n')
    .flatMap((line, index) => {
      if (!/^\|\s*\d+\s*\|/.test(line)) return [];
      const rawParts = line.split('|');
      const parts = rawParts.map((cell) => cell.trim());
      if (parts.length < 9) return [];
      const id = Number.parseInt(parts[1], 10);
      if (!Number.isFinite(id) || id === 0) return [];
      const rawNotes = rawParts[9] || '';
      const notes = rawNotes.replace(/^ /, '').replace(/ $/, '');
      return [{
        id,
        date: parts[2],
        company: parts[3],
        role: parts[4],
        score: parts[5],
        status: parts[6],
        pdf: parts[7],
        report: parts[8],
        notes,
        display_order: index,
      }];
    });
}

export function renderTrackerMarkdown(rows) {
  const lines = [
    '# Application Tracker',
    '',
    '| ID | Fecha | Empresa | Rol | Score | Estado | PDF | Report |',
    '|----|-------|---------|-----|-------|--------|-----|--------|',
  ];
  for (const row of rows || []) {
    lines.push(`| ${row.id ?? row.num} | ${row.date} | ${row.company} | ${row.role} | ${row.score || ''} | ${row.status} | ${row.pdf || ''} | ${row.report || ''} | ${row.notes || ''} |`);
  }
  return `${lines.join('\n')}\n`;
}
