# Runbook XGuard Voice Review

Documentation operationnelle. A consulter quand quelque chose casse.

---

## Architecture

| Composant | Description | Provider | URL/ID |
|---|---|---|---|
| Frontend prod | Site statique HTML/JS vanille | GitHub Pages | `gh-pages` branch → https://nicksoucy.github.io/xguard-voice-review/ |
| Frontend staging | Meme code, env=staging | GitHub Pages | `gh-pages-staging` branch (a activer) |
| DB prod | Tables, vues, RLS, policies | Supabase free | `ctjsdpfegpsfpwjgusyi` (us-west-2) |
| DB staging | Schema clone | Supabase free | `pekkskvpttzgqxjaqvzf` (us-west-1) |
| Storage prod | Voiceovers MP3 + videos MP4 | Supabase Storage | buckets `voiceovers` + `videos` (100MB max) |
| Error tracking | Erreurs frontend en temps reel | Sentry free | https://darkhorse-ads.sentry.io/projects/xguard-voice-review/ |
| Backups | Dump quotidien tables critiques | GitHub Releases | https://github.com/Nicksoucy/xguard-voice-review/releases (prerelease) |
| CI/CD | Lint sur PR | GitHub Actions | `.github/workflows/ci.yml` |
| LMS push | Export GHL JSON manuel | client-side | `lms/ghl-payload.js` |

## Pages disponibles

| URL | Role | Acces |
|---|---|---|
| `/` (index.html) | Liste cours + progression globale | Public |
| `/course.html?course=XXX` | Detail cours, liste lecons, export GHL | Public |
| `/review.html?key=XXX` | Voice review (voiceover + flags) | Public |
| `/review-video.html?key=XXX` | Video review (player + flags categorises) | Public |
| `/analytics.html` | Dashboard KPIs + charts | Public (a gater Phase 5+ ?) |
| `/exports.html` | Exports CSV/JSON tables critiques | Public |

---

## Incidents type

### 1. Reviewer me dit "Sauvegarde marche pas"

**Action** :
1. Ouvre Sentry dashboard : https://darkhorse-ads.sentry.io/projects/xguard-voice-review/
2. Cherche les erreurs des dernieres 30 min, filtre par tag `reviewer_name`
3. Verifie : action=`save_voice_review` ou `save_video_review`
4. Stack trace + tags te disent quelle lecon, quel HTTP status

**Causes communes** :
- HTTP 401/403 → RLS Supabase qui bloque (verifie policies sur `voice_reviews`/`video_reviews`)
- HTTP 500 → Supabase down (status.supabase.com)
- Network error → reviewer offline ou DNS

### 2. Sentry est silencieux malgre erreurs visibles

**Causes possibles** :
- Adblocker bloque le CDN Sentry → l'app utilise un stub silencieux (chercher `[Sentry stub]` dans console DevTools)
- Sentry free tier rate-limit atteint (5k erreurs/mois) → upgrade ou ignore les erreurs bruyantes
- DSN expire → check Settings dans Sentry dashboard

**Test rapide** dans la console DevTools du reviewer :
```javascript
Sentry.captureMessage('test from devtools')
```
Si l'event apparait dans Sentry, le SDK marche. Sinon, regarder console pour erreur.

### 3. Supabase est down

**Symptomes** : tous les reviewers voient "Erreur reseau" / "Impossible de charger les timestamps"

**Action** :
1. Verifier https://status.supabase.com
2. Si confirmed down : envoyer message a tous les reviewers "Supabase down, on attend"
3. Si > 30 min : considerer fallback (export local des reviews en cours, restore quand back up)

### 4. Backup quotidien a foire

**Notification** : GitHub Actions affiche `❌` sur l'onglet Actions du repo

**Action** :
1. Aller dans https://github.com/Nicksoucy/xguard-voice-review/actions
2. Cliquer le run echoue, voir les logs
3. Causes communes :
   - `SUPABASE_DB_URL` secret invalide (mot de passe change)
   - Timeout pg_dump (DB trop grosse)
   - Quota disk GitHub Actions atteint

**Rerun** : bouton "Re-run all jobs" sur la page du run echoue.

### 5. Restore from Option B backup (REST API JSON)

**Use case** : table corrompue, suppression accidentelle

**Note importante** : les backups Option B contiennent uniquement les **DONNEES**
(pas le schema, RLS policies, triggers). Pour restorer un schema complet,
utiliser Option A (pg_dump) — voir section "Setup Option A" plus bas.

**Procedure restore selectif d'une table** :

```bash
# 1. Telecharger le backup voulu
gh release download backup-2026-05-09 --repo Nicksoucy/xguard-voice-review --dir /tmp/backup

# 2. Decompresser le fichier de la table cible
cd /tmp/backup
gunzip voice_reviews-2026-05-09.json.gz

# 3. Inspecter le contenu (verifier la structure)
cat voice_reviews-2026-05-09.json | jq '.row_count, .data[0]'

# 4. Restorer via SQL Editor Supabase OU via script Node:
node -e "
const data = require('/tmp/backup/voice_reviews-2026-05-09.json');
const SUPA = 'https://ctjsdpfegpsfpwjgusyi.supabase.co';
const KEY = 'eyJ...'; // service_role pour bypass RLS
// Pour chaque row, INSERT ON CONFLICT
for (const row of data.data) {
  await fetch(SUPA+'/rest/v1/voice_reviews?on_conflict=lesson_key,reviewer_name', {
    method: 'POST',
    headers: { apikey: KEY, Authorization: 'Bearer '+KEY,
               'Content-Type': 'application/json',
               'Prefer': 'resolution=merge-duplicates' },
    body: JSON.stringify(row)
  });
}
"
```

