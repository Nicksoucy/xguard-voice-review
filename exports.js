/**
 * exports.js — Page d'exports CSV/JSON des donnees XGuard Voice Review.
 *
 * Filtres : cours + status (lesson_status filter).
 * Formats : CSV (Excel/Sheets) ou JSON (full data).
 */

var SUPA_URL = window.SUPA_URL_OVERRIDE || 'https://ctjsdpfegpsfpwjgusyi.supabase.co';
var SUPA_KEY = window.SUPA_KEY_OVERRIDE || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN0anNkcGZlZ3BzZnB3amd1c3lpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM2MDU2NDQsImV4cCI6MjA4OTE4MTY0NH0.Uv2pbxbmvcbXhyDa7Y_M0HqkLuV7uJaNxl1N01q5wMo';
var API = SUPA_URL + '/rest/v1';
var H = { apikey: SUPA_KEY, Authorization: 'Bearer ' + SUPA_KEY };

// ============= Init : load courses for dropdown =============
fetch(API + '/courses?visible=eq.true&order=sort_order.asc&select=id,title,short_title', { headers: H })
  .then(function(r) { return r.json(); })
  .then(function(courses) {
    var sel = document.getElementById('course-filter');
    courses.forEach(function(c) {
      var opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.short_title || c.title;
      sel.appendChild(opt);
    });
    updateCounts();
  })
  .catch(function(err) {
    console.error('Load courses error', err);
    if (window.captureWithContext) captureWithContext(err, { action: 'load_courses_for_export' });
  });

function updateCounts() {
  var courseId = document.getElementById('course-filter').value;
  var status = document.getElementById('status-filter').value;
  var filters = [];
  if (courseId) filters.push('course_id=eq.' + encodeURIComponent(courseId));
  if (status) filters.push('status=eq.' + encodeURIComponent(status));
  var qs = filters.length ? '&' + filters.join('&') : '';

  fetch(API + '/lesson_status?select=lesson_key' + qs, { headers: H })
    .then(function(r) { return r.json(); })
    .then(function(rows) {
      document.getElementById('counts').textContent =
        rows.length + ' lecons matchent les filtres';
    });
}

