/**
 * analytics.js — Dashboard analytics XGuard Voice Review.
 *
 * Charge les vues SQL (review_analytics, review_throughput_by_reviewer,
 * top_flag_patterns, global_kpis, flag_category_breakdown) et render
 * les KPIs + charts via Chart.js.
 *
 * Phase 2.2 — observabilite des reviews.
 */

var SUPA_URL = window.SUPA_URL_OVERRIDE || 'https://ctjsdpfegpsfpwjgusyi.supabase.co';
var SUPA_KEY = window.SUPA_KEY_OVERRIDE || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN0anNkcGZlZ3BzZnB3amd1c3lpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM2MDU2NDQsImV4cCI6MjA4OTE4MTY0NH0.Uv2pbxbmvcbXhyDa7Y_M0HqkLuV7uJaNxl1N01q5wMo';
var API = SUPA_URL + '/rest/v1';
var H = { apikey: SUPA_KEY, Authorization: 'Bearer ' + SUPA_KEY };

// Couleurs Chart.js — coherent avec theme XGuard
var COLORS = {
  red: '#E74C3C',
  redLight: 'rgba(231,76,60,0.5)',
  green: '#27AE60',
  greenLight: 'rgba(39,174,96,0.5)',
  orange: '#F39C12',
  orangeLight: 'rgba(243,156,18,0.5)',
  blue: '#3B82F6',
  blueLight: 'rgba(59,130,246,0.5)',
  gray: '#94A3B8',
  reviewerPalette: ['#E74C3C', '#27AE60', '#3B82F6', '#F39C12', '#9B59B6', '#1ABC9C', '#E67E22', '#34495E']
};

// Chart.js global config (dark theme)
if (typeof Chart !== 'undefined') {
  Chart.defaults.color = '#94A3B8';
  Chart.defaults.borderColor = 'rgba(255,255,255,0.08)';
  Chart.defaults.font.family = "'Segoe UI', system-ui, sans-serif";
  Chart.defaults.font.size = 11;
}

// ============= Init =============
loadAll();

function loadAll() {
  Promise.all([
    fetchView('global_kpis').catch(handleErr('global_kpis')),
    fetchView('review_throughput_by_reviewer?order=day.desc&limit=200').catch(handleErr('throughput')),
    fetchView('top_flag_patterns?order=occurrence_count.desc&limit=50').catch(handleErr('top_flags')),
    fetchView('flag_category_breakdown').catch(handleErr('categories'))
  ]).then(function(results) {
    var kpis = results[0] && results[0][0];
    var throughput = results[1] || [];
    var topFlags = results[2] || [];
    var categories = results[3] || [];

    renderKPIs(kpis);
    renderThroughputChart(throughput);
    renderReviewersChart(throughput);
    renderReviewersTable(throughput);
    renderCategoriesChart(categories);
    renderTopFlags(topFlags);

    document.getElementById('last-updated').textContent = 'Mis a jour : ' + new Date().toLocaleTimeString('fr-CA');
  }).catch(function(err) {
    console.error('Analytics load error', err);
    if (window.captureWithContext) captureWithContext(err, { action: 'load_analytics' });
    document.body.insertAdjacentHTML('beforeend', '<div class="err">Erreur chargement analytics : ' + err.message + '</div>');
  });
}

function fetchView(viewQuery) {
  var url = API + '/' + viewQuery + (viewQuery.indexOf('?') === -1 ? '?' : '&') + 'select=*';
  return fetch(url, { headers: H }).then(function(r) {
    if (!r.ok) throw new Error('HTTP ' + r.status + ' on ' + viewQuery);
    return r.json();
  });
}

function handleErr(name) {
  return function(err) {
    console.error('Failed to load ' + name, err);
    if (window.captureWithContext) captureWithContext(err, { action: 'load_' + name });
    return null;
  };
}

