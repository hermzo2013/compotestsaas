import { z } from 'zod';

export const ExplanationSchema = z.object({
  is_correct: z.boolean(),
  correct_answer: z.string(),
  explanation: z.string().min(1),
  pedagogical_hint: z.string().optional(),
  similar_exercise: z.string().optional()
}).passthrough();