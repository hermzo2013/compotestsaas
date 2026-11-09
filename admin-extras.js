/* Révisio — administration : statistiques du tableau de bord, recherche et filtres dans la liste des comptes. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };

  async function api(path) {
    var s = await supabaseClient.auth.getSession();
    var token = s && s.data && s.data.session && s.data.session.access_token;
    if (!token) throw new Error('Session expirée. Reconnecte-toi.');
    var res = await fetch((typeof API_BASE !== 'undefined' ? API_BASE : '') + path, { headers: { 'Authorization': 'Bearer ' + token } });
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(data.error || ('Erreur ' + res.status));
    return data;
  }

  var FIELDS = {
    statUsers: function (d) { return d.users.total; },
    statBanned: function (d) { return d.users.banned; },
    statQuizTotal: function (d) { return d.quizzes.total; },
    statQuizWeek: function (d) { return d.quizzes.thisWeek; },
    statNotifSent: function (d) { return d.notifications.messages; },
    statNotifWeek: function (d) { return d.notifications.last7days; },
    statNotifDelivered: function (d) { return d.notifications.delivered; },
    statNotifClicks: function (d) { return d.notifications.clicks; },
    statSubscribers: function (d) { return d.notifications.subscribers; }
  };

  async function loadStats() {
    var err = $('statError'); if (err) err.textContent = '';
    Object.keys(FIELDS).forEach(function (id) { if ($(id)) $(id).textContent = '…'; });
    try {
      var d = await api('/api/admin/stats');
      Object.keys(FIELDS).forEach(function (id) { if ($(id)) $(id).textContent = String(FIELDS[id](d)); });
      if ($('statUpdated')) $('statUpdated').textContent = 'Mis à jour à ' + new Date(d.generatedAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    } catch (e) {
      Object.keys(FIELDS).forEach(function (id) { if ($(id)) $(id).textContent = '—'; });
      if (err) err.textContent = '❌ ' + e.message;
    }
  }

  // Recherche par nom / e-mail et filtre « bannis seulement » sur le tableau déjà affiché
  function applyUserFilter() {
    var q = ($('adminUserSearch') && $('adminUserSearch').value || '').trim().toLowerCase();
    var onlyBanned = !!($('adminUserBannedOnly') && $('adminUserBannedOnly').checked);
    var rows = document.querySelectorAll('#adminUsersList tbody tr'), shown = 0;
    rows.forEach(function (tr) {
      var ok = (!q || (tr.getAttribute('data-search') || '').indexOf(q) !== -1) && (!onlyBanned || tr.getAttribute('data-banned') === '1');
      tr.style.display = ok ? '' : 'none';
      if (ok) shown++;
    });
    if ($('adminUserCount')) $('adminUserCount').textContent = rows.length ? (shown + ' / ' + rows.length + ' compte(s)') : '';
  }

  function bind() {
    if ($('adminUserSearch')) $('adminUserSearch').addEventListener('input', applyUserFilter);
    if ($('adminUserBannedOnly')) $('adminUserBannedOnly').addEventListener('change', applyUserFilter);
    if ($('statRefreshBtn')) $('statRefreshBtn').addEventListener('click', loadStats);
  }
  bind();

  window.AdminExtras = { loadStats: loadStats, applyUserFilter: applyUserFilter };
})();