// ============= CSV utilities =============
function csvEscape(val) {
  if (val === null || val === undefined) return '';
  var s = String(val);
  // RFC 4180 : escape if contains comma, quote, newline
  if (/[",\n\r]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function rowsToCSV(rows, columns) {
  if (!rows || !rows.length) return columns.join(',') + '\n';
  var lines = [columns.join(',')];
  rows.forEach(function(r) {
    lines.push(columns.map(function(c) { return csvEscape(r[c]); }).join(','));
  });
  return lines.join('\n');
}

function downloadFile(content, filename, mime) {
  // BOM pour Excel UTF-8 si CSV
  var bom = mime === 'text/csv' ? '﻿' : '';
  var blob = new Blob([bom + content], { type: mime + ';charset=utf-8' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showMsg('✓ ' + filename + ' telecharge', 'success');
}

function showMsg(text, type) {
  var el = document.getElementById('export-msg');
  el.textContent = text;
  el.className = type;
  setTimeout(function() { el.className = ''; }, 4000);
}

function getFilters() {
  var courseId = document.getElementById('course-filter').value;
  var status = document.getElementById('status-filter').value;
  return { courseId: courseId, status: status };
}

function getDateStamp() {
  return new Date().toISOString().split('T')[0];
}

function getFilenamePrefix() {
  var f = getFilters();
  var parts = [];
  if (f.courseId) parts.push(f.courseId);
  if (f.status) parts.push(f.status);
  return parts.length ? parts.join('-') + '-' : '';
}

// ============= Exports =============

// 1. Reviews
async function exportReviews(format) {
  showMsg('Chargement des reviews...', 'success');
  try {
    var f = getFilters();
    var url = API + '/voice_reviews?select=*&order=updated_at.desc';
    if (f.courseId) url += '&course_id=eq.' + encodeURIComponent(f.courseId);
    var rows = await fetch(url, { headers: H }).then(function(r) { return r.json(); });

    // Filter by status si demande (status n'est pas dans voice_reviews, on le derive)
    if (f.status) {
      rows = rows.filter(function(r) {
        if (f.status === 'approved') return r.approved === true;
        if (f.status === 'flagged') return !r.approved && r.flags && r.flags.length > 0;
        return true;
      });
    }

    // Aplatir flags/glitches en JSON string pour CSV
    var flat = rows.map(function(r) {
      return {
        id: r.id,
        lesson_key: r.lesson_key,
        course_id: r.course_id,
        reviewer_name: r.reviewer_name,
        approved: r.approved ? 'oui' : 'non',
        flag_count: (r.flags || []).length,
        glitch_count: (r.glitches || []).length,
        flags_json: JSON.stringify(r.flags || []),
        glitches_json: JSON.stringify(r.glitches || []),
        created_at: r.created_at,
        updated_at: r.updated_at,
        lms_pushed_at: r.lms_pushed_at || '',
        lms_target: r.lms_target || ''
      };
    });

    var filename = getFilenamePrefix() + 'reviews-' + getDateStamp();
    if (format === 'csv') {
      var cols = ['id', 'lesson_key', 'course_id', 'reviewer_name', 'approved',
                  'flag_count', 'glitch_count', 'created_at', 'updated_at',
                  'lms_pushed_at', 'lms_target'];
      downloadFile(rowsToCSV(flat, cols), filename + '.csv', 'text/csv');
    } else {
      downloadFile(JSON.stringify({ exported_at: new Date().toISOString(), filters: f, rows: rows }, null, 2),
                   filename + '.json', 'application/json');
    }
  } catch (e) {
    showMsg('Erreur : ' + e.message, 'error');
    if (window.captureWithContext) captureWithContext(e, { action: 'export_reviews', format: format });
  }
}
function exportReviewsCSV() { exportReviews('csv'); }
function exportReviewsJSON() { exportReviews('json'); }

// 2. Lessons status
async function exportLessons(format) {
  showMsg('Chargement des lecons...', 'success');
  try {
    var f = getFilters();
    var url = API + '/lesson_status_full?select=*&order=sort_order.asc';
    if (f.courseId) url += '&course_id=eq.' + encodeURIComponent(f.courseId);
    if (f.status) url += '&status=eq.' + encodeURIComponent(f.status);
    var rows = await fetch(url, { headers: H }).then(function(r) { return r.json(); });

    var filename = getFilenamePrefix() + 'lessons-' + getDateStamp();
    if (format === 'csv') {
      var cols = ['lesson_key', 'course_id', 'module_id', 'module_index', 'lesson_index',
                  'title', 'short_title', 'status', 'video_status', 'has_video',
                  'flags_count', 'latest_reviewer', 'latest_review_at',
                  'voiceover_uploaded_at', 'voiceover_version'];
      downloadFile(rowsToCSV(rows, cols), filename + '.csv', 'text/csv');
    } else {
      downloadFile(JSON.stringify({ exported_at: new Date().toISOString(), filters: f, rows: rows }, null, 2),
                   filename + '.json', 'application/json');
    }
  } catch (e) {
    showMsg('Erreur : ' + e.message, 'error');
    if (window.captureWithContext) captureWithContext(e, { action: 'export_lessons', format: format });
  }
}
function exportLessonsCSV() { exportLessons('csv'); }
function exportLessonsJSON() { exportLessons('json'); }

// 3. Top flag patterns
async function exportTopFlags(format) {
  showMsg('Chargement top flags...', 'success');
  try {
    var rows = await fetch(API + '/top_flag_patterns?select=*&order=occurrence_count.desc&limit=200', { headers: H })
      .then(function(r) { return r.json(); });

    var filename = 'top-flags-' + getDateStamp();
    if (format === 'csv') {
      // Aplatir sample_lessons array en string
      var flat = rows.map(function(r) {
        return {
          flagged_word: r.flagged_word,
          occurrence_count: r.occurrence_count,
          lessons_affected: r.lessons_affected,
          reviewers_count: r.reviewers_count,
          sample_lessons: (r.sample_lessons || []).join(' | ')
        };
      });
      downloadFile(rowsToCSV(flat, ['flagged_word', 'occurrence_count', 'lessons_affected',
                                    'reviewers_count', 'sample_lessons']),
                   filename + '.csv', 'text/csv');
    } else {
      downloadFile(JSON.stringify({ exported_at: new Date().toISOString(), rows: rows }, null, 2),
                   filename + '.json', 'application/json');
    }
  } catch (e) {
    showMsg('Erreur : ' + e.message, 'error');
    if (window.captureWithContext) captureWithContext(e, { action: 'export_top_flags', format: format });
  }
}
function exportTopFlagsCSV() { exportTopFlags('csv'); }
function exportTopFlagsJSON() { exportTopFlags('json'); }

// 4. Throughput by reviewer
async function exportThroughput(format) {
  showMsg('Chargement throughput...', 'success');
  try {
    var rows = await fetch(API + '/review_throughput_by_reviewer?select=*&order=day.desc', { headers: H })
      .then(function(r) { return r.json(); });

    var filename = 'reviewer-throughput-' + getDateStamp();
    if (format === 'csv') {
      var cols = ['reviewer_name', 'day', 'reviews_completed', 'approved_count',
                  'flagged_count', 'avg_minutes', 'min_minutes', 'max_minutes', 'total_flags'];
      downloadFile(rowsToCSV(rows, cols), filename + '.csv', 'text/csv');
    } else {
      downloadFile(JSON.stringify({ exported_at: new Date().toISOString(), rows: rows }, null, 2),
                   filename + '.json', 'application/json');
    }
  } catch (e) {
    showMsg('Erreur : ' + e.message, 'error');
    if (window.captureWithContext) captureWithContext(e, { action: 'export_throughput', format: format });
  }
}
function exportThroughputCSV() { exportThroughput('csv'); }
function exportThroughputJSON() { exportThroughput('json'); }

// 5. Sentence flags
async function exportSentenceFlags(format) {
  showMsg('Chargement sentence flags...', 'success');
  try {
    var f = getFilters();
    var url = API + '/sentence_flags?select=*&order=created_at.desc';
    if (f.courseId) url += '&lesson_key=like.' + encodeURIComponent(f.courseId + '/%');
    var rows = await fetch(url, { headers: H }).then(function(r) { return r.json(); });

    var filename = getFilenamePrefix() + 'sentence-flags-' + getDateStamp();
    if (format === 'csv') {
      var cols = ['id', 'lesson_key', 'sentence_index', 'flag_type',
                  'original_text', 'corrected_text', 'partial_original', 'partial_replacement',
                  'note', 'reviewer_name', 'applied', 'applied_at', 'created_at'];
      downloadFile(rowsToCSV(rows, cols), filename + '.csv', 'text/csv');
    } else {
      downloadFile(JSON.stringify({ exported_at: new Date().toISOString(), filters: f, rows: rows }, null, 2),
                   filename + '.json', 'application/json');
    }
  } catch (e) {
    showMsg('Erreur : ' + e.message, 'error');
    if (window.captureWithContext) captureWithContext(e, { action: 'export_sentence_flags', format: format });
  }
}
function exportSentenceFlagsCSV() { exportSentenceFlags('csv'); }
function exportSentenceFlagsJSON() { exportSentenceFlags('json'); }

// ============= Tout exporter =============
async function exportAll() {
  showMsg('Snapshot complet en cours... (5 fichiers)', 'success');
  // Sequence : 1s delay entre chaque pour eviter rate-limit + browser block on multiple downloads
  await exportReviews('json');
  await sleep(800);
  await exportLessons('json');
  await sleep(800);
  await exportTopFlags('json');
  await sleep(800);
  await exportThroughput('json');
  await sleep(800);
  await exportSentenceFlags('json');
  showMsg('✓ Snapshot complet telecharge (5 fichiers JSON)', 'success');
}

function sleep(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}