// ============= KPI Cards =============
function renderKPIs(kpis) {
  if (!kpis) return;

  var pctApproved = kpis.total_lessons > 0 ? Math.round((kpis.lessons_approved / kpis.total_lessons) * 100) : 0;
  var trend = kpis.approved_this_week - kpis.approved_last_week;
  var trendCls = trend > 0 ? 'up' : (trend < 0 ? 'down' : 'flat');
  var trendArrow = trend > 0 ? '▲' : (trend < 0 ? '▼' : '—');
  var medianMin = kpis.median_minutes_to_approve_7d;

  var html = [
    card('green', 'Lecons approuvees', kpis.lessons_approved + ' / ' + kpis.total_lessons,
         pctApproved + '% du total'),
    card('blue', 'Approuvees cette semaine', kpis.approved_this_week,
         '<span class="kpi-trend ' + trendCls + '">' + trendArrow + ' ' + Math.abs(trend) + '</span> vs semaine derniere'),
    card('orange', 'Lecons a revoir',
         (kpis.lessons_needs_recheck + kpis.lessons_flagged),
         kpis.lessons_needs_recheck + ' needs recheck, ' + kpis.lessons_flagged + ' flagged'),
    card('red', 'Total flags ouverts', kpis.total_flags || 0,
         (kpis.active_reviewers_30d || 0) + ' reviewer(s) actif(s) 30j')
  ];

  if (medianMin) {
    var medianHuman = medianMin > 1440
      ? Math.round(medianMin / 60 / 24 * 10) / 10 + ' jours'
      : Math.round(medianMin) + ' min';
    html.push(card('blue', 'Median time-to-approve',
                   medianHuman,
                   '7 derniers jours · created_at → approve'));
  }

  document.getElementById('kpi-grid').innerHTML = html.join('');
}

function card(color, label, value, sub) {
  return '<div class="kpi-card ' + color + '">' +
    '<div class="kpi-label">' + label + '</div>' +
    '<div class="kpi-value">' + value + '</div>' +
    '<div class="kpi-sub">' + sub + '</div>' +
    '</div>';
}

// ============= Charts =============
function renderThroughputChart(throughput) {
  var ctx = document.getElementById('chart-throughput');
  if (!ctx || !throughput.length) return;

  // Group by day, aggregate all reviewers
  var byDay = {};
  throughput.forEach(function(row) {
    if (!byDay[row.day]) byDay[row.day] = { day: row.day, total: 0, approved: 0, flagged: 0 };
    byDay[row.day].total += row.reviews_completed || 0;
    byDay[row.day].approved += row.approved_count || 0;
    byDay[row.day].flagged += row.flagged_count || 0;
  });
  var days = Object.values(byDay).sort(function(a,b){ return a.day < b.day ? -1 : 1; }).slice(-30);

  new Chart(ctx, {
    type: 'bar',
    data: {
      labels: days.map(function(d){ return shortDate(d.day); }),
      datasets: [
        {
          label: 'Approuvees',
          data: days.map(function(d){ return d.approved; }),
          backgroundColor: COLORS.green,
          stack: 'reviews'
        },
        {
          label: 'Flagged',
          data: days.map(function(d){ return d.flagged; }),
          backgroundColor: COLORS.orange,
          stack: 'reviews'
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { stacked: true, grid: { display: false } },
        y: { stacked: true, beginAtZero: true, ticks: { stepSize: 1 } }
      },
      plugins: {
        legend: { position: 'top', align: 'end' },
        tooltip: { mode: 'index', intersect: false }
      }
    }
  });
}

function renderReviewersChart(throughput) {
  var ctx = document.getElementById('chart-reviewers');
  if (!ctx || !throughput.length) return;

  // Aggregate by reviewer (last 30 days)
  var byReviewer = {};
  throughput.forEach(function(row) {
    var name = row.reviewer_name || 'Anonyme';
    if (!byReviewer[name]) byReviewer[name] = { name: name, completed: 0, approved: 0, avg_min_sum: 0, days_count: 0 };
    byReviewer[name].completed += row.reviews_completed || 0;
    byReviewer[name].approved += row.approved_count || 0;
    if (row.avg_minutes) {
      byReviewer[name].avg_min_sum += row.avg_minutes;
      byReviewer[name].days_count += 1;
    }
  });
  var reviewers = Object.values(byReviewer).sort(function(a,b){ return b.completed - a.completed; });

  new Chart(ctx, {
    type: 'bar',
    data: {
      labels: reviewers.map(function(r){ return r.name; }),
      datasets: [
        {
          label: 'Approuvees',
          data: reviewers.map(function(r){ return r.approved; }),
          backgroundColor: COLORS.green
        },
        {
          label: 'Total',
          data: reviewers.map(function(r){ return r.completed; }),
          backgroundColor: COLORS.blueLight,
          borderColor: COLORS.blue,
          borderWidth: 1
        }
      ]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { beginAtZero: true, ticks: { stepSize: 1 } },
        y: { grid: { display: false } }
      },
      plugins: { legend: { position: 'top', align: 'end' } }
    }
  });
}

