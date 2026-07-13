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

---

## Architecture de fiabilite (audit 2026-07-02)

### Workers et machines
| Worker | Machines | Declencheur | Heartbeat |
|---|---|---|---|
| correction-loop (process-correction-requests.mjs) | Nitro (Task Scheduler 5 min, `git fetch+reset` avant chaque run) + Mac (launchd 300s) | file `correction_requests` | `xguard-correction@<host>` |
| sentence-flags (process-sentence-flags.mjs) | Nitro (Task Scheduler 5 min, one-shot) + Mac (launchd watch 5s) | file `sentence_flags` | `xguard-sflags@<host>` |
| studio-worker | Mac (launchd watch) | tables studio | `xguard-studio@<host>` |
| apply-vault-edits | Mac (launchd 13h45) | `md_synced=false contextual` | — |

Nitro est un CLONE GIT (`C:\Users\User\xguard-pipeline`, deploy key lecture seule
`id_pipeline`) — plus jamais de scp. L'ancien dossier scp est garde en
`xguard-pipeline-scp-backup-20260702`. Le vault de Nitro pousse avec `id_vault`
(lecture-ecriture depuis 2026-07-02, requis par sentence-flags).

### Garde-fous
1. Gate de version (`scripts/lib/code-version.mjs`) : un worker en retard sur
   origin/master refuse de claimer (heartbeat `stale-version`).
2. Fence DB (migration 014) : trigger sur `correction_requests` — un hote
   `allowed=false` dans `xguard_worker_hosts` recoit 400 au claim, meme avec du
   vieux code. Debrancher une machine = `UPDATE xguard_worker_hosts SET allowed=false`.
3. Plus AUCUN statut `error` terminal : anti-boucle et refus du garde-fou dico
   routent vers `needs_review` avec une raison lisible.

### Surveillance
- Vue `queue_health` (migration 016) = SEULE source des seuils. Consommee par le
  cockpit, la routine 14h (hela-feedback) et la sentinelle.
- Sentinelle : `.github/workflows/queue-health.yml` toutes les 30 min. Alerte ->
  issue label `watchdog` (email automatique GitHub a Nicolas) ; retour au vert ->
  issue fermee. Test manuel : Actions -> « Sante du pipeline » -> Run workflow.
- Cockpit : bandeau par machine sur tous les onglets (rouge = erreur/code
  perime/travail coince ; le Mac qui dort avec une file vide n'alarme pas).

### Incident type : « une machine tourne du vieux code »
1. Cockpit : la puce machine affiche « code perime (version) ».
2. La bloquer immediatement : `UPDATE xguard_worker_hosts SET allowed=false WHERE hostname='<HOST>';`
3. Sur la machine : `git -C <repo> fetch && git reset --hard origin/master`, puis re-autoriser.

### Etape restante (a faire par Nicolas) — durcissement RLS
Les workers utilisent la cle anon (fallback). Pour retirer les ecritures anon sur
`watchdog_heartbeat` et `dict_additions` SANS casser les workers :
1. Supabase Studio -> Settings -> API -> copier la cle `service_role`.
2. L'ajouter dans les DEUX .env : `SUPABASE_SERVICE_ROLE_KEY=...`
   (Mac : `~/XGuard/pipeline/.env` ; Nitro : `C:\Users\User\xguard-pipeline\.env`).
3. Verifier un cycle complet des workers, PUIS retirer les policies d'ecriture anon
   sur ces deux tables (migration dediee). Ne PAS toucher aux autres tables : l'app
   publique (Hela) ecrit avec la cle anon par design.

## Garde-manger mince Supabase Storage (2026-07-13)

Strategie : rester sur le plan Pro (25 $/mois) le temps de la production ; les
buckets `videos`/`voiceovers` ne gardent QUE ce qui est activement en review.
Tout le reste vit dans l'archive locale (Mac `~/XGuard/renders` + `pipeline/out`,
miroir Nitro `C:\Users\User\XGuard-Archive`) et sur GHL pour les cours livres.
Contexte : 402 de juillet 2026 (storage 14,5 Go vs quota) — purge initiale
15 Go -> 9,3 Go le 2026-07-13.

Outils (repo pipeline, `scripts/`) :
- `inventory-storage.mjs` — lecture seule, carte des 2 buckets croisee avec la DB
  (verdict par formation). Rapport : `out/storage-inventory.json`.
- `archive-storage.mjs` — descend en local tout fichier courant manquant
  (no-clobber, verif de taille). A lancer AVANT toute purge R3.
- `prune-storage.mjs` — dry-run PAR DEFAUT, manifest ecrit avant suppression
  (`out/prune-manifests/`), suppression par l'API Storage (jamais SQL).
  R1 = vieilles versions final-vK ; R2 = previews promus ; R3 = formation
  livree (exige `--course` explicite + tous statuts verts + archive verifiee
  fichier par fichier, jamais contournable).

Routine a chaque formation livree a GHL (apres `package-ghl` + upload) :
1. `node scripts/archive-storage.mjs --course <id>`
2. `node scripts/prune-storage.mjs --rules r3 --course <id>`   (relire le dry-run)
3. `node scripts/prune-storage.mjs --rules r3 --course <id> --apply`
4. De temps en temps : `--rules r1,r2 --apply` (menage des versions/previews).

Garde-fous : la cle service_role est requise pour `--apply` (sinon refus) ;
les orphelins ambigus (base pointe `final.mp4`, des `final-vN` non references
trainent — vieux cours alerte-bombe/tireur-actif, ~300 Mo) ne sont JAMAIS
purges automatiquement.
