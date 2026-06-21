# XGuard Voice Review

App web de review collaborative des voiceovers et videos de formation XGuard Academy.

**Production** : https://nicksoucy.github.io/xguard-voice-review/

## C'est quoi

Un tableau de bord pour reviewer les contenus media de formations e-learning :

1. **Voice review** : ecouter un voiceover, flagger les mots mal prononces, marquer comme approuve
2. **Video review** : regarder une video assemblee, flagger des timestamps + categories d'issues, approuver/rejeter
3. **Push LMS** : exporter les cours approuves vers GoHighLevel Memberships en 1 click

Workflow type :
```
Pipeline genere voiceover Edge TTS
  → Reviewer ouvre l'app, ecoute, flag
  → Pipeline regenere apres corrections
  → Reviewer approuve voice
  → Pipeline assemble video HyperFrames
  → Employe non-tech reviewe la video
  → Reviewer approuve video
  → Click "Export GHL" → JSON telecharge → upload dans GHL → cours live
```

## Architecture

- **Frontend** : HTML/CSS/JS vanille (zero framework, zero build) servi par GitHub Pages
- **Backend** : Supabase free tier (Postgres + Storage + Auth)
- **Error tracking** : Sentry free tier
- **Backups** : GitHub Actions cron quotidien → GitHub Releases prive
- **CI/CD** : GitHub Actions ESLint + HTMLHint sur PR

Voir `RUNBOOK.md` pour les details d'architecture, incidents type, procedures de restore.

## Pages

| URL | Role |
|---|---|
| `/` | Index : liste des cours, progression globale |
| `/course.html?course=XXX` | Liste lecons + bouton export GHL |
| `/review.html?key=XXX` | Review voiceover (mots + flags) |
| `/review-video.html?key=XXX` | Review video (timeline + categories) |
| `/analytics.html` | Dashboard KPIs (median time-to-approve, top mots flagges, etc.) |
| `/exports.html` | Exports CSV/JSON pour Excel/Sheets |

## Development

### Local

```bash
# Aucune dependance — c'est juste du HTML/JS
# Sert le repo via un static server :
python -m http.server 8080
# Puis http://localhost:8080
```

L'environnement local skip Sentry (pour eviter de polluer le dashboard) et utilise la Supabase prod par defaut.

Pour pointer vers staging Supabase en local :
```javascript
// Dans la console DevTools, avant de naviguer :
window.SUPA_URL_OVERRIDE = 'https://pekkskvpttzgqxjaqvzf.supabase.co';
window.SUPA_KEY_OVERRIDE = '<staging anon key>';
```

### Deploy

- **Production** : push sur `gh-pages` → deploy auto en ~30 sec
- **Staging** : push sur `feature/**` → workflow `deploy-staging.yml` deploy vers `gh-pages-staging`

⚠️ Le push direct sur `gh-pages` deploie immediatement en prod. Phase 4.4 ajoute un gating PR review obligatoire (pas encore active).

### Tests

Suite de tests SANS build (compatible GitHub Pages). Les devDependencies (`package.json`)
ne sont jamais servies au navigateur ; elles servent uniquement aux tests/qualite.

```bash
npm install            # 1re fois
npm test               # tests unitaires (vitest) — logique pure dans lib/*-logic.js, lib/format-utils.js
npm run test:e2e       # tests navigateur (Playwright + Supabase simule) + audit a11y (axe)
npm run lint           # ESLint
npm run format         # biome (formate lib/ + tests/)
```

Architecture de test :
- La logique metier pure est extraite dans `lib/cockpit-logic.js`, `lib/ghl-logic.js`,
  `lib/review-logic.js`, `lib/format-utils.js` avec un export double navigateur (`window.XG*`)
  / Node (`require`). Les pages la chargent via `<script>`, vitest l'importe directement.
- `tests/unit/` : tests unitaires (dont la regression du bug MET sur `finishedCourses` et
  l'invariant GHL « seulement les lecons approved »).
- `tests/e2e/` : Playwright contre un serveur statique local, Supabase simule via `page.route`
  (fixtures dans `tests/fixtures/`).
- `tests/a11y/` : axe-core (zero violation serieuse/critique) + navigation clavier.
- CI (`.github/workflows/ci.yml`) : jobs `lint` (bloquant sur erreur), `unit-tests`, `e2e-tests`
  — tout doit passer avant un merge vers `gh-pages`.

### Securite — note RLS (audit 2026-06-21)

L'instance Supabase est PARTAGEE avec d'autres apps (campagnes email/SMS, kb_*, call_*).
`get_advisors` remonte des tables sans RLS et des politiques permissives, en grande majorite
hors du perimetre voice-review. Pour cette app, la cle `anon` (publique) a volontairement un
acces en ecriture (reviews/corrections soumises sans login) — acceptable pour un outil interne,
mais cela signifie que quiconque possede la cle publique peut ecrire. A durcir si l'app devient
publique. Aucun changement de schema fait ici (hors perimetre, risque de casser d'autres apps).

## Operations

### Backups

Quotidien automatique a 04:00 UTC via GitHub Actions :
- Workflow : `.github/workflows/backup-supabase.yml`
- Output : GitHub Release prerelease `backup-YYYY-MM-DD` avec 7-9 fichiers `.json.gz`
- Retention : 30 jours (cleanup auto)
- Restore : voir RUNBOOK.md section "Restore from Option B backup"

### Sentry

- Org : `darkhorse-ads`
- Project : `xguard-voice-review`
- Plan : Free tier (5000 erreurs/mois)
- Notifications : email sur high-priority issues

### Supabase

| Project | Ref | Region | Usage |
|---|---|---|---|
| Production | `ctjsdpfegpsfpwjgusyi` | us-west-2 | Live data |
| Staging | `pekkskvpttzgqxjaqvzf` | us-west-1 | Tests sans casser prod |

## Phases livrees

Voir `CHANGELOG` dans `RUNBOOK.md` pour le detail.

- ✅ Phase 1 — Stabilisation (Sentry + Backups + Staging + RUNBOOK)
- ✅ Phase 2 — Visibilite (Analytics dashboard + CI/CD lint)
- ✅ Phase 3 — LMS GHL push semi-automatique
- ✅ Phase 4 — Polish (Exports + RLS hardening + Docs)
- 🔄 Phase 5 (futur) — Auth utilisateurs, multi-reviewer consensus, notifications email, Odoo full-auto

## Contacts

- **Owner** : Nicolas Soucy Legault — nick@darkhorseads.com
- **Repo** : https://github.com/Nicksoucy/xguard-voice-review
- **Pipeline parent** : C:\Users\nicol\Formation Xguard (genere voiceovers + scripts)
- **Vault Obsidian** : C:\Users\nicol\OneDrive\Documents\XGuard-Academy
