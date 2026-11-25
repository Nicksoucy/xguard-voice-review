/**
 * lib/presence.js — Temps de revue réel (2026-11-25, demande de Nicolas).
 *
 * Avant : l'app n'enregistrait que les gestes (approuver, flagger, corriger). Le temps
 * passé se devinait à l'heure des gestes ; une heure d'écoute sans rien valider ne
 * laissait aucune trace.
 *
 * Ici : toutes les 20 s, si la personne est ACTIVE, on envoie la minute en cours dans la
 * table reviewer_presence (une ligne par personne et par minute, doublons ignorés par la
 * base). Temps actif du jour = nombre de minutes (vue temps_revue_jour, migration 034).
 *
 * Active = onglet visible ET (un audio ou une vidéo joue OU un geste — clic, touche,
 * défilement, souris — dans les 2 dernières minutes). Un onglet oublié ouvert ne compte
 * donc pas. Sans nom (« Ton nom » vide), rien n'est envoyé.
 *
 * Un échec d'envoi ne dérange JAMAIS la réviseuse : pas de bandeau, juste la console.
 * Une minute perdue est sans gravité.
 *
 * Export double navigateur (window.XGPresence) / Node (require) : la logique pure est
 * testée par vitest (tests/unit/presence.test.mjs).
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.XGPresence = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  var INACTIF_APRES_MS = 2 * 60 * 1000;
  var TICK_MS = 20 * 1000;

  // ── Logique pure ─────────────────────────────────────────────────

  function estActif(etat) {
    if (!etat || !etat.visible) return false;
    if (etat.mediaEnCours) return true;
    if (!etat.derniereInteraction) return false;
    return etat.maintenant - etat.derniereInteraction <= INACTIF_APRES_MS;
  }

  // Début de la minute (ISO, UTC) qui contient `ms`.
  function minuteDe(ms) {
    return new Date(Math.floor(ms / 60000) * 60000).toISOString();
  }

  // Type de page, d'après le chemin : sert à séparer le temps voix / vidéo / cockpit.
  function typePage(chemin) {
    var p = String(chemin || '');
    var en = /\/en\//.test(p);
    if (/review-video\.html$/.test(p)) return en ? 'video-en' : 'video';
    if (/review\.html$/.test(p)) return en ? 'voice-en' : 'voix';
    if (/studio\.html$/.test(p)) return 'studio';
    if (/journal\.html$/.test(p)) return 'journal';
    if (/course\.html$/.test(p)) return 'formation';
    return en ? 'accueil-en' : 'cockpit';
  }

  // Ligne à envoyer, ou null s'il n'y a rien à envoyer (inactive, sans nom, minute déjà partie).
  function ligneAEnvoyer(etat, nom, derniereMinuteEnvoyee, page, lessonKey) {
    var n = String(nom || '').trim();
    if (!n || !estActif(etat)) return null;
    var minute = minuteDe(etat.maintenant);
    if (minute === derniereMinuteEnvoyee) return null;
    return { reviewer_name: n.slice(0, 80), minute: minute, page: page || null, lesson_key: lessonKey || null };
  }

  // « 1 h 35 », « 42 min », « 0 min ».
  function dureeEnMots(minutes) {
    var m = Math.max(0, Math.round(minutes || 0));
    if (m < 60) return m + ' min';
    var h = Math.floor(m / 60), r = m % 60;
    return h + ' h' + (r ? ' ' + String(r).padStart(2, '0') : '');
  }

  var pur = {
    estActif: estActif,
    minuteDe: minuteDe,
    typePage: typePage,
    ligneAEnvoyer: ligneAEnvoyer,
    dureeEnMots: dureeEnMots,
    INACTIF_APRES_MS: INACTIF_APRES_MS,
  };

  // ── Partie navigateur ────────────────────────────────────────────

  if (typeof window === 'undefined' || typeof document === 'undefined') return pur;

  function config() {
    if (window.XG && window.XG.API && window.XG.H) return { api: window.XG.API, h: window.XG.H };
    if (typeof window.API === 'string' && window.H) return { api: window.API, h: window.H };
    return null;
  }

  function nomCourant() {
    try {
      return (localStorage.getItem('rn') || '').trim();
    } catch (e) {
      console.warn('[presence] localStorage indisponible', e);
      return '';
    }
  }

  function lessonKeyCourante() {
    try {
      return new URLSearchParams(location.search).get('key') || null;
    } catch (e) {
      console.warn('[presence] URL illisible', e);
      return null;
    }
  }

  function mediaEnCours() {
    var m = document.querySelectorAll('audio, video');
    for (var i = 0; i < m.length; i++) {
      if (!m[i].paused && !m[i].ended && m[i].readyState > 2) return true;
    }
    return false;
  }

  var derniereInteraction = 0;
  var derniereMinute = null;
  function geste() {
    var premier = !derniereInteraction;
    derniereInteraction = Date.now();
    if (premier) tick();
  }
  ['pointerdown', 'keydown', 'wheel', 'scroll', 'touchstart', 'mousemove'].forEach(function (ev) {
    window.addEventListener(ev, geste, { passive: true, capture: true });
  });
  // Lecture d'un média = activité (l'évènement « play » ne remonte pas : capture).
  document.addEventListener('play', geste, true);

  function tick() {
    var cfg = config();
    if (!cfg) return;
    var ligne = ligneAEnvoyer(
      {
        visible: document.visibilityState === 'visible',
        mediaEnCours: mediaEnCours(),
        derniereInteraction: derniereInteraction,
        maintenant: Date.now(),
      },
      nomCourant(),
      derniereMinute,
      typePage(location.pathname),
      lessonKeyCourante(),
    );
    if (!ligne) return;
    derniereMinute = ligne.minute;
    fetch(cfg.api + '/reviewer_presence', {
      method: 'POST',
      keepalive: true,
      headers: Object.assign({}, cfg.h, {
        'Content-Type': 'application/json',
        Prefer: 'resolution=ignore-duplicates,return=minimal',
      }),
      body: JSON.stringify(ligne),
    })
      .then(function (r) {
        if (!r.ok) console.warn('[presence] envoi refusé', r.status);
      })
      .catch(function (e) {
        // Minute perdue : sans gravité, on réessaiera à la minute suivante.
        console.warn('[presence] envoi impossible', e);
        derniereMinute = null;
      });
  }

  setInterval(tick, TICK_MS);
  document.addEventListener('visibilitychange', tick);

  return Object.assign({ tick: tick }, pur);
});
