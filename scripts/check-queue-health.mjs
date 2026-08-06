#!/usr/bin/env node
/**
 * check-queue-health.mjs — Sentinelle externe des files du pipeline.
 *
 * Lit la vue Supabase `queue_health` (les seuils vivent DANS la vue, pas ici)
 * et sort avec un code d'erreur s'il y a au moins un niveau 'alert'. La GitHub
 * Action (queue-health.yml) transforme ça en issue + email a Nicolas — plus
 * besoin d'ouvrir le cockpit pour decouvrir une panne (audit 2026-07-02 : la
 * ligne heartbeat 'nitro' etait morte depuis 5 jours sans que personne le voie).
 *
 * Sortie : rapport lisible sur stdout + fichier queue-health-report.md (repris
 * dans le corps de l'issue). Exit 1 si alerte, 0 sinon.
 */

import fs from 'node:fs';

const SUPA_URL = 'https://ctjsdpfegpsfpwjgusyi.supabase.co';
const ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN0anNkcGZlZ3BzZnB3amd1c3lpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM2MDU2NDQsImV4cCI6MjA4OTE4MTY0NH0.Uv2pbxbmvcbXhyDa7Y_M0HqkLuV7uJaNxl1N01q5wMo';

const LIBELLES = {
  correction_error: 'Corrections en erreur terminale',
  correction_needs_review: 'Corrections à trancher (needs_review)',
  correction_pending_stuck: 'Corrections en attente non consommées',
  correction_processing_zombie: 'Corrections coincées en processing (>1 h)',
  sflags_pending: 'Réécritures de phrases (crayon) en attente',
  sflags_skipped: 'Réécritures non appliquées que personne ne peut reprendre',
  lecons_recheck_bloquees: 'Leçons bloquées en « à ré-écouter » (la réviseure attend)',
  md_unsynced_contextual: 'Éditions contextuelles pas encore dans la source',
  md_sync_failed: 'Textes maîtres à vérifier',
};

function libelle(item) {
  if (item.startsWith('worker_')) return 'Worker ' + item.slice(7);
  return LIBELLES[item] || item;
}

const res = await fetch(`${SUPA_URL}/rest/v1/queue_health?select=*`, {
  headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` },
});
if (!res.ok) {
  console.error(`Supabase injoignable : HTTP ${res.status}`);
  fs.writeFileSync('queue-health-report.md', `⚠ Impossible de lire queue_health (HTTP ${res.status}) — Supabase down ?`);
  process.exit(1);
}
const rows = await res.json();

const ordre = { alert: 0, warn: 1, ok: 2 };
rows.sort((a, b) => ordre[a.level] - ordre[b.level] || a.item.localeCompare(b.item));

const alerts = rows.filter((r) => r.level === 'alert');
const warns = rows.filter((r) => r.level === 'warn');

const lignes = rows.map((r) => {
  const icone = r.level === 'alert' ? '🔴' : r.level === 'warn' ? '🟡' : '🟢';
  const age = r.oldest_at ? ` (plus vieux : ${String(r.oldest_at).slice(0, 16).replace('T', ' ')})` : '';
  return `${icone} ${libelle(r.item)} : ${r.count}${age}`;
});

const rapport = [
  alerts.length
    ? `## 🔴 ${alerts.length} alerte(s) — du travail est coincé`
    : '## 🟢 Files en santé',
  '',
  ...lignes,
  '',
  `_Vérifié le ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC. Seuils définis dans la vue \`queue_health\` (migration 016)._`,
  `_Cockpit : https://nicksoucy.github.io/xguard-voice-review/_`,
].join('\n');

console.log(rapport);
fs.writeFileSync('queue-health-report.md', rapport);
if (warns.length) console.log(`\n(${warns.length} avertissement(s) — pas d'alerte email, visible au cockpit.)`);
process.exit(alerts.length ? 1 : 0);
