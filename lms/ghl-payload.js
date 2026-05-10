/**
 * lms/ghl-payload.js — Generateur de payload Import Courses GHL.
 *
 * Charge depuis Supabase :
 * - lessons (lesson_key, course_id, module_id, title, etc.)
 * - video_metadata (video_path)
 * - voiceover_metadata (storage_path) — fallback si pas de video
 * - courses (title, description, etc.)
 *
 * Genere le format JSON Import Courses GHL :
 * {
 *   locationId: "...",
 *   products: [{
 *     title, description, imageUrl,
 *     categories: [{ title, sequenceNo, visibility, posts: [{title, contentType, ...}] }]
 *   }]
 * }
 *
 * Usage :
 *   var payload = await GhlPayload.buildForCourse('surete-aeroportuaire');
 *   GhlPayload.downloadAsFile(payload, 'surete-aeroportuaire.ghl.json');
 *
 * Pour 1 lecon :
 *   var payload = await GhlPayload.buildForLesson('surete-aeroportuaire/m02/03-application-met-1');
 */

(function() {
  // Global location ID GHL (XGuard Academy production)
  var GHL_LOCATION_ID = 'dfkLurZY2ADWAUZl4zYc';

  // Public Supabase Storage URL
  function videoStorageUrl(SUPA_URL, videoPath) {
    if (!videoPath) return '';
    // video_path peut etre absolute (https://...) ou relative (videos/...)
    if (videoPath.indexOf('http') === 0) return videoPath;
    var clean = videoPath.replace(/^videos\//, '');
    return SUPA_URL + '/storage/v1/object/public/videos/' + clean;
  }

  // Fetch helper avec gestion erreur
  function api(path, opts) {
    var url = (window.SUPA_URL_OVERRIDE || 'https://ctjsdpfegpsfpwjgusyi.supabase.co')
              + '/rest/v1/' + path;
    var key = window.SUPA_KEY_OVERRIDE || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN0anNkcGZlZ3BzZnB3amd1c3lpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM2MDU2NDQsImV4cCI6MjA4OTE4MTY0NH0.Uv2pbxbmvcbXhyDa7Y_M0HqkLuV7uJaNxl1N01q5wMo';
    return fetch(url, Object.assign({
      headers: { apikey: key, Authorization: 'Bearer ' + key }
    }, opts || {})).then(function(r) {
      if (!r.ok) throw new Error('Supabase HTTP ' + r.status + ' on ' + path);
      return r.json();
    });
  }

  /**
   * Build le payload GHL pour UN cours complet.
   * Inclut tous les modules + toutes les lecons (sous-lecons inclues).
   */
  async function buildForCourse(courseId) {
    var SUPA_URL = window.SUPA_URL_OVERRIDE || 'https://ctjsdpfegpsfpwjgusyi.supabase.co';

    // Fetch en parallele : course meta + lessons + video_metadata + voiceover_metadata
    var courseRows = await api('courses?id=eq.' + encodeURIComponent(courseId) + '&select=*');
    if (!courseRows.length) throw new Error('Cours non trouve : ' + courseId);
    var course = courseRows[0];

    // On fetch SEULEMENT les lecons :
    //   - non archivees
    //   - du cours demande
    //   - approved (status = 'approved' dans lesson_status)
    // Ordre : par sort_order (ou module_index + lesson_index)
    var lessons = await api(
      'lesson_status_full?course_id=eq.' + encodeURIComponent(courseId) +
      '&order=sort_order.asc'
    );

    // Filter : seulement les lecons APPROVED voice (minimum) + has_video pour le contenu
    var ready = lessons.filter(function(l) {
      // Au minimum voice approved. Si has_video, on prend la video. Sinon audio.
      return l.status === 'approved';
    });

    if (!ready.length) {
      throw new Error('Aucune lecon approved pour ce cours');
    }

    // Group by module
    var byModule = {};
    ready.forEach(function(l) {
      var key = l.module_id;
      if (!byModule[key]) byModule[key] = { module_id: key, module_index: l.module_index, lessons: [] };
      byModule[key].lessons.push(l);
    });

    var modules = Object.values(byModule).sort(function(a, b) {
      return a.module_index - b.module_index;
    });

    // Build categories (= modules) + posts (= lecons)
    var categories = modules.map(function(mod, modIdx) {
      var moduleTitle = formatModuleTitle(mod);

      var posts = mod.lessons.map(function(l, lessonIdx) {
        var videoUrl = videoStorageUrl(SUPA_URL, l.video_path);

        return {
          title: l.title || l.short_title || l.lesson_key,
          contentType: 'video',
          videoUrl: videoUrl,
          posterImageUrl: '',
          description: l.short_title || '',
          bucketLocation: '',
          sequenceNo: lessonIdx + 1,
          // Metadata XGuard pour traceability
          _xguard_lesson_key: l.lesson_key,
          _xguard_lesson_index: l.lesson_index,
          _xguard_duration_seconds: l.duration_seconds,
          _xguard_voice_approved_at: l.latest_review_at
        };
      });

      return {
        title: moduleTitle,
        sequenceNo: modIdx + 1,
        visibility: 'published',
        posts: posts
      };
    });

    return {
      locationId: GHL_LOCATION_ID,
      products: [{
        title: course.title,
        description: course.subtitle || '',
        imageUrl: '',
        categories: categories
      }],
      // Metadata XGuard
      _xguard_metadata: {
        course_id: courseId,
        generated_at: new Date().toISOString(),
        generated_by: localStorage.getItem('rn') || 'Anonyme',
        total_lessons: ready.length,
        total_modules: modules.length,
        lessons_with_video: ready.filter(function(l){ return !!l.video_path; }).length
      }
    };
  }

  /**
   * Build le payload GHL pour UNE seule lecon.
   * Utile pour push individuel apres approval.
   */
  async function buildForLesson(lessonKey) {
    var rows = await api(
      'lesson_status_full?lesson_key=eq.' + encodeURIComponent(lessonKey) + '&select=*'
    );
    if (!rows.length) throw new Error('Lecon non trouvee : ' + lessonKey);
    var l = rows[0];

    if (l.status !== 'approved') {
      throw new Error('La lecon n\'est pas approved (status: ' + l.status + ')');
    }

    var courseRows = await api('courses?id=eq.' + encodeURIComponent(l.course_id) + '&select=*');
    var course = courseRows[0] || { title: l.course_id, subtitle: '' };

    var SUPA_URL = window.SUPA_URL_OVERRIDE || 'https://ctjsdpfegpsfpwjgusyi.supabase.co';
    var videoUrl = videoStorageUrl(SUPA_URL, l.video_path);

    return {
      locationId: GHL_LOCATION_ID,
      products: [{
        title: course.title,
        description: course.subtitle || '',
        imageUrl: '',
        categories: [{
          title: 'Module ' + l.module_index,
          sequenceNo: l.module_index || 1,
          visibility: 'published',
          posts: [{
            title: l.title || l.short_title,
            contentType: 'video',
            videoUrl: videoUrl,
            posterImageUrl: '',
            description: l.short_title || '',
            bucketLocation: '',
            sequenceNo: 1,
            _xguard_lesson_key: l.lesson_key,
            _xguard_lesson_index: l.lesson_index
          }]
        }]
      }],
      _xguard_metadata: {
        lesson_key: lessonKey,
        generated_at: new Date().toISOString(),
        generated_by: localStorage.getItem('rn') || 'Anonyme'
      }
    };
  }

  /**
   * Marque la lecon comme pushed dans Supabase.
   * Appele apres upload manuel reussi dans GHL.
   */
  async function markPushed(lessonKey, target) {
    target = target || 'ghl';
    var rn = (localStorage.getItem('rn') || 'Anonyme').trim();
    var now = new Date().toISOString();

    // Update voice_reviews
    var key = window.SUPA_KEY_OVERRIDE || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN0anNkcGZlZ3BzZnB3amd1c3lpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM2MDU2NDQsImV4cCI6MjA4OTE4MTY0NH0.Uv2pbxbmvcbXhyDa7Y_M0HqkLuV7uJaNxl1N01q5wMo';
    var url = (window.SUPA_URL_OVERRIDE || 'https://ctjsdpfegpsfpwjgusyi.supabase.co')
              + '/rest/v1/voice_reviews?lesson_key=eq.' + encodeURIComponent(lessonKey);

    var r = await fetch(url, {
      method: 'PATCH',
      headers: {
        apikey: key, Authorization: 'Bearer ' + key,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({ lms_pushed_at: now, lms_pushed_by: rn, lms_target: target })
    });
    if (!r.ok) throw new Error('PATCH voice_reviews HTTP ' + r.status);

    // Update video_reviews aussi (si existe)
    var url2 = (window.SUPA_URL_OVERRIDE || 'https://ctjsdpfegpsfpwjgusyi.supabase.co')
              + '/rest/v1/video_reviews?lesson_key=eq.' + encodeURIComponent(lessonKey);
    await fetch(url2, {
      method: 'PATCH',
      headers: {
        apikey: key, Authorization: 'Bearer ' + key,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({ lms_pushed_at: now, lms_pushed_by: rn, lms_target: target })
    });

    return { lesson_key: lessonKey, pushed_at: now, pushed_by: rn, target: target };
  }

  /**
   * Bulk : marquer toutes les lecons d'un cours comme pushed.
   */
  async function markCoursePushed(courseId, target) {
    target = target || 'ghl';
    var rn = (localStorage.getItem('rn') || 'Anonyme').trim();
    var now = new Date().toISOString();
    var key = window.SUPA_KEY_OVERRIDE || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN0anNkcGZlZ3BzZnB3amd1c3lpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM2MDU2NDQsImV4cCI6MjA4OTE4MTY0NH0.Uv2pbxbmvcbXhyDa7Y_M0HqkLuV7uJaNxl1N01q5wMo';

    var url = (window.SUPA_URL_OVERRIDE || 'https://ctjsdpfegpsfpwjgusyi.supabase.co')
              + '/rest/v1/voice_reviews?course_id=eq.' + encodeURIComponent(courseId)
              + '&approved=eq.true&lms_pushed_at=is.null';

    var r = await fetch(url, {
      method: 'PATCH',
      headers: {
        apikey: key, Authorization: 'Bearer ' + key,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
      },
      body: JSON.stringify({ lms_pushed_at: now, lms_pushed_by: rn, lms_target: target })
    });
    if (!r.ok) throw new Error('PATCH course HTTP ' + r.status);
    var updated = await r.json();
    return { count: updated.length, pushed_at: now, pushed_by: rn };
  }

  /**
   * Telecharge le payload comme fichier .json.
   */
  function downloadAsFile(payload, filename) {
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename || 'ghl-import.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  /**
   * Format module title : "Module 5 - Escorte et surveillance"
   */
  function formatModuleTitle(mod) {
    if (!mod.lessons.length) return 'Module ' + (mod.module_index || '?');
    var firstLesson = mod.lessons[0];
    // Si on a un short_title type "M5 / X.X — Title" on l'utilise pour deviner
    if (firstLesson.short_title && firstLesson.short_title.indexOf(' / ') !== -1) {
      var parts = firstLesson.short_title.split(' / ');
      // "M5 / 1.1 — Title" → on cherche un titre stable au niveau module
      // Fallback : juste "Module N"
      return 'Module ' + mod.module_index;
    }
    return 'Module ' + mod.module_index;
  }

  // Expose API publique
  window.GhlPayload = {
    buildForCourse: buildForCourse,
    buildForLesson: buildForLesson,
    markPushed: markPushed,
    markCoursePushed: markCoursePushed,
    downloadAsFile: downloadAsFile
  };
})();
