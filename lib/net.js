/**
 * lib/net.js — UN SEUL utilitaire d'appel reseau pour l'app (chantier 03, 2026-11-10).
 *
 * Avant : chaque page faisait ses fetch a la main, avec 12 catch vides. Une panne reseau
 * laissait « Chargement... » pour toujours, s'affichait « Voiceover pas encore approuve »,
 * ou faisait clignoter « Erreur — Nicolas a ete notifie » 2,5 s. La reviseuse ne savait
 * jamais si son travail etait parti.
 *
 * Ici, trois regles :
 *   1. Reessai automatique quand ca vaut la peine (reseau coupe, 408, 429, 5xx) — jamais
 *      sur un 4xx, la demande elle-meme est fausse.
 *   2. Echec final = un bandeau rouge EN HAUT DE LA PAGE qui RESTE, avec un bouton
 *      « Réessayer ». Il disparait tout seul quand l'appel finit par passer.
 *   3. Rien n'est avale : chaque echec part dans la console et dans Sentry.
 *
 * Retour connexion (evenement « online ») : on relance tout seul les essais en attente.
 *
 * Export double navigateur (window.XGNet) / Node (require) : la logique pure est testee
 * par vitest (tests/unit/net.test.mjs), la partie navigateur par Playwright.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.XGNet = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // ── Logique pure ─────────────────────────────────────────────────

  // Reessayer automatiquement ? 0 = reseau coupe (fetch a leve une exception).
  function estReessayable(status) {
    return status === 0 || status === 408 || status === 429 || status >= 500;
  }

  // Delai avant le n-ieme reessai (n = 1, 2, 3...) : 1,5 s, 4 s, puis 8 s.
  function delaiReessai(n) {
    var paliers = [1500, 4000, 8000];
    return paliers[Math.max(0, Math.min(n - 1, paliers.length - 1))];
  }

  // Message lisible pour la reviseuse. `action` est un verbe a l'infinitif
  // (« enregistrer ta revue », « charger la leçon »).
  function messageErreur(action, err) {
    var quoi = action ? 'Pas pu ' + action : 'Un appel au serveur a échoué';
    if (!err || !err.status) {
      return quoi + ' : pas de connexion avec le serveur. Vérifie ton internet.';
    }
    return quoi + ' : le serveur a répondu une erreur (code ' + err.status + ').';
  }

  // Age d'un battement de robot, en minutes et en mots.
  function ageEnMots(minutes) {
    if (minutes < 1) return 'il y a moins d’une minute';
    if (minutes < 60) return 'il y a ' + Math.round(minutes) + ' min';
    var h = minutes / 60;
    if (h < 48) return 'il y a ' + Math.round(h) + ' h';
    return 'il y a ' + Math.round(h / 24) + ' jours';
  }

  // Etat d'un robot a partir des lignes watchdog_heartbeat : on prend le battement le plus
  // recent parmi les ids qui commencent par `prefixe` (ex. « xguard-correction » couvre
  // xguard-correction@mac et @nitro). Vivant = battement de moins de `seuilMin` minutes.
  // Limite connue (chantier 02) : une machine peut battre sans traiter la file ; ce
  // battement dit seulement que le robot tourne, pas qu'il prendra ta demande.
  function etatRobot(rows, prefixe, nowMs, seuilMin) {
    var seuil = seuilMin || 15;
    var dernier = null;
    (rows || []).forEach(function (r) {
      if (!r || !r.id || !r.last_heartbeat) return;
      if (String(r.id).indexOf(prefixe) !== 0) return;
      var t = new Date(r.last_heartbeat).getTime();
      if (!isNaN(t) && (dernier === null || t > dernier)) dernier = t;
    });
    if (dernier === null) return { connu: false, vivant: false, ageMin: null, age: '' };
    var ageMin = Math.max(0, (nowMs - dernier) / 60000);
    return { connu: true, vivant: ageMin <= seuil, ageMin: ageMin, age: ageEnMots(ageMin) };
  }

  // ── Partie navigateur ────────────────────────────────────────────

  var erreurs = {}; // cle -> { message, reessayer, enCours }

  function signaler(e, contexte) {
    try {
      if (typeof console !== 'undefined') console.warn('[XGNet]', contexte || '', e);
      if (typeof window !== 'undefined' && typeof window.captureWithContext === 'function') {
        window.captureWithContext(e instanceof Error ? e : new Error(String(e)), { action: String(contexte || 'inconnu') });
      }
    } catch (e2) {
      // Le rapporteur lui-meme a plante : il ne reste que la console.
      if (typeof console !== 'undefined') console.error('[XGNet] signaler a echoue', e2);
    }
  }

  // Appelle fn() et signale une exception au lieu de l'avaler (remplace les
  // « try { X() } catch (e) {} » qui cachaient les vrais plantages de rendu).
  function essayer(fn, contexte) {
    try {
      return fn();
    } catch (e) {
      signaler(e, contexte);
      return undefined;
    }
  }

  function echapper(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function barre() {
    var el = document.getElementById('xg-net-bar');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'xg-net-bar';
    el.setAttribute('role', 'alert');
    el.style.cssText =
      'position:sticky;top:0;z-index:1000;margin:0 0 12px;display:none;flex-direction:column;gap:6px';
    document.body.insertBefore(el, document.body.firstChild);
    return el;
  }

  function dessiner() {
    if (typeof document === 'undefined' || !document.body) return;
    var el = barre();
    var cles = Object.keys(erreurs);
    if (!cles.length) {
      el.style.display = 'none';
      el.innerHTML = '';
      return;
    }
    el.innerHTML = cles
      .map(function (cle) {
        var x = erreurs[cle];
        var bouton = x.enCours
          ? '<span style="opacity:.85">Nouvel essai automatique…</span>'
          : '<button type="button" data-xg-retry="' + echapper(cle) + '" style="background:#fff;color:#7B1E14;border:none;border-radius:5px;padding:7px 14px;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit">Réessayer</button>';
        return (
          '<div class="xg-net-err" style="background:#7B1E14;border:1px solid #E74C3C;color:#fff;border-radius:8px;padding:10px 14px;font-size:15px;line-height:1.45;display:flex;gap:12px;align-items:center;flex-wrap:wrap">' +
          '<span style="flex:1;min-width:220px">⚠ ' + echapper(x.message) + '</span>' + bouton + '</div>'
        );
      })
      .join('');
    el.style.display = 'flex';
    Array.prototype.forEach.call(el.querySelectorAll('[data-xg-retry]'), function (b) {
      b.onclick = function () {
        relancer(b.getAttribute('data-xg-retry'));
      };
    });
  }

  function relancer(cle) {
    var x = erreurs[cle];
    if (!x) return;
    if (typeof x.reessayer === 'function') {
      x.enCours = true;
      dessiner();
      essayer(x.reessayer, 'reessai ' + cle);
    } else if (typeof location !== 'undefined') {
      // Pas de geste precis a refaire (chargement) : on recharge la page.
      location.reload();
    }
  }

  // Bandeau persistant. `reessayer` = fonction a rappeler (sinon : recharger la page).
  function afficherErreur(cle, message, reessayer) {
    erreurs[cle] = { message: message, reessayer: reessayer || null, enCours: false };
    dessiner();
  }
  function effacerErreur(cle) {
    if (!erreurs[cle]) return;
    delete erreurs[cle];
    dessiner();
  }
  function aDesErreurs() {
    return Object.keys(erreurs).length > 0;
  }

  function attendre(ms) {
    return new Promise(function (res) {
      setTimeout(res, ms);
    });
  }

  // Appel reseau unique de l'app.
  //   init : comme fetch (method, headers, body)
  //   opts : action    — infinitif lisible (« enregistrer ta revue ») pour le bandeau
  //          cle       — identifiant du bandeau (defaut : action) ; un succes l'efface
  //          essais    — nombre total d'essais (defaut : 3 en lecture, 1 en ecriture)
  //          json      — parser la reponse (defaut : oui en lecture GET)
  //          reessayer — fonction du bouton « Réessayer » (defaut : recharger la page)
  //          silencieux— pas de bandeau (la page affiche l'erreur elle-meme)
  // Resout avec les donnees (json) ou la Response ; rejette avec une Error portant .status
  // (0 = reseau coupe). Une reponse non-2xx est TOUJOURS un echec.
  function requete(url, init, opts) {
    init = init || {};
    opts = opts || {};
    var methode = String(init.method || 'GET').toUpperCase();
    var lecture = methode === 'GET' || methode === 'HEAD';
    var essais = opts.essais || (lecture ? 3 : 1);
    var json = opts.json !== undefined ? opts.json : methode === 'GET';
    var cle = opts.cle || opts.action || url.split('?')[0];
    var n = 0;

    function un() {
      n++;
      return fetch(url, init)
        .then(
          function (r) {
            if (!r.ok) {
              var e = new Error('HTTP ' + r.status);
              e.status = r.status;
              throw e;
            }
            return json ? r.json() : r;
          },
          function (e) {
            var err = new Error(e && e.message ? e.message : 'reseau');
            err.status = 0;
            throw err;
          },
        )
        .then(
          function (data) {
            effacerErreur(cle);
            return data;
          },
          function (err) {
            if (err.status === undefined) err.status = 0; // r.json() invalide, etc.
            if (n < essais && estReessayable(err.status)) {
              if (!opts.silencieux) {
                erreurs[cle] = { message: messageErreur(opts.action, err), reessayer: opts.reessayer || null, enCours: true };
                dessiner();
              }
              return attendre(delaiReessai(n)).then(un);
            }
            signaler(err, (opts.action || cle) + ' (' + url.split('?')[0] + ')');
            if (!opts.silencieux) afficherErreur(cle, messageErreur(opts.action, err), opts.reessayer);
            throw err;
          },
        );
    }
    return un();
  }

  // Bouton « leçon suivante » (correctif 11, chantier 03). Cherche dans le cours la prochaine
  // lecon a l'etape `stages` (logique pure : XGReview.prochaineLecon) et remplit le lien
  // `idLien` ; sans suivante, le lien ramene a la page du cours.
  function afficherLeconSuivante(o) {
    var a = document.getElementById(o.idLien);
    if (!a || !o.lecon) return Promise.resolve(null);
    return requete(o.api + '/lesson_status_full?course_id=eq.' + encodeURIComponent(o.lecon.course_id) +
        '&select=lesson_key,sort_order,pipeline_stage', { headers: o.headers }, { action: 'trouver la leçon suivante', silencieux: true, essais: 2 })
      .then(function (rows) {
        var XR = typeof window !== 'undefined' ? window.XGReview : null;
        var cle = XR ? XR.prochaineLecon(rows, o.lecon.lesson_key, o.stages) : null;
        if (cle) {
          a.href = o.page + '?key=' + encodeURIComponent(cle);
          a.textContent = o.texte || 'Leçon suivante →';
        } else {
          a.href = 'course.html?course=' + encodeURIComponent(o.lecon.course_id);
          a.textContent = 'Plus rien à réviser ici — retour au cours';
        }
        a.style.display = 'inline-block';
        return cle;
      }, function (e) { signaler(e, 'lecon suivante'); return null; });
  }

  // Retour du reseau : relancer tout seul ce qui attend un « Réessayer ».
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('online', function () {
      Object.keys(erreurs).forEach(function (cle) {
        if (erreurs[cle] && typeof erreurs[cle].reessayer === 'function') relancer(cle);
      });
    });
  }

  return {
    estReessayable: estReessayable,
    delaiReessai: delaiReessai,
    messageErreur: messageErreur,
    ageEnMots: ageEnMots,
    etatRobot: etatRobot,
    signaler: signaler,
    essayer: essayer,
    requete: requete,
    afficherErreur: afficherErreur,
    effacerErreur: effacerErreur,
    aDesErreurs: aDesErreurs,
    afficherLeconSuivante: afficherLeconSuivante,
  };
});
