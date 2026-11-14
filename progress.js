(function () {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function normalizeSubject(s) {
    return String(s || 'Général').trim();
  }

  async function fetchAllHistory() {
    const sb = window.supabaseClient;
    const user = window.currentUser;
    if (!sb || !user) return window.historyData || [];
    try {
      const { data } = await sb.from('comptest_data').select('history').eq('user_id', user.id).maybeSingle();
      return (data && Array.isArray(data.history)) ? data.history : (window.historyData || []);
    } catch (e) {
      return window.historyData || [];
    }
  }

  function buildStats(history) {
    const bySubject = new Map();
    history.forEach(h => {
      const subj = normalizeSubject(h.subject || h.title);
      if (!bySubject.has(subj)) bySubject.set(subj, { subject: subj, count: 0, sum: 0, last: null, scores: [] });
      const s = bySubject.get(subj);
      s.count++;
      s.sum += Number(h.score) || 0;
      s.scores.push({ date: new Date(h.date), score: Number(h.score) || 0 });
      const d = new Date(h.date);
      if (!s.last || d > s.last) s.last = d;
    });
    return Array.from(bySubject.values()).map(s => ({
      subject: s.subject,
      count: s.count,
      average: s.count ? s.sum / s.count : 0,
      last: s.last,
      scores: s.scores.sort((a, b) => a.date - b.date)
    })).sort((a, b) => b.count - a.count);
  }

  function buildWeeklySeries(history) {
    const now = new Date();
    const weeks = [];
    for (let i = 7; i >= 0; i--) {
      const end = new Date(now); end.setDate(end.getDate() - i * 7);
      const start = new Date(end); start.setDate(start.getDate() - 7);
      weeks.push({ start, end, scores: [] });
    }
    history.forEach(h => {
      const d = new Date(h.date);
      for (const w of weeks) {
        if (d >= w.start && d < w.end) { w.scores.push(Number(h.score) || 0); break; }
      }
    });
    return weeks.map(w => ({ average: w.scores.length ? w.scores.reduce((a, b) => a + b, 0) / w.scores.length : null }));
  }

  function renderSvgChart(series) {
    const W = 700, H = 220, P = 30;
    const maxY = 20;
    const stepX = (W - P * 2) / Math.max(1, series.length - 1);
    const yFor = (v) => H - P - (v / maxY) * (H - P * 2);
    const points = series.map((s, i) => ({ x: P + i * stepX, y: s.average != null ? yFor(s.average) : null, v: s.average }));
    let path = '';
    let started = false;
    points.forEach(p => {
      if (p.y == null) return;
      path += (started ? ' L ' : 'M ') + p.x.toFixed(1) + ' ' + p.y.toFixed(1);
      started = true;
    });
    const gridLines = [0, 5, 10, 15, 20].map(v => {
      const y = yFor(v);
      return '<line x1="' + P + '" y1="' + y + '" x2="' + (W - P) + '" y2="' + y + '" stroke="#E5E7EB" stroke-width="1" stroke-dasharray="3 3"/>' +
        '<text x="' + (P - 6) + '" y="' + (y + 4) + '" font-size="10" fill="#6B7280" text-anchor="end">' + v + '</text>';
    }).join('');
    const dots = points.map(p => p.y != null ? '<circle cx="' + p.x + '" cy="' + p.y + '" r="4" fill="#10B981"/>' : '').join('');
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" class="progress-chart" role="img" aria-label="Évolution des moyennes sur 8 semaines">' +
      gridLines +
      '<path d="' + path + '" fill="none" stroke="#10B981" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>' +
      dots +
      '</svg>';
  }

  function renderSubjectCards(stats, history) {
    if (!stats.length) {
      return '<p style="color:var(--muted);text-align:center;padding:20px;">Aucune matière pour le moment. Fais un premier quiz pour voir ta progression !</p>';
    }
    return '<div class="progress-cards">' + stats.map(s => {
      const avg = s.average.toFixed(1);
      const weak = s.average < 10;
      const badge = weak ? '<span class="progress-badge weak">⚠️ À travailler</span>' : (s.average >= 15 ? '<span class="progress-badge strong">🏆 Excellent</span>' : '<span class="progress-badge ok">👍 Correct</span>');
      const lastDate = s.last ? s.last.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
      return '<div class="progress-card">' +
        '<div class="progress-card-head"><b>' + esc(s.subject) + '</b>' + badge + '</div>' +
        '<div class="progress-card-body">' +
        '<div class="progress-score">' + avg + '<span>/20</span></div>' +
        '<div class="progress-meta"><span>' + s.count + ' quiz</span><span>Dernier : ' + lastDate + '</span></div>' +
        '</div></div>';
    }).join('') + '</div>';
  }

  async function render(container) {
    if (!container) return;
    container.innerHTML = '<p style="color:var(--muted);text-align:center;padding:20px;">Chargement de ta progression...</p>';
    const history = await fetchAllHistory();
    if (!history || !history.length) {
      container.innerHTML = '<div class="panel"><h1>📊 Ma progression</h1><p style="color:var(--muted);text-align:center;padding:30px;">Tu n\'as pas encore terminé de quiz. Commence par la Bibliothèque !</p></div>';
      return;
    }
    const stats = buildStats(history);
    const series = buildWeeklySeries(history);
    container.innerHTML =
      '<div class="panel">' +
      '<h1>📊 Ma progression</h1>' +
      '<p style="color:var(--muted);font-size:14px">Vue d\'ensemble de tes résultats par matière et de ton évolution.</p>' +
      '<h3 style="margin-top:24px">Évolution sur 8 semaines</h3>' +
      '<div class="progress-chart-wrap">' + renderSvgChart(series) + '</div>' +
      '<h3 style="margin-top:24px">Par matière</h3>' +
      renderSubjectCards(stats, history) +
      '</div>';
  }

  window.Progress = { render };
})();