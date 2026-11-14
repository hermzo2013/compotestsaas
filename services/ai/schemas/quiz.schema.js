import { z } from 'zod';

const QuestionChoice = z.object({
  type: z.enum(['mcq', 'mcq_multi', 'tf', 'QCD', 'QCM_UNIQUE', 'QCM_MULTIPLE']),
  text: z.string().min(1),
  options: z.array(z.string().min(1)).min(2).max(10).optional(),
  correct: z.union([z.number().int().min(0), z.array(z.number().int().min(0))]),
  explanation: z.string().optional().default(''),
  max_select: z.number().int().min(1).max(10).optional(),
  block_id: z.union([z.string(), z.number()]).optional()
}).passthrough();

const QuestionShort = z.object({
  type: z.literal('short'),
  text: z.string().min(1),
  correct: z.string().min(1),
  explanation: z.string().optional().default(''),
  block_id: z.union([z.string(), z.number()]).optional()
}).passthrough();

const Question = z.union([QuestionChoice, QuestionShort]);

const Block = z.object({
  id: z.union([z.string(), z.number()]),
  title: z.string().min(1),
  case_block: z.string().nullable().optional()
}).passthrough();

export const QuizResponseSchema = z.object({
  questions: z.array(Question).min(1),
  blocks: z.array(Block).optional(),
  display_mode: z.enum(['NORMAL', 'QPQ']).optional().default('NORMAL'),
  seconds_per_question: z.number().int().min(10).max(900).optional(),
  time_limit_seconds: z.number().int().min(60).max(28800).optional(),
  scoring: z.object({
    correct: z.number().optional(),
    wrong: z.number().optional(),
    blank: z.number().optional()
  }).optional()
}).passthrough();

export const QuizQuestionSchema = Question;
export const QuizBlockSchema = Block;