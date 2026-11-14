(function () {
  'use strict';
  const PREFIX = 'revisio_pending_quiz_';
  const MAX_AGE_MS = 24 * 60 * 60 * 1000;

  function key(quizId) { return PREFIX + quizId; }

  function lsGet(quizId) {
    try {
      const raw = localStorage.getItem(key(quizId));
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (!data || !data.savedAt) return null;
      if (Date.now() - data.savedAt > MAX_AGE_MS) { localStorage.removeItem(key(quizId)); return null; }
      return data;
    } catch (e) { return null; }
  }

  function lsSet(quizId, state) {
    try { localStorage.setItem(key(quizId), JSON.stringify(state)); } catch (e) {}
  }

  function lsClear(quizId) {
    try { localStorage.removeItem(key(quizId)); } catch (e) {}
  }

  function lsList() {
    const out = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || !k.startsWith(PREFIX)) continue;
        const data = JSON.parse(localStorage.getItem(k));
        if (data && data.savedAt && Date.now() - data.savedAt < MAX_AGE_MS) out.push(data);
        else localStorage.removeItem(k);
      }
    } catch (e) {}
    return out.sort((a, b) => b.savedAt - a.savedAt);
  }

  async function cloudSave(state) {
    const sb = window.supabaseClient;
    const user = window.currentUser;
    if (!sb || !user || !state || !state.quizId) return;
    try {
      await sb.from('resume_quiz').upsert({
        user_id: user.id,
        quiz_id: state.quizId,
        state: state,
        updated_at: new Date().toISOString()
      }, { onConflict: 'user_id,quiz_id' });
    } catch (e) {}
  }

  async function cloudLoad(quizId) {
    const sb = window.supabaseClient;
    const user = window.currentUser;
    if (!sb || !user || !quizId) return null;
    try {
      const { data } = await sb.from('resume_quiz').select('state').eq('user_id', user.id).eq('quiz_id', quizId).maybeSingle();
      return data && data.state ? data.state : null;
    } catch (e) { return null; }
  }

  async function cloudClear(quizId) {
    const sb = window.supabaseClient;
    const user = window.currentUser;
    if (!sb || !user || !quizId) return;
    try { await sb.from('resume_quiz').delete().eq('user_id', user.id).eq('quiz_id', quizId); } catch (e) {}
  }

  function save(state) {
    if (!state || !state.quizId) return;
    const enriched = { ...state, savedAt: Date.now() };
    lsSet(state.quizId, enriched);
    cloudSave(enriched);
  }

  function clear(quizId) {
    lsClear(quizId);
    cloudClear(quizId);
  }

  function hasPending() { return lsList().length > 0; }
  function list() { return lsList(); }
  function load(quizId) { return lsGet(quizId); }

  function showBanner() {
    const pending = lsList();
    if (!pending.length) return;
    const first = pending[0];
    let banner = document.getElementById('resumeBanner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'resumeBanner';
      banner.className = 'resume-banner';
      const main = document.getElementById('mainApp');
      if (main) main.insertBefore(banner, main.firstChild);
    }
    const title = first.title || 'Quiz';
    const answered = Array.isArray(first.answers) ? first.answers.filter(a => a !== null && a !== undefined && (!Array.isArray(a) || a.length > 0)).length : 0;
    banner.innerHTML = '<span class="resume-icon">⏸️</span>' +
      '<div class="resume-text"><b>Quiz en cours : ' + title + '</b>' +
      '<span>' + answered + ' réponse(s) sauvegardée(s)</span></div>' +
      '<div class="resume-actions">' +
      '<button type="button" class="resume-resume" data-resume="' + first.quizId + '">Reprendre</button>' +
      '<button type="button" class="resume-dismiss" data-dismiss="' + first.quizId + '">Ignorer</button>' +
      '</div>';
    banner.style.display = 'flex';
    banner.querySelector('.resume-resume').onclick = () => {
      const state = lsGet(first.quizId);
      if (!state) return;
      banner.style.display = 'none';
      if (window.openResumeQuiz) window.openResumeQuiz(state);
    };
    banner.querySelector('.resume-dismiss').onclick = () => {
      lsClear(first.quizId);
      cloudClear(first.quizId);
      banner.style.display = 'none';
      showBanner();
    };
  }

  window.ResumeQuiz = {
    save, load, clear, hasPending, list, showBanner
  };
})();