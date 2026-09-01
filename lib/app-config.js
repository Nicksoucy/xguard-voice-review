/**
 * lib/app-config.js — Configuration Supabase PARTAGÉE par toutes les pages du cockpit.
 *
 * À charger EN PREMIER (avant tout autre script) dans chaque page. Évite de re-copier
 * l'URL + la clé anon dans 6 fichiers. Expose window.XG :
 *   XG.SUPA_URL, XG.SUPA_KEY, XG.API (base REST), XG.H (headers), XG.api(pathAndQuery, opts)
 *   XG.apiAll(pathAndQuery) — GET PAGINE, obligatoire des qu'une table peut depasser
 *   1000 lignes : PostgREST tronque silencieusement au-dela. Voir le commentaire sur apiAll.
 *
 * On garde la compat avec les overrides de test (window.SUPA_URL_OVERRIDE / SUPA_KEY_OVERRIDE).
 */
(function () {
  var SUPA_URL = window.SUPA_URL_OVERRIDE || 'https://ctjsdpfegpsfpwjgusyi.supabase.co';
  var SUPA_KEY =
    window.SUPA_KEY_OVERRIDE ||
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN0anNkcGZlZ3BzZnB3amd1c3lpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM2MDU2NDQsImV4cCI6MjA4OTE4MTY0NH0.Uv2pbxbmvcbXhyDa7Y_M0HqkLuV7uJaNxl1N01q5wMo';
  var API = SUPA_URL + '/rest/v1';
  var H = { apikey: SUPA_KEY, Authorization: 'Bearer ' + SUPA_KEY };

  // GET + JSON avec gestion d'erreur. pathAndQuery = "table?select=...&col=eq.x"
  function api(pathAndQuery, opts) {
    return fetch(API + '/' + pathAndQuery, Object.assign({ headers: H }, opts || {})).then(
      function (r) {
        if (!r.ok) throw new Error('Supabase HTTP ' + r.status + ' on ' + pathAndQuery);
        return r.status === 204 ? null : r.json();
      },
    );
  }

  // GET PAGINE — a utiliser des qu'une table peut depasser 1000 lignes.
  //
  // POURQUOI. PostgREST plafonne TOUTE reponse a 1000 lignes (db-max-rows) et le
  // signale seulement dans l'entete Content-Range (« 0-999/1090 »). Un fetch naif ne
  // regarde pas cet entete : il recoit 1000 lignes, ne voit aucune erreur, et croit
  // avoir tout. La panne est donc SILENCIEUSE.
  // Vecu le 2026-08-29 : lesson_status_full est passee a 1090 lignes, le cockpit en
  // chargeait 1000, et les 3 formations produites cette semaine-la (gestion-stress,
  // transpalette, sauvetage-hauteur) etaient invisibles dans la file de revision
  // d'Hela alors que leurs voix etaient publiees et jouables. Aucun message d'erreur,
  // aucun compteur a zero : les cours n'existaient simplement pas pour l'app.
  //
  // ORDRE OBLIGATOIRE. La pagination par limit/offset n'est fiable que si la requete
  // porte un ORDRE TOTAL (donc se terminant par une colonne unique). Sans ca, deux
  // lignes ex aequo peuvent changer de page entre deux appels : on obtient des
  // doublons et des trous. Terminer l'order par une cle unique — pour
  // lesson_status_full, c'est lesson_key.
  function apiAll(pathAndQuery, pageSize) {
    var STEP = pageSize || 1000;
    var MAX_PAGES = 50; // garde-fou : 50 000 lignes, tres au-dessus du catalogue reel
    var out = [];
    if (pathAndQuery.indexOf('order=') === -1) {
      throw new Error('apiAll exige un order unique (sinon doublons/trous) : ' + pathAndQuery);
    }
    function page(offset, n) {
      if (n >= MAX_PAGES) {
        console.warn('[apiAll] plafond de ' + MAX_PAGES + ' pages atteint sur ' + pathAndQuery);
        return out;
      }
      var sep = pathAndQuery.indexOf('?') === -1 ? '?' : '&';
      var url = API + '/' + pathAndQuery + sep + 'limit=' + STEP + '&offset=' + offset;
      return fetch(url, { headers: H })
        .then(function (r) {
          if (!r.ok) throw new Error('Supabase HTTP ' + r.status + ' on ' + pathAndQuery);
          return r.json();
        })
        .then(function (rows) {
          out = out.concat(rows);
          // Page pleine = il y en a peut-etre une autre. Page partielle = c'est fini.
          return rows.length === STEP ? page(offset + STEP, n + 1) : out;
        });
    }
    return Promise.resolve().then(function () {
      return page(0, 0);
    });
  }

  window.XG = {
    SUPA_URL: SUPA_URL,
    SUPA_KEY: SUPA_KEY,
    API: API,
    H: H,
    api: api,
    apiAll: apiAll,
  };
})();
