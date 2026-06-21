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

  // videoStorageUrl + formatModuleTitle vivent maintenant dans lib/ghl-logic.js (window.XGGhl).

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

    // Construction du payload deleguee a la logique pure testee (lib/ghl-logic.js).
    // Le filtre "status === 'approved'" + le groupage par module + la validation y vivent.
    return window.XGGhl.buildCoursePayload(course, lessons, SUPA_URL, {
      generated_at: new Date().toISOString(),
      generated_by: localStorage.getItem('rn') || 'Anonyme'
    });
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
    var videoUrl = window.XGGhl.videoStorageUrl(SUPA_URL, l.video_path);

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

  // Expose API publique
  window.GhlPayload = {
    buildForCourse: buildForCourse,
    buildForLesson: buildForLesson,
    markPushed: markPushed,
    markCoursePushed: markCoursePushed,
    downloadAsFile: downloadAsFile
  };
})();
