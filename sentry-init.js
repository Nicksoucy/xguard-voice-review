/**
 * sentry-init.js — Configuration Sentry post-loader.
 *
 * Le script loader CDN (sentry-cdn.com/HASH.min.js) auto-initialise Sentry
 * avec le DSN integre dans le hash. On configure ici :
 * - environment (prod vs staging vs local)
 * - tags par defaut (reviewer, page)
 * - sample rates
 * - filtres d'erreurs bruyantes
 *
 * Doit etre charge APRES le script loader Sentry mais AVANT le code applicatif.
 */

(function() {
  // Detection automatique de l'environnement
  function detectEnvironment() {
    var host = location.hostname || '';
    var path = location.pathname || '';
    if (host === '' || host === 'localhost' || host === '127.0.0.1') return 'local';
    if (path.indexOf('staging') !== -1 || host.indexOf('staging') !== -1) return 'staging';
    if (host === 'nicksoucy.github.io') return 'production';
    return 'unknown';
  }

  var env = detectEnvironment();
  window.SENTRY_ENV = env;

  // Override credentials Supabase pour staging
  // - Staging utilise un projet Supabase distinct (pekkskvpttzgqxjaqvzf)
  // - Les variables SUPA_URL_OVERRIDE et SUPA_KEY_OVERRIDE sont lues par
  //   review.js, review-video.js, course.html, index.html dans cet ordre :
  //     var SUPA_URL = window.SUPA_URL_OVERRIDE || 'https://ctjsdpfegpsfpwjgusyi...';
  if (env === 'staging') {
    window.SUPA_URL_OVERRIDE = 'https://pekkskvpttzgqxjaqvzf.supabase.co';
    window.SUPA_KEY_OVERRIDE = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBla2tza3ZwdHR6Z3F4amFxdnpmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgzMjgxOTMsImV4cCI6MjA5MzkwNDE5M30.QIUJRKleQkA0d82XM1ApevBsWd3981_mEComPcMvsUc';
    console.log('[Staging] Using Supabase staging project:', window.SUPA_URL_OVERRIDE);
  }

  // Si Sentry n'est pas charge (script CDN bloque par adblocker, offline, etc),
  // on cree un stub silencieux pour eviter les erreurs "Sentry is not defined".
  if (typeof Sentry === 'undefined') {
    window.Sentry = {
      init: function(){},
      captureException: function(err){ console.error('[Sentry stub]', err); },
      captureMessage: function(msg){ console.log('[Sentry stub]', msg); },
      addBreadcrumb: function(){},
      setTag: function(){},
      setContext: function(){},
      setUser: function(){},
      withScope: function(cb){ cb({setTag:function(){}, setContext:function(){}, setExtra:function(){}}); }
    };
    return;
  }

  // Le loader CDN deja init Sentry. On utilise onLoad pour configurer apres init.
  // Si Sentry.onLoad n'existe pas (Sentry charge differemment), on configure direct.
  function configure() {
    // Override config par defaut du loader pour ajuster sample rates et filtres
    if (Sentry.getCurrentHub && Sentry.getCurrentHub().getClient) {
      var client = Sentry.getCurrentHub().getClient();
      if (client) {
        var opts = client.getOptions();
        opts.environment = env;
        opts.release = 'xguard-voice-review@2026.05';
        opts.tracesSampleRate = env === 'production' ? 0.1 : 1.0;
        opts.ignoreErrors = (opts.ignoreErrors || []).concat([
          'ResizeObserver loop limit exceeded',
          'Non-Error promise rejection captured',
          /^Script error\.?$/
        ]);
        // En local, on n'envoie rien
        if (env === 'local') {
          opts.beforeSend = function(event) {
            console.log('[Sentry local] Skipped:', event.message || event.exception);
            return null;
          };
        }
      }
    }

    // Tag global : reviewer name (depuis localStorage)
    try {
      var rn = localStorage.getItem('rn');
      if (rn) {
        Sentry.setUser({ username: rn });
        Sentry.setTag('reviewer_name', rn);
      }
    } catch (e) {}

    // Tag global : environnement + page courante
    Sentry.setTag('environment', env);
    var page = location.pathname.split('/').pop().replace('.html', '') || 'index';
    Sentry.setTag('page', page);

    // Tag global : lesson_key si present dans l'URL
    try {
      var params = new URLSearchParams(location.search);
      var lessonKey = params.get('key');
      if (lessonKey) Sentry.setTag('lesson_key', lessonKey);
      var courseId = params.get('course');
      if (courseId) Sentry.setTag('course_id', courseId);
    } catch (e) {}

    console.log('[Sentry] configured in env:', env);
  }

  // Sentry.onLoad est defini par le loader CDN
  if (Sentry.onLoad) {
    Sentry.onLoad(configure);
  } else {
    configure();
  }

  // Helper global : wrap un fetch Supabase REST avec capture auto.
  // Usage:
  //   fetchWithSentry(url, opts, {action: 'save_review', lesson_key: '...'})
  //     .then(r => r.json())
  //     .catch(e => alert('Erreur — Nicolas a ete notifie'))
  window.fetchWithSentry = function(url, opts, context) {
    var ctx = context || {};
    return fetch(url, opts)
      .then(function(r) {
        if (!r.ok) {
          // HTTP 4xx/5xx — on capture mais on retourne quand meme la response
          // pour que le caller puisse decider quoi faire (ex: fallback)
          var err = new Error('HTTP ' + r.status + ' on ' + (ctx.action || url));
          if (typeof Sentry !== 'undefined' && Sentry.withScope) {
            Sentry.withScope(function(scope){
              Object.keys(ctx).forEach(function(k){ scope.setTag(k, String(ctx[k])); });
              scope.setExtra('status', r.status);
              scope.setExtra('url', url);
              Sentry.captureException(err);
            });
          }
        }
        return r;
      })
      .catch(function(err) {
        // Network error (offline, DNS, CORS)
        if (typeof Sentry !== 'undefined' && Sentry.withScope) {
          Sentry.withScope(function(scope){
            Object.keys(ctx).forEach(function(k){ scope.setTag(k, String(ctx[k])); });
            scope.setExtra('url', url);
            scope.setTag('error_type', 'network');
            Sentry.captureException(err);
          });
        }
        throw err;
      });
  };

  // Helper global : capture manuelle avec contexte
  // Usage: captureWithContext(err, {action:'flag_word', lesson_key:'...', word:'...'})
  window.captureWithContext = function(err, context) {
    if (typeof Sentry === 'undefined' || !Sentry.withScope) return;
    var ctx = context || {};
    Sentry.withScope(function(scope){
      Object.keys(ctx).forEach(function(k){
        scope.setTag(k, String(ctx[k]));
      });
      Sentry.captureException(err);
    });
  };
})();
