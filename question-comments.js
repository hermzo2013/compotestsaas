(function () {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  const subs = new Map();

  function containerKey(quizId, qi) { return quizId + ':' + qi; }

  async function loadComments(quizId, qi) {
    const sb = window.supabaseClient;
    if (!sb) return [];
    const { data } = await sb.from('question_comments').select('*').eq('quiz_id', quizId).eq('question_index', qi).order('created_at', { ascending: true });
    return data || [];
  }

  function renderList(container, comments, quizId, qi) {
    const user = window.currentUser;
    const isAdmin = !!window.isAdmin;
    const list = container.querySelector('.comments-list');
    if (!list) return;
    if (!comments.length) {
      list.innerHTML = '<p class="comment-empty">Aucun commentaire. Sois le premier à expliquer !</p>';
      return;
    }
    list.innerHTML = comments.map(c => {
      const canDelete = isAdmin || (user && c.user_id === user.id);
      return '<div class="comment-item">' +
        '<div class="comment-head"><b>' + esc(c.author_name || 'Anonyme') + '</b>' +
        '<span class="comment-date">' + new Date(c.created_at).toLocaleDateString('fr-FR') + '</span>' +
        (canDelete ? '<button type="button" class="comment-del" data-id="' + esc(c.id) + '" aria-label="Supprimer">🗑️</button>' : '') +
        '</div>' +
        '<div class="comment-content">' + esc(c.content) + '</div>' +
        '</div>';
    }).join('');
    list.querySelectorAll('.comment-del').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Supprimer ce commentaire ?')) return;
        const sb = window.supabaseClient;
        if (!sb) return;
        await sb.from('question_comments').delete().eq('id', btn.dataset.id);
        refresh(container, quizId, qi);
      });
    });
  }

  async function refresh(container, quizId, qi) {
    const comments = await loadComments(quizId, qi);
    renderList(container, comments, quizId, qi);
  }

  async function render(container, quizId, qi) {
    if (!container) return;
    if (!container.dataset.built) {
      container.dataset.built = '1';
      container.innerHTML =
        '<div class="comments-title">💬 Commentaires</div>' +
        '<div class="comments-list"><p class="comment-empty">Chargement...</p></div>' +
        '<form class="comment-form">' +
        '<textarea class="comment-input" placeholder="Partage ton explication..." maxlength="1000" rows="2" aria-label="Nouveau commentaire"></textarea>' +
        '<button type="submit" class="comment-submit">Publier</button>' +
        '</form>' +
        '<div class="comment-status" aria-live="polite"></div>';
      const form = container.querySelector('.comment-form');
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const sb = window.supabaseClient;
        const user = window.currentUser;
        const status = container.querySelector('.comment-status');
        if (!sb || !user) { status.textContent = 'Connecte-toi pour commenter.'; return; }
        const textarea = container.querySelector('.comment-input');
        const content = textarea.value.trim();
        if (!content) { status.textContent = 'Écris un commentaire.'; return; }
        if (content.length > 1000) { status.textContent = 'Trop long (1000 caractères max).'; return; }
        const authorName = user.user_metadata?.full_name || (user.email || '').split('@')[0];
        const { error } = await sb.from('question_comments').insert({
          quiz_id: quizId, question_index: qi, user_id: user.id, author_name: authorName, content
        });
        if (error) { status.textContent = 'Erreur : ' + error.message; return; }
        textarea.value = '';
        status.textContent = '✅ Publié !';
        setTimeout(() => status.textContent = '', 2000);
        refresh(container, quizId, qi);
      });
    }
    await refresh(container, quizId, qi);

    const key = containerKey(quizId, qi);
    if (!subs.has(key)) {
      const sb = window.supabaseClient;
      if (sb && sb.channel) {
        try {
          const channel = sb.channel('qc_' + key)
            .on('postgres_changes', { event: '*', schema: 'public', table: 'question_comments', filter: 'quiz_id=eq.' + quizId }, () => refresh(container, quizId, qi))
            .subscribe();
          subs.set(key, channel);
        } catch (e) {}
      }
    }
  }

  window.QuestionComments = { render };
})();