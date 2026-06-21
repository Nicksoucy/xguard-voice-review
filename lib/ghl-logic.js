/**
 * lib/ghl-logic.js — Logique PURE de construction du payload Import Courses GoHighLevel.
 *
 * Extrait de lms/ghl-payload.js. Aucune dependance fetch/DOM/localStorage : les lecons, l'URL
 * Supabase et les metadonnees (date, auteur) sont passees en parametres. Le payload produit ici
 * est CE QUI EST UPLOADÉ EN PROD dans GHL — d'ou l'importance des tests.
 * Export double navigateur (window.XGGhl) / Node (require).
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.XGGhl = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  var GHL_LOCATION_ID = 'dfkLurZY2ADWAUZl4zYc';

  // URL publique Supabase Storage pour un chemin video (absolu ou relatif "videos/...").
  function videoStorageUrl(supaUrl, videoPath) {
    if (!videoPath) return '';
    if (videoPath.indexOf('http') === 0) return videoPath;
    var clean = videoPath.replace(/^videos\//, '');
    return supaUrl + '/storage/v1/object/public/videos/' + clean;
  }

  // INVARIANT CRITIQUE : seules les lecons voice-approved partent dans GHL.
  function filterApprovedLessons(lessons) {
    return (lessons || []).filter(function (l) {
      return l.status === 'approved';
    });
  }

  // Regroupe les lecons par module, triees par module_index.
  function groupByModule(lessons) {
    var byModule = {};
    lessons.forEach(function (l) {
      var key = l.module_id;
      if (!byModule[key])
        byModule[key] = { module_id: key, module_index: l.module_index, lessons: [] };
      byModule[key].lessons.push(l);
    });
    return Object.keys(byModule)
      .map(function (k) {
        return byModule[k];
      })
      .sort(function (a, b) {
        return a.module_index - b.module_index;
      });
  }

  // Titre de module (fallback "Module N").
  function formatModuleTitle(mod) {
    if (!mod.lessons.length) return 'Module ' + (mod.module_index || '?');
    return 'Module ' + mod.module_index;
  }

  // Construit les categories GHL (= modules) avec leurs posts (= lecons).
  function buildCategories(modules, supaUrl) {
    return modules.map(function (mod, modIdx) {
      var posts = mod.lessons.map(function (l, lessonIdx) {
        return {
          title: l.title || l.short_title || l.lesson_key,
          contentType: 'video',
          videoUrl: videoStorageUrl(supaUrl, l.video_path),
          posterImageUrl: '',
          description: l.short_title || '',
          bucketLocation: '',
          sequenceNo: lessonIdx + 1,
          _xguard_lesson_key: l.lesson_key,
          _xguard_lesson_index: l.lesson_index,
          _xguard_duration_seconds: l.duration_seconds,
          _xguard_voice_approved_at: l.latest_review_at,
        };
      });
      return {
        title: formatModuleTitle(mod),
        sequenceNo: modIdx + 1,
        visibility: 'published',
        posts: posts,
      };
    });
  }

  // Assemble le payload complet d'un cours. `lessons` = lecons brutes (le filtre approved est applique ici).
  // opts = { generated_at, generated_by } pour la metadata (injectes, donc fonction pure/testable).
  function buildCoursePayload(course, lessons, supaUrl, opts) {
    opts = opts || {};
    var ready = filterApprovedLessons(lessons);
    if (!ready.length) throw new Error('Aucune lecon approved pour ce cours');
    var modules = groupByModule(ready);
    return {
      locationId: GHL_LOCATION_ID,
      products: [
        {
          title: course.title,
          description: course.subtitle || '',
          imageUrl: '',
          categories: buildCategories(modules, supaUrl),
        },
      ],
      _xguard_metadata: {
        course_id: course.id,
        generated_at: opts.generated_at || null,
        generated_by: opts.generated_by || 'Anonyme',
        total_lessons: ready.length,
        total_modules: modules.length,
        lessons_with_video: ready.filter(function (l) {
          return !!l.video_path;
        }).length,
      },
    };
  }

  // Validation defensive du payload avant export (filet de securite). Retourne {ok, errors}.
  function validateGhlPayload(payload) {
    var errors = [];
    if (!payload || typeof payload !== 'object') return { ok: false, errors: ['payload manquant'] };
    if (!payload.locationId) errors.push('locationId manquant');
    var products = payload.products || [];
    if (!products.length) errors.push('aucun product');
    products.forEach(function (p, pi) {
      if (!p.title) errors.push('product[' + pi + '] sans title');
      var cats = p.categories || [];
      if (!cats.length) errors.push('product[' + pi + '] sans categorie');
      cats.forEach(function (cat, ci) {
        if (!cat.title) errors.push('cat[' + pi + '][' + ci + '] sans title');
        var posts = cat.posts || [];
        if (!posts.length) errors.push('cat[' + pi + '][' + ci + '] sans post');
        posts.forEach(function (post, si) {
          if (!post.title) errors.push('post[' + pi + '][' + ci + '][' + si + '] sans title');
          if (post.videoUrl == null)
            errors.push('post[' + pi + '][' + ci + '][' + si + '] videoUrl undefined');
          if (post.sequenceNo == null)
            errors.push('post[' + pi + '][' + ci + '][' + si + '] sequenceNo manquant');
        });
      });
    });
    return { ok: errors.length === 0, errors: errors };
  }

  return {
    GHL_LOCATION_ID: GHL_LOCATION_ID,
    videoStorageUrl: videoStorageUrl,
    filterApprovedLessons: filterApprovedLessons,
    groupByModule: groupByModule,
    formatModuleTitle: formatModuleTitle,
    buildCategories: buildCategories,
    buildCoursePayload: buildCoursePayload,
    validateGhlPayload: validateGhlPayload,
  };
});
