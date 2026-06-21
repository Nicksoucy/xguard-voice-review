/**
 * lib/app-config.js — Configuration Supabase PARTAGÉE par toutes les pages du cockpit.
 *
 * À charger EN PREMIER (avant tout autre script) dans chaque page. Évite de re-copier
 * l'URL + la clé anon dans 6 fichiers. Expose window.XG :
 *   XG.SUPA_URL, XG.SUPA_KEY, XG.API (base REST), XG.H (headers), XG.api(pathAndQuery, opts)
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

  window.XG = { SUPA_URL: SUPA_URL, SUPA_KEY: SUPA_KEY, API: API, H: H, api: api };
})();
