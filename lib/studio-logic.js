/**
 * lib/studio-logic.js — Logique pure de l'Atelier du son (studio.html).
 * Export double navigateur (window.XGStudio) / Node (require), comme review-logic.js.
 *
 * Plainte de Rawen du 2026-10-30 : « le changement ne semble pas etre applique et la
 * prononciation reste la meme ». Ce que la page lui montrait ne lui permettait pas de
 * savoir ce qui se passait :
 *  - le mot tel quel etait propose avec un bouton « C'est celle-ci » ; le choisir ne
 *    changeait rien, et le worker repondait « identite from = to » (4 fois le 10-26) ;
 *  - apres un choix, « Appliqué au dictionnaire. Les prochaines générations diront la
 *    bonne version » — que la voix de SA lecon soit refaite ou non. Elle reecoutait la
 *    meme voix (« Puis on redescend. » : regle a 10 h 48, voix refaite a 17 h 39).
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.XGStudio = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // Meme regle que pipeline/scripts/lib/regle-phrase.mjs (estVersionOrigine) : casse, gras
  // et ponctuation de bordure ignores (le dico ignore la casse) ; les accents comptent
  // (« Ton » -> « Tôn » est un vrai choix).
  function nu(s) {
    return String(s == null ? '' : s)
      .replace(/\*+/g, '')
      .normalize('NFC')
      .trim()
      .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
      .toLowerCase();
  }
  function estVersionOrigine(mot, graphie) {
    var a = nu(mot);
    return !!a && a === nu(graphie);
  }

  // « 14:32 » a l'heure de Montreal.
  function heure(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d
      .toLocaleTimeString('fr-CA', { timeZone: 'America/Montreal', hour: '2-digit', minute: '2-digit', hour12: false })
      .replace(/\s*h\s*/, ':');
  }

  /**
   * Etat d'une decision tel que la reviseure doit le lire.
   * @param {object} d  ligne studio_decisions (status, note, applied_section, regen_*)
   * @returns {{t:string, c:string, fini:boolean, reecouter:boolean}}
   *   c = classe CSS (pending | done | warn), fini = arreter de sonder,
   *   reecouter = afficher le lien vers la lecon.
   */
  function etatDecision(d) {
    d = d || {};
    var note = d.note ? String(d.note) : '';
    if (d.status === 'pending' || !d.status) {
      return { t: '⏳ Choix reçu — le worker l’applique (quelques secondes)…', c: 'pending', fini: false, reecouter: false };
    }
    if (d.status === 'rejected') {
      return { t: '⛔ Pas appliqué : ' + note, c: 'warn', fini: true, reecouter: false };
    }
    if (d.status === 'needs_source') {
      return { t: '📝 ' + (note || 'À corriger dans la phrase de la leçon.'), c: 'warn', fini: true, reecouter: false };
    }
    if (d.status === 'error') {
      return { t: '⚠ Erreur : ' + note, c: 'warn', fini: true, reecouter: false };
    }
    if (d.status === 'applied') {
      var regle = note ? '✅ ' + note : '✅ Appliqué au dictionnaire.';
      // Sans la migration 024 (pas de regen_status), la note du worker dit deja si la voix
      // a ete refaite : on l'affiche telle quelle.
      if (d.regen_status === undefined || d.regen_status === null) {
        return { t: regle, c: 'done', fini: true, reecouter: /refaite a/.test(note) };
      }
      if (d.regen_status === 'running') {
        return {
          t: regle + ' 🔄 Voix de la leçon en cours de régénération (environ une minute)… Reste ici, ça se met à jour tout seul.',
          c: 'pending',
          fini: false,
          reecouter: false,
        };
      }
      if (d.regen_status === 'done') {
        var h = heure(d.regen_done_at);
        return {
          t: regle + ' 🎧 Voix refaite' + (h ? ' à ' + h : '') + ' : tu peux réécouter la leçon (recharge sa page).',
          c: 'done',
          fini: true,
          reecouter: true,
        };
      }
      if (d.regen_status === 'skipped') {
        return { t: regle + ' ⏸ Voix pas refaite : ' + (d.regen_note || 'leçon non retrouvée') + '.', c: 'warn', fini: true, reecouter: false };
      }
      if (d.regen_status === 'failed') {
        return {
          t: regle + ' ⚠ La voix n’a pas pu être refaite (' + (d.regen_note || 'erreur') + '). Nicolas est averti ; passe à la suite.',
          c: 'warn',
          fini: true,
          reecouter: false,
        };
      }
      return { t: regle, c: 'done', fini: true, reecouter: false };
    }
    return { t: note, c: 'pending', fini: false, reecouter: false };
  }

  /**
   * Classe les versions recues du worker pour l'affichage : le mot TEL QUEL sert de
   * reference (« son d'aujourd'hui »), jamais de choix. Les versions « dans la phrase »
   * (kind 'phrase') sont mises en premier : c'est la que le defaut s'entend.
   */
  function rangerVersions(mot, versions) {
    return (versions || [])
      .map(function (v) {
        return { v: v, origine: estVersionOrigine(mot, v.spelling), phrase: v.kind === 'phrase' };
      })
      .sort(function (a, b) {
        if (a.phrase !== b.phrase) return a.phrase ? -1 : 1;
        if (a.origine !== b.origine) return a.origine ? -1 : 1;
        return 0;
      });
  }

  return { estVersionOrigine: estVersionOrigine, etatDecision: etatDecision, rangerVersions: rangerVersions, heure: heure };
});
