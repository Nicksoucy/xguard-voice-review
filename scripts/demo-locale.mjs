#!/usr/bin/env node
/**
 * scripts/demo-locale.mjs — L'app de revision en local, branchee sur un Supabase SIMULE.
 *
 * POURQUOI. Pour montrer un changement de l'app (ou l'essayer soi-meme) sans jamais ecrire
 * dans la base de production : chaque clic de l'app autosauvegarde, et la prod est celle
 * que Rawen utilise. Ce serveur sert les fichiers du depot et repond lui-meme aux appels
 * Supabase (REST + stockage), en memoire. Rien ne sort de la machine.
 *
 * Usage :  node scripts/demo-locale.mjs            puis ouvrir http://localhost:8792
 *          PORT=9000 node scripts/demo-locale.mjs
 *
 * Deux lecons de demo :
 *   - voix  : review.html?key=demo/module-01/01-voix
 *   - video : review-video.html?key=demo/module-01/02-video
 * Un petit panneau en bas a droite de chaque page permet de SIMULER UNE COUPURE RESEAU
 * (les sauvegardes echouent) pour voir le bandeau rouge et le bouton « Réessayer ».
 * L'etat (revues, corrections) vit en memoire : il repart a zero quand on arrete le serveur.
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const RACINE = fileURLToPath(new URL('..', import.meta.url));
const PORT = Number(process.env.PORT) || 8792;

// ── Donnees de demo ────────────────────────────────────────────────
const VOIX = 'demo/module-01/01-voix';
const VIDEO = 'demo/module-01/02-video';
const PHRASES = [
  "Bienvenue dans cette formation sur la sécurité des chariots élévateurs.",
  "Avant chaque quart de travail, l'opérateur fait le tour du chariot.",
  "Il vérifie les fourches, les pneus et le klaxon, puis il note ses observations.",
  "Une anomalie se signale tout de suite au superviseur.",
];
// Mots horodates (0,35 s par mot) au format des timestamps du pipeline.
const MOTS = [];
let t = 0;
PHRASES.forEach((p, si) => {
  for (const w of p.split(' ')) {
    MOTS.push({ word: w, sentenceIndex: si, start: +t.toFixed(2), end: +(t + 0.3).toFixed(2) });
    t += 0.35;
  }
  t += 0.4;
});
const LECONS = {
  [VOIX]: { lesson_key: VOIX, course_id: 'demo', title: 'M1 / Inspection avant le quart', short_title: 'M1 / Inspection avant le quart', lesson_index: 1, duration_seconds: Math.round(t) },
  [VIDEO]: { lesson_key: VIDEO, course_id: 'demo', title: 'M1 / Signaler une anomalie', short_title: 'M1 / Signaler une anomalie', lesson_index: 2, duration_seconds: 6 },
};

const etat = {
  coupure: false, // panneau « simuler une coupure reseau »
  voice_reviews: [],
  video_reviews: [],
  correction_requests: [],
};

// ── Petit PostgREST de poche ───────────────────────────────────────
// Filtres reconnus : col=eq.valeur (le reste des parametres est ignore).
function filtrer(rows, params) {
  return rows.filter((r) =>
    [...params.entries()].every(([k, v]) => {
      if (!v.startsWith('eq.')) return true;
      return String(r[k]) === decodeURIComponent(v.slice(3));
    }),
  );
}

function upsert(table, corps) {
  const rows = etat[table];
  const i = rows.findIndex((r) => r.lesson_key === corps.lesson_key && r.reviewer_name === corps.reviewer_name);
  if (i >= 0) rows[i] = { ...rows[i], ...corps };
  else rows.push({ id: rows.length + 1, created_at: new Date().toISOString(), ...corps });
}

function rest(req, res, chemin, params, corps) {
  const table = chemin.split('/')[0];
  const json = (data, code = 200) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };
  if (req.method === 'POST' || req.method === 'PATCH') {
    // Coupure simulee : on ferme la connexion sans repondre (comme un wifi qui tombe).
    if (etat.coupure) return req.socket.destroy();
    const c = corps ? JSON.parse(corps) : {};
    if (table === 'voice_reviews' || table === 'video_reviews') upsert(table, c);
    else if (table === 'correction_requests') etat.correction_requests.unshift({ id: Date.now(), status: 'pending', created_at: new Date().toISOString(), ...c });
    res.writeHead(201);
    return res.end();
  }
  const maintenant = new Date();
  switch (table) {
    case 'lessons':
      return json(filtrer(Object.values(LECONS), params));
    case 'lesson_status':
    case 'lesson_status_full':
      return json(filtrer(Object.values(LECONS).map((l) => ({ ...l, status: 'approved', voiceover_uploaded_at: '2026-11-09T15:00:00Z' })), params));
    case 'video_metadata':
      return json(filtrer([{ lesson_key: VIDEO, video_path: 'demo/02-video/final-v1.mp4', version: 1, produced_at: '2026-11-09T16:00:00Z', produced_by: 'demo' }], params));
    case 'voice_reviews':
    case 'video_reviews':
    case 'correction_requests':
      return json(filtrer(etat[table], params));
    case 'watchdog_heartbeat':
      // Robot des corrections « vivant » : battement d'il y a 2 minutes.
      return json([{ id: 'xguard-correction@nitro', status: 'alive', last_heartbeat: new Date(maintenant - 120000).toISOString() }]);
    case 'courses':
      return json([{ id: 'demo', title: 'Formation de démonstration', visible: true }]);
    default:
      return json([]);
  }
}

// ── Panneau de demo injecte dans chaque page ───────────────────────
const PANNEAU = `
<script>
// Injecte par scripts/demo-locale.mjs : l'app parle au Supabase SIMULE de ce serveur.
window.SUPA_URL_OVERRIDE = location.origin + '/simule';
window.SUPA_KEY_OVERRIDE = 'demo-locale';
document.addEventListener('DOMContentLoaded', function () {
  var p = document.createElement('div');
  p.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2000;background:#1E293B;color:#F0F0F0;border:1px solid #F39C12;border-radius:8px;padding:10px 12px;font:14px system-ui;box-shadow:0 4px 18px rgba(0,0,0,.5)';
  p.innerHTML = '<strong style="color:#F8C471">Démo locale</strong> — base simulée, rien ne part en production<br>' +
    '<label style="cursor:pointer"><input type="checkbox" id="demo-coupure"> Simuler une coupure réseau</label>';
  document.body.appendChild(p);
  var cb = document.getElementById('demo-coupure');
  fetch('/demo/etat').then(function (r) { return r.json(); }).then(function (e) { cb.checked = e.coupure; });
  cb.onchange = function () { fetch('/demo/coupure?on=' + (cb.checked ? 1 : 0)); };
});
</script>`;

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.ico': 'image/x-icon' };

const serveur = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  let corps = '';
  req.on('data', (c) => (corps += c));
  await new Promise((r) => req.on('end', r));
  try {
    if (url.pathname === '/') {
      res.writeHead(302, { Location: '/review.html?key=' + encodeURIComponent(VOIX) });
      return res.end();
    }
    if (url.pathname === '/demo/etat') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ coupure: etat.coupure }));
    }
    if (url.pathname === '/demo/coupure') {
      etat.coupure = url.searchParams.get('on') === '1';
      console.log(etat.coupure ? '⚡ coupure reseau SIMULEE (les sauvegardes echouent)' : '✓ reseau retabli');
      res.writeHead(204);
      return res.end();
    }
    if (url.pathname.startsWith('/simule/rest/v1/')) {
      return rest(req, res, url.pathname.slice('/simule/rest/v1/'.length), url.searchParams, corps);
    }
    if (url.pathname.startsWith('/simule/storage/v1/')) {
      if (url.pathname.endsWith('.mp4')) {
        res.writeHead(200, { 'Content-Type': 'video/mp4' });
        return res.end(await readFile(join(RACINE, 'tests/fixtures/mini.mp4')));
      }
      if (url.pathname.includes(VOIX) && url.pathname.includes('timestamps')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(MOTS));
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end('{}');
    }
    // Fichiers du depot (jamais en dehors de la racine).
    const chemin = normalize(join(RACINE, decodeURIComponent(url.pathname)));
    if (!chemin.startsWith(RACINE)) {
      res.writeHead(403);
      return res.end();
    }
    let contenu = await readFile(chemin);
    const ext = extname(chemin);
    if (ext === '.html') contenu = String(contenu).replace(/<head>/i, '<head>' + PANNEAU);
    res.writeHead(200, { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(contenu);
  } catch (e) {
    res.writeHead(e.code === 'ENOENT' ? 404 : 500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(String(e.message));
  }
});

serveur.listen(PORT, () => {
  console.log(`Démo locale (Supabase SIMULÉ) : http://localhost:${PORT}`);
  console.log(`  voix  : http://localhost:${PORT}/review.html?key=${encodeURIComponent(VOIX)}`);
  console.log(`  vidéo : http://localhost:${PORT}/review-video.html?key=${encodeURIComponent(VIDEO)}`);
});
