/**
 * lib/journal-logic.js — Ce que devient CHAQUE correction, et pourquoi.
 *
 * POURQUOI CETTE PAGE EXISTE. Hela travaille sur trois circuits — le crayon
 * (sentence_flags), les demandes (correction_requests), l'atelier du son
 * (studio_decisions) — et chacun ecrit consciencieusement la RAISON de ses refus dans
 * une colonne (`skip_reason`, `reason`, `note`). Aucune de ces raisons n'etait affichee
 * nulle part. Le cockpit requete meme `reason` sans jamais l'imprimer.
 *
 * Resultat : sur 7 jours (mesure le 2026-08-21) 44 % de son travail a l'atelier du son
 * et 11 % au crayon mouraient sans qu'elle puisse savoir lequel, ni pourquoi. Elle
 * redeposait le meme mot quatre fois de suite.
 *
 * Ce module transforme les trois tables en UNE liste homogene. Il est pur et testable :
 * aucune requete, aucun DOM.
 *
 * Export double navigateur (window.XGJournal) / Node (require).
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.XGJournal = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // Trois seuls verdicts, parce que c'est la seule question qui compte :
  //   abouti   — c'est fait, elle peut passer a autre chose
  //   en-cours — la machine s'en occupe, il n'y a rien a faire
  //   mort     — ca n'aboutira pas tout seul ; la RAISON dit quoi faire
  var ABOUTI = 'abouti', EN_COURS = 'en-cours', MORT = 'mort';

  function lessonCourt(k) {
    var p = String(k || '').split('/');
    return p.length > 2 ? p.slice(1).join('/') : String(k || '');
  }

  /** Un flag du crayon (sentence_flags) -> ligne de journal. */
  function duCrayon(f) {
    var etat, cat, raison = f.skip_reason || null;
    if (f.applied) { etat = 'Corrigée'; cat = ABOUTI; raison = null; }
    // Pour ces deux-la, l'etat dit deja tout. La colonne skip_reason ne contient que du
    // jargon interne (« re-roll voix demande via correction_requests (intent glitch) ») :
    // l'afficher ajoute du bruit sans rien apprendre a personne.
    else if (f.auto_status === 'converted') { etat = 'Voix à refaire — envoyée au re-roll'; cat = EN_COURS; raison = null; }
    else if (f.auto_status === 'superseded') { etat = 'Remplacée par un renvoi'; cat = EN_COURS; raison = null; }
    else if (f.auto_status === 'skipped') { etat = 'Pas appliquée'; cat = MORT; }
    else if (f.auto_status === 'dismissed') { etat = 'Non retenue'; cat = MORT; }
    else if (f.auto_status === 'obsolete') { etat = 'Obsolète — la voix a été refaite depuis'; cat = MORT; }
    else if (f.auto_status === 'processing') { etat = 'En cours…'; cat = EN_COURS; }
    else { etat = 'En file'; cat = EN_COURS; }
    return {
      quand: f.created_at,
      circuit: 'crayon',
      lecon: lessonCourt(f.lesson_key),
      lessonKey: f.lesson_key,
      quoi: f.original_text || f.partial_original || ('phrase ' + (f.sentence_index != null ? f.sentence_index : '?')),
      vers: f.corrected_text || f.partial_replacement || null,
      qui: f.reviewer_name || null,
      etat: etat,
      categorie: cat,
      raison: raison,
      ref: '#' + f.id,
    };
  }

  /** Une demande de correction -> ligne de journal. */
  function desDemandes(r) {
    var etat, cat, raison = r.reason || r.last_error || null;
    if (r.status === 'done') { etat = 'Corrigée'; cat = ABOUTI; raison = null; }
    else if (r.status === 'superseded') { etat = "Doublon — c'est l'autre demande qui fait le travail"; cat = EN_COURS; }
    else if (r.status === 'needs_review') { etat = 'Chez Nicolas — à trancher à la main'; cat = MORT; }
    else if (r.status === 'error') { etat = 'Erreur'; cat = MORT; }
    else if (r.status === 'processing') { etat = 'En cours…'; cat = EN_COURS; }
    else { etat = 'En file'; cat = EN_COURS; }
    return {
      quand: r.created_at,
      circuit: 'demande',
      lecon: lessonCourt(r.lesson_key),
      lessonKey: r.lesson_key,
      quoi: r.correction_note || r.phrase_text || '—',
      vers: null,
      qui: r.requested_by || null,
      etat: etat,
      categorie: cat,
      raison: raison,
      ref: String(r.id || '').slice(0, 8),
    };
  }

  /**
   * Une decision de l'atelier du son -> ligne de journal.
   *
   * Cas particulier : `applied` avec une note. Depuis le 2026-08-21 le worker n'ecrit
   * plus `applied` qu'APRES avoir tente la regeneration, et pose une note quand la regle
   * est bien au dictionnaire mais que l'audio deja en ligne n'a PAS ete refait. C'est une
   * demi-reussite — la dire « corrigée » tout court serait remettre le mensonge qu'on
   * vient de retirer.
   */
  function delAtelier(d) {
    var etat, cat, raison = d.note || null;
    if (d.status === 'applied' && d.note) { etat = 'Règle posée — audio pas encore refait'; cat = MORT; }
    else if (d.status === 'applied') { etat = 'Appliquée'; cat = ABOUTI; raison = null; }
    else if (d.status === 'needs_source') { etat = 'À corriger dans le texte, pas au dictionnaire'; cat = MORT; }
    else if (d.status === 'rejected') { etat = 'Refusée'; cat = MORT; }
    else if (d.status === 'error') { etat = 'Erreur'; cat = MORT; }
    else { etat = 'En cours…'; cat = EN_COURS; }
    return {
      quand: d.created_at,
      circuit: 'atelier',
      lecon: null,
      lessonKey: null,
      quoi: d.word || '—',
      vers: d.spelling || null,
      qui: d.decided_by || null,
      etat: etat,
      categorie: cat,
      raison: raison,
      ref: String(d.id || '').slice(0, 8),
    };
  }

  /** Fusionne les trois sources en une liste, la plus recente d'abord. */
  function construire(flags, demandes, decisions) {
    var out = []
      .concat((flags || []).map(duCrayon))
      .concat((demandes || []).map(desDemandes))
      .concat((decisions || []).map(delAtelier));
    out.sort(function (a, b) { return String(b.quand).localeCompare(String(a.quand)); });
    return out;
  }

  /** Compte par verdict, pour le bandeau du haut. */
  function bilan(lignes) {
    var b = { total: 0, abouti: 0, enCours: 0, mort: 0 };
    (lignes || []).forEach(function (l) {
      b.total++;
      if (l.categorie === ABOUTI) b.abouti++;
      else if (l.categorie === EN_COURS) b.enCours++;
      else b.mort++;
    });
    b.pourcentMort = b.total ? Math.round((b.mort / b.total) * 100) : 0;
    return b;
  }

  /** Filtre : catégorie ('tout' | abouti | en-cours | mort) et personne. */
  function filtrer(lignes, categorie, personne) {
    return (lignes || []).filter(function (l) {
      if (categorie && categorie !== 'tout' && l.categorie !== categorie) return false;
      if (personne && personne !== 'tout') {
        var q = String(l.qui || '').trim().toLowerCase();
        if (q !== String(personne).trim().toLowerCase()) return false;
      }
      return true;
    });
  }

  /** Les personnes vues dans la liste, pour alimenter le sélecteur. */
  function personnes(lignes) {
    var vues = {};
    (lignes || []).forEach(function (l) {
      var q = String(l.qui || '').trim();
      if (q) vues[q] = 1;
    });
    return Object.keys(vues).sort();
  }

  return {
    ABOUTI: ABOUTI, EN_COURS: EN_COURS, MORT: MORT,
    duCrayon: duCrayon, desDemandes: desDemandes, delAtelier: delAtelier,
    construire: construire, bilan: bilan, filtrer: filtrer, personnes: personnes,
  };
});
