## Description

<!-- Resume des changements en 1-2 phrases -->

## Type de changement

- [ ] Fix bug (changement non-breaking qui repare un probleme)
- [ ] Nouvelle feature (ajout d'une fonctionnalite)
- [ ] Breaking change (modification qui casse l'existant)
- [ ] Documentation
- [ ] Refactoring (sans changement de comportement)
- [ ] Securite/RLS

## Checklist avant merge

### Tests basiques
- [ ] Le code passe le lint (CI vert)
- [ ] Sentry capture les erreurs des nouveaux fetch (wrap avec try/catch ou .catch)
- [ ] Le voice review (`review.html`) fonctionne toujours
- [ ] Le video review (`review-video.html`) fonctionne toujours
- [ ] La liste des cours (`course.html`) fonctionne toujours

### Tests staging
- [ ] J'ai pousse sur une branche `feature/xxx`
- [ ] Le deploy staging a tourne (workflow `Deploy Staging` vert)
- [ ] J'ai teste sur l'URL staging : ___________________
- [ ] Pas d'erreur Sentry nouvelle

### Si change le schema Supabase
- [ ] Migration SQL applique sur staging d'abord
- [ ] Migration testee avant prod
- [ ] Vue `lesson_status` (originale) toujours fonctionnelle
- [ ] RLS policies maintenues

### Si change l'API LMS
- [ ] Format payload `lms/ghl-payload.js` toujours compatible
- [ ] Test export GHL sur 1 lesson + 1 cours complet

## Label staging-validated

Apres tests staging OK, ajouter le label **`staging-validated`** sur cette PR avant merge.

(Le workflow CI verifie ce label avant de permettre le merge — voir `.github/workflows/deploy-prod.yml`.)
