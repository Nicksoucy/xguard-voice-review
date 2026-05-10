# Contributing

Comment ajouter une feature ou fixer un bug sans casser la prod.

## Workflow recommande

```
main repo (gh-pages = prod)
       │
       ├── feature/ma-feature  ← cree une branche
       │       │
       │       ├── commits...
       │       │
       │       └── push origin feature/ma-feature
       │              │
       │              └── auto-deploy sur gh-pages-staging
       │                  (test sur https://nicksoucy.github.io/xguard-voice-review-staging/)
       │
       └── PR feature/ma-feature → gh-pages
              │
              ├── CI lint vert (auto)
              ├── ajoute label `staging-validated` (manuel)
              └── merge → deploie auto en prod
```

## Etapes detaillees

### 1. Cree une branche

```bash
cd C:/Users/nicol/xguard-voice-review
git checkout gh-pages
git pull origin gh-pages
git checkout -b feature/ma-feature
```

### 2. Code + commits

```bash
# Modifie les fichiers...
git add fichier-modifie.js
git commit -m "feat: description du changement

Detail du pourquoi/comment.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

### 3. Push (deploy staging auto)

```bash
git push origin feature/ma-feature
```

GitHub Actions `deploy-staging.yml` push automatiquement vers `gh-pages-staging`.

### 4. Test sur staging

URL : https://nicksoucy.github.io/xguard-voice-review-staging/

⚠️ Si la branche `gh-pages-staging` n'est pas encore activee dans GitHub Pages :
- Settings → Pages → Source : Deploy from branch
- Branch : `gh-pages-staging` (apres premier push)
- (Free tier : 1 seule branche servie a la fois — alterner entre prod et staging
  via Settings n'est pas pratique. Solutions :
  1. Repo separe `xguard-voice-review-staging` qui mirror la branche
  2. Tester localement avec `python -m http.server`
  3. Path subfolder `/staging/` dans le meme `gh-pages` (ajouter dans build))

Tests obligatoires :
- [ ] index.html charge sans erreur console
- [ ] course.html sur un cours connu charge la liste lecons
- [ ] review.html charge un voiceover
- [ ] review-video.html (si applicable)
- [ ] analytics.html charge les KPIs
- [ ] exports.html telecharge un CSV

### 5. PR vers gh-pages

```bash
# Sur GitHub UI :
# 1. Open Pull Request
# 2. base: gh-pages, compare: feature/ma-feature
# 3. Remplir le template (auto-rempli)
# 4. Apres tests staging OK : ajouter label "staging-validated"
```

### 6. Merge

Quand CI vert + label `staging-validated` present → merge.

GitHub Pages deploie automatiquement la nouvelle version de `gh-pages` en prod (~30 sec).

## Test rapide (sans staging)

Si la modification est trop mineure pour staging :
- Fix typo dans un texte
- Update README/RUNBOOK
- Update commentaires dans le code

→ Push direct sur `gh-pages` est tolere mais **pas recommande** pour modifier du code JS/HTML/CSS.

## Erreurs frequentes

### Sentry capture rien
→ Adblocker bloque `js.sentry-cdn.com`. Whitelist le domain.

### Backup workflow fail
→ Verifier secret `SUPABASE_DB_URL` (si Option A) ou que la SUPA_ANON key dans `scripts/backup-rest.mjs` est valide (si Option B).

### Frontend casse en prod apres deploy
1. Sentry → Issues → cherche les nouvelles erreurs
2. GitHub Actions → revert le commit fautif :
   ```bash
   git revert <commit-sha>
   git push origin gh-pages
   ```

## Conventions code

### JavaScript
- Vanilla ES2021, pas de framework
- `var` accepte (pas de `const` strict)
- Toutes les global functions sur `window` automatiquement (script tags non-module)
- Wrap chaque fetch critique avec `.catch(captureWithContext(err, {action, lesson_key}))`

### HTML
- Charger `sentry-init.js` AVANT le code applicatif dans `<head>`
- Cache buster `?v=YYYYMMDDx` sur tous les `.js`/`.css` au deploy
- Modal pattern : `.modal-bg.open` (pas `.show`)

### CSS
- Theme dark XGuard : bg `#0A0E1A`, accent `#E74C3C`, success `#2ECC71`, warning `#F39C12`
- Reutiliser les variables/classes de `review.css` quand possible

### Migrations Supabase
- Toujours appliquer sur staging d'abord
- Documenter dans le commit + RUNBOOK
- Eviter `DROP` sans backup recent
- Ajouter `IF NOT EXISTS` pour les CREATE

## Architecture decisions

Voir RUNBOOK.md section "Architecture".
