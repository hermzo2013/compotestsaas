import { z } from 'zod';

export const DocumentAnalysisSchema = z.object({
  text: z.string(),
  questions: z.array(z.object({
    number: z.number().int().optional(),
    text: z.string(),
    options: z.array(z.string()).optional(),
    correct: z.union([z.number(), z.array(z.number()), z.string()]).optional(),
    type: z.string().optional(),
    explanation: z.string().optional()
  })).optional(),
  warnings: z.array(z.string()).optional()
}).passthrough();