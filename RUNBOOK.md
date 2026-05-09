# Runbook XGuard Voice Review

Documentation operationnelle. A consulter quand quelque chose casse.

---

## Architecture

- **Frontend** : HTML/CSS/JS vanille servi par GitHub Pages (`gh-pages` branch)
- **DB + Storage** : Supabase free tier (project `ctjsdpfegpsfpwjgusyi`)
- **Error tracking** : Sentry free tier (project `xguard-voice-review`)
- **Backups** : GitHub Releases prive, retention 30 jours
- **Staging** (a partir de Phase 1.3) : nouveau projet Supabase + branche `gh-pages-staging`

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

### 5. Restore from backup

**Use case** : table corrompue, suppression accidentelle

**Procedure** :
```bash
# 1. Telecharger le backup voulu
gh release download backup-2026-05-09 --repo Nicksoucy/xguard-voice-review

# 2. Decompresser
gunzip backup-2026-05-09.sql.gz

# 3. RESTORE TARGET = STAGING D'ABORD (jamais directement prod)
# Recuperer connection string staging dans Supabase Studio
psql "postgresql://postgres:STAGING_PASS@db.STAGING_REF.supabase.co:5432/postgres" \
  < backup-2026-05-09.sql

# 4. Verifier que le restore fonctionne (compter rows, verifier data)
# 5. Si OK, restore selectif sur prod (ex: restaurer seule table voice_reviews)
pg_restore --table=voice_reviews ...

# Pour restore complet prod : require confirmation Nicolas explicite
```

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

### Backups GitHub Action
**Secret a configurer** : `SUPABASE_DB_URL`
1. Supabase Studio → Project Settings → Database → Connection String → URI
2. Format : `postgresql://postgres:PASSWORD@db.PROJECT_REF.supabase.co:5432/postgres`
3. GitHub repo Settings → Secrets and variables → Actions → New repository secret
4. Name: `SUPABASE_DB_URL`, Value: la connection string complete
5. Verifier en lancant manuellement le workflow `Backup Supabase` (onglet Actions)

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

- 2026-05-09 : Phase 1.1 deployed — Sentry error tracking
- (a venir) Phase 1.2 — Backups quotidiens
- (a venir) Phase 1.3 — Staging environment
- (a venir) Phase 2 — Analytics + CI/CD
- (a venir) Phase 3 — LMS GHL semi-auto
- (a venir) Phase 4 — Polish + securite
