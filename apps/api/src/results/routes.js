import { Router } from "express";
import mongoose from "mongoose";
import { requireAuth, requireRole } from "../auth/middleware.js";
import { Attempt } from "../models/Attempt.js";
import { Question } from "../models/Question.js";
import { Quiz } from "../models/Quiz.js";

export function createResultRouter() {
  const router = Router();
  router.use(requireAuth, requireRole("STUDENT"));

  router.get("/my", async (request, response, next) => {
    try {
      const attempts = await Attempt.find({
        studentId: request.user.id,
        status: { $in: ["SUBMITTED", "AUTO_SUBMITTED"] },
      })
        .sort({ submittedAt: -1 })
        .lean();
      const quizIds = attempts.map((attempt) => attempt.quizId);
      const quizzes = await Quiz.find({ _id: { $in: quizIds }, resultsReleased: true, status: "COMPLETED" })
        .select("title status endedAt")
        .lean();
      const quizById = new Map(quizzes.map((quiz) => [quiz._id.toString(), quiz]));
      response.set("Cache-Control", "no-store");
      response.json({
        results: attempts.flatMap((attempt) => {
          const quiz = quizById.get(attempt.quizId.toString());
          if (!quiz) return [];
          return [{
            attemptId: attempt._id.toString(),
            quizId: quiz._id.toString(),
            quizTitle: quiz.title,
            quizStatus: quiz.status,
            submittedAt: attempt.submittedAt,
            status: attempt.status,
            score: attempt.score,
            totalMarks: attempt.totalMarks,
          }];
        }),
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/my/:attemptId", async (request, response, next) => {
    if (!mongoose.isValidObjectId(request.params.attemptId)) {
      return response.status(404).json({
        error: { code: "RESULT_NOT_FOUND", message: "Result not found." },
      });
    }
    try {
      const attempt = await Attempt.findOne({
        _id: request.params.attemptId,
        studentId: request.user.id,
        status: { $in: ["SUBMITTED", "AUTO_SUBMITTED"] },
      }).lean();
      if (!attempt) {
        return response.status(404).json({
          error: { code: "RESULT_NOT_FOUND", message: "Result not found." },
        });
      }
      const quiz = await Quiz.findOne({
        _id: attempt.quizId,
        resultsReleased: true,
        status: "COMPLETED",
      }).select("title description instructions endedAt");
      if (!quiz) {
        return response.status(403).json({
          error: { code: "RESULT_NOT_RELEASED", message: "This result is not available yet." },
        });
      }

      const questions = await Question.find({ quizId: quiz._id }).sort({ order: 1 }).lean();
      const answers = new Map(
        attempt.answers.map((answer) => [answer.questionId.toString(), answer.optionId]),
      );
      response.set("Cache-Control", "no-store");
      response.json({
        result: {
          attemptId: attempt._id.toString(),
          quizId: quiz._id.toString(),
          quizTitle: quiz.title,
          description: quiz.description,
          submittedAt: attempt.submittedAt,
          status: attempt.status,
          score: attempt.score,
          totalMarks: attempt.totalMarks,
        },
        questions: questions.map((question) => ({
          id: question._id.toString(),
          text: question.text,
          options: question.options.map((option) => ({ id: option.id, text: option.text })),
          correctOptionId: question.correctOptionId,
          selectedOptionId: answers.get(question._id.toString()) ?? null,
          marks: question.marks,
          order: question.order,
        })),
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