function renderReviewersTable(throughput) {
  var byReviewer = {};
  throughput.forEach(function(row) {
    var name = row.reviewer_name || 'Anonyme';
    if (!byReviewer[name]) byReviewer[name] = { name: name, completed: 0, approved: 0, total_flags: 0, avg_min_sum: 0, days_count: 0 };
    byReviewer[name].completed += row.reviews_completed || 0;
    byReviewer[name].approved += row.approved_count || 0;
    byReviewer[name].total_flags += row.total_flags || 0;
    if (row.avg_minutes) {
      byReviewer[name].avg_min_sum += parseFloat(row.avg_minutes);
      byReviewer[name].days_count += 1;
    }
  });
  var reviewers = Object.values(byReviewer).sort(function(a,b){ return b.completed - a.completed; });

  var tbody = document.querySelector('#table-reviewers tbody');
  if (!reviewers.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty">Aucune review derniers 30j</td></tr>';
    return;
  }
  tbody.innerHTML = reviewers.map(function(r) {
    var avgMin = r.days_count > 0 ? Math.round(r.avg_min_sum / r.days_count) : '-';
    return '<tr>' +
      '<td>' + escapeHtml(r.name) + '</td>' +
      '<td class="num">' + r.completed + '</td>' +
      '<td class="num" style="color:#2ECC71">' + r.approved + '</td>' +
      '<td class="num">' + avgMin + '</td>' +
      '<td class="num" style="color:#F39C12">' + r.total_flags + '</td>' +
      '</tr>';
  }).join('');
}

function renderCategoriesChart(categories) {
  var ctx = document.getElementById('chart-categories');
  if (!ctx || !categories.length) return;

  new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: categories.map(function(c){ return c.category; }),
      datasets: [{
        data: categories.map(function(c){ return c.count; }),
        backgroundColor: COLORS.reviewerPalette,
        borderColor: '#0A0E1A',
        borderWidth: 2
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'right', labels: { boxWidth: 12, padding: 8 } },
        tooltip: {
          callbacks: {
            label: function(ctx) {
              var c = categories[ctx.dataIndex];
              return ctx.label + ': ' + c.count + ' (' + c.lessons_affected + ' lecons)';
            }
          }
        }
      }
    }
  });
}

function renderTopFlags(topFlags) {
  var tbody = document.querySelector('#table-top-flags tbody');
  if (!topFlags.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty">Aucun flag recurrent (≥2 occurrences)</td></tr>';
    return;
  }
  tbody.innerHTML = topFlags.map(function(f, i) {
    var sample = (f.sample_lessons || []).slice(0, 3).map(function(k){
      return k.split('/').slice(-2).join('/');
    }).join(', ');
    if ((f.sample_lessons || []).length > 3) sample += ' (+' + ((f.sample_lessons || []).length - 3) + ')';
    return '<tr>' +
      '<td style="color:#94A3B8">' + (i + 1) + '</td>' +
      '<td><span class="word">' + escapeHtml(f.flagged_word) + '</span></td>' +
      '<td class="num"><strong>' + f.occurrence_count + '</strong></td>' +
      '<td class="num">' + f.lessons_affected + '</td>' +
      '<td class="num">' + f.reviewers_count + '</td>' +
      '<td class="lessons-list" title="' + escapeHtml((f.sample_lessons || []).join(', ')) + '">' + escapeHtml(sample) + '</td>' +
      '</tr>';
  }).join('');
}

// ============= Utils =============
function shortDate(iso) {
  if (!iso) return '';
  var d = new Date(iso);
  var months = ['jan','fev','mar','avr','mai','jui','jul','aou','sep','oct','nov','dec'];
  return d.getDate() + ' ' + months[d.getMonth()];
}

function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[&<>"']/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
  });
}
