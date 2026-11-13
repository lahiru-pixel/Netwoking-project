import { z } from "zod";

const quizFields = {
  title: z.string().trim().min(3).max(120),
  description: z.string().trim().max(1000).default(""),
  instructions: z.string().trim().max(2000).default(""),
  durationMinutes: z.number().int().min(1).max(1440),
};

export const createQuizSchema = z.object(quizFields).strict();
export const updateQuizSchema = z
  .object({
    title: quizFields.title.optional(),
    description: quizFields.description.optional(),
    instructions: quizFields.instructions.optional(),
    durationMinutes: quizFields.durationMinutes.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "Provide at least one quiz field to update.",
  });

const optionSchema = z.object({
  id: z.string().trim().min(1).max(64),
  text: z.string().trim().min(1).max(500),
}).strict();

export const questionSchema = z
  .object({
    text: z.string().trim().min(3).max(2000),
    options: z.array(optionSchema).length(4),
    correctOptionId: z.string().trim().min(1).max(64),
    marks: z.number().min(Number.MIN_VALUE).max(10000),
    order: z.number().int().min(1).max(10000).optional(),
  })
  .strict()
  .superRefine((question, context) => {
    const optionIds = question.options.map((option) => option.id);
    if (new Set(optionIds).size !== optionIds.length) {
      context.addIssue({
        code: "custom",
        path: ["options"],
        message: "Each answer option must have a unique ID.",
      });
    }
    if (!optionIds.includes(question.correctOptionId)) {
      context.addIssue({
        code: "custom",
        path: ["correctOptionId"],
        message: "Choose one of the four answer options as correct.",
      });
    }
  });
