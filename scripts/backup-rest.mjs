#!/usr/bin/env node
/**
 * backup-rest.mjs — Dump toutes les tables critiques via Supabase REST API.
 *
 * Avantage vs pg_dump : pas besoin de password DB, juste la SUPA_ANON key
 * (deja publique dans review.js).
 *
 * Limite : exporte les DONNEES uniquement (pas le schema, RLS, triggers).
 * Pour un backup complet, utiliser pg_dump avec SUPABASE_DB_URL secret.
 *
 * Output : backups/<table>-YYYY-MM-DD.json.gz
 *
 * Tables backuppees :
 * - lessons (170 rows attendues)
 * - voiceover_metadata (~134 rows)
 * - voice_reviews (~89 rows)
 * - voice_review_history
 * - sentence_flags
 * - video_metadata
 * - video_reviews
 * - video_review_history
 *
 * Pagination : Supabase REST limite a 1000 rows par defaut, on pagine par 1000.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const SUPA_URL = 'https://ctjsdpfegpsfpwjgusyi.supabase.co';
// Anon key — deja publique dans review.js, pas un secret
const SUPA_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN0anNkcGZlZ3BzZnB3amd1c3lpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM2MDU2NDQsImV4cCI6MjA4OTE4MTY0NH0.Uv2pbxbmvcbXhyDa7Y_M0HqkLuV7uJaNxl1N01q5wMo';
const API = SUPA_URL + '/rest/v1';
const HEADERS = { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` };

// Liste des tables a backupper
const TABLES = [
  'lessons',
  'voiceover_metadata',
  'voice_reviews',
  'voice_review_history',
  'sentence_flags',
  'video_metadata',
  'video_reviews',
  'video_review_history',
  'courses', // si existe
];

const PAGE_SIZE = 1000;
const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
const outDir = path.join(process.cwd(), 'backups');
fs.mkdirSync(outDir, { recursive: true });

console.log(`[backup-rest] Backup ${date} starting...`);
console.log(`[backup-rest] Output dir: ${outDir}`);

let totalRows = 0;
let successCount = 0;
let errorCount = 0;

for (const table of TABLES) {
  const filePath = path.join(outDir, `${table}-${date}.json.gz`);
  console.log(`\n[${table}] Fetching...`);

  try {
    const allRows = [];
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
      const url = `${API}/${table}?select=*&limit=${PAGE_SIZE}&offset=${offset}`;
      const r = await fetch(url, { headers: HEADERS });

      if (!r.ok) {
        if (r.status === 404) {
          console.log(`  [skip] Table ${table} n'existe pas (404)`);
          break;
        }
        const errText = await r.text();
        throw new Error(`HTTP ${r.status}: ${errText.slice(0, 200)}`);
      }

      const rows = await r.json();
      allRows.push(...rows);
      console.log(`  Fetched ${rows.length} rows (offset ${offset})`);

      if (rows.length < PAGE_SIZE) {
        hasMore = false;
      } else {
        offset += PAGE_SIZE;
      }
    }

    if (allRows.length === 0) {
      console.log(`  [empty] ${table}: 0 rows, skipping file creation`);
      continue;
    }

    // Compresse en gzip pour reduire la taille
    const json = JSON.stringify(
      {
        table,
        backup_date: date,
        backup_at: new Date().toISOString(),
        row_count: allRows.length,
        data: allRows,
      },
      null,
      2,
    );

    const gz = zlib.gzipSync(json);
    fs.writeFileSync(filePath, gz);

    const sizeKB = (gz.length / 1024).toFixed(1);
    console.log(`  ✓ ${table}: ${allRows.length} rows -> ${filePath} (${sizeKB} KB)`);
    totalRows += allRows.length;
    successCount++;
  } catch (e) {
    console.error(`  ✗ ${table}: ${e.message}`);
    errorCount++;
  }
}

console.log(`\n[backup-rest] Done.`);
console.log(`  Tables: ${successCount} OK, ${errorCount} failed`);
console.log(`  Total rows: ${totalRows}`);

// Cree aussi un fichier MANIFEST.json avec resume
const manifest = {
  backup_date: date,
  backup_at: new Date().toISOString(),
  total_rows: totalRows,
  tables_count: successCount,
  tables: TABLES,
  errors: errorCount,
};
fs.writeFileSync(
  path.join(outDir, `MANIFEST-${date}.json.gz`),
  zlib.gzipSync(JSON.stringify(manifest, null, 2)),
);

if (errorCount > 0) {
  console.error(`\n[backup-rest] FAILED: ${errorCount} tables had errors`);
  process.exit(1);
}
console.log(`[backup-rest] All tables backuped successfully.`);