**ATTENTION** : utiliser une cle **service_role** (pas anon) pour pouvoir
INSERT avec n'importe quelle valeur (RLS bypass).

### 5b. Setup Option A (pg_dump avec password DB) — backup complet

Si on veut un backup avec schema + RLS + triggers (plus complet que Option B) :

1. Supabase Studio → Settings → Database → "Reset database password"
2. Copier la connection string Session Pooler :
   `postgresql://postgres.ctjsdpfegpsfpwjgusyi:PASSWORD@aws-0-us-west-2.pooler.supabase.com:5432/postgres`
3. GitHub repo Settings → Secrets → New : `SUPABASE_DB_URL` = la string complete
4. Remplacer `backup-supabase.yml` par la version pg_dump (cf historique git)

Sans ca, on reste sur Option B (JSON REST API) qui couvre 95% des cas reels.

### 6. Rotate Sentry DSN

Si le DSN est compromis (rare car public par design, mais bon) :

1. Sentry Settings → Client Keys (DSN) → Revoke + Create New
2. Mettre a jour `index.html`, `course.html`, `review.html`, `review-video.html` :
   - Remplacer `https://js.sentry-cdn.com/OLD_HASH.min.js` par new hash
3. Commit + push gh-pages

### 7. Push direct gh-pages bloque (Phase 4)

**A partir de Phase 4**, `gh-pages` requiert PR review. Workflow :
1. Creer branche `feature/xyz`
2. Push → deploy auto sur staging
3. Tester sur https://nicksoucy.github.io/xguard-voice-review-staging/
4. Si OK : ouvrir PR vers `gh-pages`, ajouter label `staging-validated`
5. Merge

**Bypass d'urgence** : Settings → Branches → temporairement disable rule, push, re-enable.

---

## Setup initial (a faire une fois)

### Sentry
1. Compte cree : https://darkhorse-ads.sentry.io
2. Project : `xguard-voice-review` (Browser JavaScript / Vanilla)
3. DSN integre dans loader : `js.sentry-cdn.com/ab9916085bc6c9e93779c21fad74456f.min.js`
4. Free tier : 5000 erreurs/mois, 30 jours retention

### Backups GitHub Action (Option B — REST API)

**Aucun secret requis** — utilise la SUPA_ANON key publique.

Le workflow `.github/workflows/backup-supabase.yml` execute `scripts/backup-rest.mjs`
qui dump toutes les tables critiques en JSON gzip via Supabase REST API.

**Tester** : Actions → Backup Supabase (REST API) → Run workflow

Tables dumpees : lessons, voiceover_metadata, voice_reviews, voice_review_history,
sentence_flags, video_metadata, video_reviews, video_review_history, courses.

Output : 1 release par jour avec 7-9 fichiers .json.gz (~500 KB total).

**Si on veut Option A (pg_dump complet avec schema)** : voir section 5b.

### Staging (Phase 1.3 - a venir)
Voir section Phase 1.3 du plan dans `~/.claude/plans/`.

---

## Contacts

- **Owner** : Nicolas Soucy Legault (nick@darkhorseads.com)
- **Sentry org** : darkhorse-ads.sentry.io
- **Supabase project** : ctjsdpfegpsfpwjgusyi
- **GitHub repo** : Nicksoucy/xguard-voice-review

---

## Changelog production grade

- 2026-05-09 : Phase 1.1 deployed — Sentry error tracking (loader CDN + sentry-init.js)
- 2026-05-09 : Phase 1.2 deployed — Backups Option B (REST API JSON, pas de password DB requis)
- 2026-05-09 : Phase 1.3 deployed — Staging Supabase (`pekkskvpttzgqxjaqvzf`) + frontend bascule auto
- 2026-05-09 : Phase 1.4 deployed — RUNBOOK initial
- 2026-05-10 : Phase 2.1 deployed — 5 vues SQL analytics (review_analytics, throughput, top_flags, global_kpis, category_breakdown)
- 2026-05-10 : Phase 2.2 deployed — Dashboard analytics.html (Chart.js, 5 KPIs, 4 charts, table top flags)
- 2026-05-10 : Phase 2.3 deployed — CI/CD ESLint + HTMLHint sur PR
- 2026-05-10 : Phase 3.1 deployed — Schema LMS columns + lms_push_queue view
- 2026-05-10 : Phase 3.3 deployed — lms/ghl-payload.js generateur client-side
- 2026-05-10 : Phase 3.4 deployed — UI Push to GHL (course.html bulk + review-video.html lesson)
- 2026-05-10 : Phase 4.1 deployed — Exports CSV/JSON (5 sections : reviews, lessons, top flags, throughput, sentence flags)
- 2026-05-10 : Phase 4.2 deployed — RLS hardening sur tables video_* (advisory critical Supabase resolu)
