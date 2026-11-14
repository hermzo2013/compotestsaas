/**
 * RÉVISIO AI ENGINE — Point d'entrée
 *
 * Import unique pour toute l'application :
 *   import { ai } from './services/ai/index.js';
 *   const quiz = await ai.generateQuiz(text);
 */

import { runTask, testProviderConnection } from './ai-router.js';
import { loadAiConfig, invalidateAiConfig, getProvider, getTaskRouting, getSettings, updateProvider, updateTaskRouting, updateSettings } from './ai-config.js';
import { encryptApiKey, decryptApiKey, maskApiKey, validateApiKeyFormat, generateMasterKey } from './ai-security.js';
import { getQuotaState, resetQuota, suspendProvider } from './ai-quota.js';
import { purgeCacheByTask, purgeAllCache } from './ai-cache.js';
import { generateQuiz } from './tasks/quiz-generation.js';
import { analyzeDocument } from './tasks/document-analysis.js';
import { pedagogicalAssistant } from './tasks/pedagogical-assistant.js';
import { explainAnswer } from './tasks/answer-explanation.js';
import { summarizeCourse } from './tasks/course-summary.js';
import { analyzeStudentProgress } from './tasks/student-analysis.js';

export const ai = {
  // Tâches publiques (avec routage auto + fallback + cache + quota)
  generateQuiz: (text, opts = {}) => runTask({
    taskName: 'quiz_generation',
    cachePayload: { text: String(text).slice(0, 5000), count: opts.count || 50 },
    execute: (provider, o) => generateQuiz(provider, text, { ...o, count: opts.count }),
    options: { count: opts.count },
    userId: opts.userId
  }),

  analyzeDocument: (content, opts = {}) => runTask({
    taskName: opts.isImage ? 'image_analysis' : 'document_analysis',
    cachePayload: { content: String(content).slice(0, 5000), isImage: !!opts.isImage },
    execute: (provider, o) => analyzeDocument(provider, content, { ...o, isImage: opts.isImage, imageDataUrl: opts.imageDataUrl }),
    requirements: { vision: !!opts.isImage },
    options: { isImage: opts.isImage, imageDataUrl: opts.imageDataUrl },
    userId: opts.userId
  }),

  pedagogicalAssistant: (question, context, opts = {}) => runTask({
    taskName: 'pedagogical_assistant',
    cachePayload: { question: String(question).slice(0, 2000), ctx: String(context?.course || '').slice(0, 2000) },
    execute: (provider, o) => pedagogicalAssistant(provider, question, context, o),
    options: {},
    userId: opts.userId
  }),

  explainAnswer: (payload, opts = {}) => runTask({
    taskName: 'answer_explanation',
    cachePayload: payload,
    execute: (provider, o) => explainAnswer(provider, payload, o),
    options: {},
    userId: opts.userId
  }),

  summarizeCourse: (text, opts = {}) => runTask({
    taskName: 'course_summary',
    cachePayload: { text: String(text).slice(0, 5000) },
    execute: (provider, o) => summarizeCourse(provider, text, o),
    options: {},
    userId: opts.userId
  }),

  analyzeStudentProgress: (history, opts = {}) => runTask({
    taskName: 'student_analysis',
    cachePayload: { n: history.length, last: history.slice(-3) },
    execute: (provider, o) => analyzeStudentProgress(provider, history, o),
    options: {},
    userId: opts.userId
  }),

  // Configuration
  loadConfig: loadAiConfig,
  invalidateConfig: invalidateAiConfig,
  getProvider,
  getTaskRouting,
  getSettings,
  updateProvider,
  updateTaskRouting,
  updateSettings,

  // Sécurité
  encryptApiKey,
  decryptApiKey,
  maskApiKey,
  validateApiKeyFormat,
  generateMasterKey,

  // Quotas
  getQuotaState,
  resetQuota,
  suspendProvider,

  // Cache
  purgeCacheByTask,
  purgeAllCache,

  // Test
  testProviderConnection
};