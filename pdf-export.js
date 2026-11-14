(function () {
  'use strict';

  function loadJsPdf() {
    if (window.jspdf && window.jspdf.jsPDF) return Promise.resolve(window.jspdf.jsPDF);
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
      s.onload = () => resolve(window.jspdf.jsPDF);
      s.onerror = () => reject(new Error('Impossible de charger jsPDF'));
      document.head.appendChild(s);
    });
  }

  function sanitizeFilename(s) {
    return String(s || 'quiz').replace(/[^a-z0-9_-]/gi, '_').slice(0, 60);
  }

  async function exportQuiz(quiz, mode) {
    if (!quiz || !Array.isArray(quiz.questions)) { alert('Quiz invalide.'); return; }
    const jsPDF = await loadJsPdf();
    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    const W = 210, margin = 15;
    let y = 20;

    const ensureSpace = (needed) => {
      if (y + needed > 285) { doc.addPage(); y = 20; }
    };

    doc.setFillColor(6, 78, 59);
    doc.rect(0, 0, W, 20, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(16);
    doc.setFont('helvetica', 'bold');
    doc.text('Révisio', margin, 13);
    doc.setFontSize(10);
    doc.setFont('helvetica', 'normal');
    doc.text(mode === 'correction' ? 'Correction' : 'Quiz', W - margin, 13, { align: 'right' });
    doc.setTextColor(0, 0, 0);
    y = 30;

    doc.setFontSize(16);
    doc.setFont('helvetica', 'bold');
    const title = quiz.title || 'Quiz';
    const titleLines = doc.splitTextToSize(title, W - margin * 2);
    titleLines.forEach(l => { doc.text(l, margin, y); y += 7; });
    y += 2;

    doc.setFontSize(10);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(100, 100, 100);
    doc.text('Généré le ' + new Date().toLocaleDateString('fr-FR'), margin, y);
    y += 8;
    doc.setTextColor(0, 0, 0);

    quiz.questions.forEach((q, i) => {
      ensureSpace(30);
      doc.setFontSize(11);
      doc.setFont('helvetica', 'bold');
      const qText = 'Q' + (i + 1) + '. ' + (q.text || '');
      const qLines = doc.splitTextToSize(qText, W - margin * 2);
      qLines.forEach(l => { ensureSpace(6); doc.text(l, margin, y); y += 5; });
      y += 2;

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(10);
      const opts = Array.isArray(q.options) ? q.options : [];
      const correct = Array.isArray(q.correct) ? q.correct : (q.correct !== undefined ? [q.correct] : []);
      opts.forEach((opt, j) => {
        ensureSpace(6);
        const isCorrect = correct.includes(j);
        if (mode === 'correction' && isCorrect) {
          doc.setFillColor(209, 250, 229);
          doc.rect(margin - 2, y - 4, W - margin * 2 + 4, 6, 'F');
          doc.setTextColor(6, 95, 70);
          doc.setFont('helvetica', 'bold');
        } else {
          doc.setTextColor(30, 41, 59);
        }
        const prefix = mode === 'correction' && isCorrect ? '✓ ' : String.fromCharCode(65 + j) + '. ';
        const optLines = doc.splitTextToSize(prefix + opt, W - margin * 2 - 5);
        optLines.forEach((l, k) => {
          ensureSpace(5);
          doc.text(l, margin + 3, y);
          y += 4.5;
        });
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(0, 0, 0);
      });

      if (mode === 'correction' && q.explanation) {
        ensureSpace(10);
        y += 2;
        doc.setFillColor(249, 250, 251);
        const expLines = doc.splitTextToSize('Explication : ' + q.explanation, W - margin * 2 - 8);
        const boxH = expLines.length * 4.5 + 6;
        doc.rect(margin, y - 3, W - margin * 2, boxH, 'F');
        doc.setFontSize(9);
        doc.setTextColor(75, 85, 99);
        expLines.forEach(l => { doc.text(l, margin + 4, y); y += 4.5; });
        doc.setTextColor(0, 0, 0);
        doc.setFontSize(10);
      }

      if (mode === 'vierge') y += 4;
      y += 4;
    });

    const fname = 'Revisio_' + sanitizeFilename(quiz.title) + '_' + (mode === 'correction' ? 'correction' : 'vierge') + '.pdf';
    doc.save(fname);
  }

  window.PdfExport = { exportQuiz };
})();