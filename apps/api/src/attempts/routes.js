import { Router } from "express";
import mongoose from "mongoose";
import { requireAuth, requireCsrf, requireRole } from "../auth/middleware.js";
import { finalizeAttempt } from "./finalize.js";
import { Attempt } from "../models/Attempt.js";
import { Question } from "../models/Question.js";
import { Quiz } from "../models/Quiz.js";

function notFound(response) {
  return response.status(404).json({
    error: { code: "ATTEMPT_NOT_FOUND", message: "Attempt not found." },
  });
}

function studentQuestion(question) {
  return {
    id: question._id.toString(),
    text: question.text,
    options: question.options.map((option) => ({ id: option.id, text: option.text })),
    marks: question.marks,
    order: question.order,
  };
}

function attemptResponse(attempt, quiz, questions, serverTime) {
  const answers = new Map(
    attempt.answers.map((answer) => [answer.questionId.toString(), answer.optionId]),
  );
  return {
    attempt: {
      id: attempt._id.toString(),
      quizId: quiz._id.toString(),
      status: attempt.status,
      startedAt: attempt.startedAt,
      expiresAt: attempt.expiresAt,
      submittedAt: attempt.submittedAt,
      submissionReason: attempt.submissionReason,
    },
    serverTime: serverTime.toISOString(),
    quiz: {
      id: quiz._id.toString(),
      title: quiz.title,
      instructions: quiz.instructions,
      durationMinutes: quiz.durationMinutes,
      status: quiz.status,
    },
    questions: questions.map((question) => ({
      ...studentQuestion(question),
      selectedOptionId: answers.get(question._id.toString()) ?? null,
    })),
  };
}

async function findOwnedAttempt(attemptId, studentId) {
  if (!mongoose.isValidObjectId(attemptId)) return null;
  return Attempt.findOne({ _id: attemptId, studentId });
}

async function publishSubmissionEvent(publisher, attempt, studentId) {
  if (!publisher?.publishStudentEvent) return { status: "not_configured" };
  try {
    return await publisher.publishStudentEvent({
      type: "ATTEMPT_SUBMITTED",
      quizId: attempt.quizId.toString(),
      studentId,
      attemptId: attempt._id.toString(),
      occurredAt: attempt.submittedAt?.toISOString() ?? new Date().toISOString(),
    });
  } catch (error) {
    console.error(`Attempt submission event for ${attempt._id} was not delivered:`, error);
    return { status: "failed" };
  }
}

export function createAttemptRouter({ eventPublisher } = {}) {
  const router = Router();
  router.use(requireAuth, requireRole("STUDENT"));

  router.get("/:attemptId", async (request, response, next) => {
    try {
      let attempt = await findOwnedAttempt(request.params.attemptId, request.user.id);
      if (!attempt) return notFound(response);

      const now = new Date();
      const currentQuiz = await Quiz.findById(attempt.quizId).select("status");
      if (attempt.status === "IN_PROGRESS" && currentQuiz?.status === "COMPLETED") {
        const finalized = await finalizeAttempt(attempt._id, { reason: "QUIZ_ENDED", now });
        attempt = finalized.attempt;
      } else if (attempt.status === "IN_PROGRESS" && attempt.expiresAt <= now) {
        const finalized = await finalizeAttempt(attempt._id, { reason: "TIME_EXPIRED", now });
        attempt = finalized.attempt;
      }

      const [quiz, questions] = await Promise.all([
        Quiz.findById(attempt.quizId),
        Question.find({ quizId: attempt.quizId }).sort({ order: 1 }).lean(),
      ]);
      if (!quiz) return notFound(response);

      response.set("Cache-Control", "no-store");
      response.json(attemptResponse(attempt, quiz, questions, new Date()));
    } catch (error) {
      next(error);
    }
  });

  router.put("/:attemptId/answers/:questionId", requireCsrf, async (request, response, next) => {
    const { attemptId, questionId } = request.params;
    const optionId = request.body?.optionId;
    if (!mongoose.isValidObjectId(attemptId) || !mongoose.isValidObjectId(questionId)) {
      return notFound(response);
    }
    if (typeof optionId !== "string" || optionId.length < 1 || optionId.length > 64) {
      return response.status(422).json({
        error: { code: "INVALID_ANSWER", message: "Choose a valid answer option." },
      });
    }

    try {
      const now = new Date();
      let attempt = await Attempt.findOne({
        _id: attemptId,
        studentId: request.user.id,
      });
      if (!attempt) return notFound(response);
      if (attempt.status !== "IN_PROGRESS") {
        return response.status(409).json({
          error: { code: "ATTEMPT_COMPLETED", message: "This exam is already submitted." },
        });
      }
      if (attempt.expiresAt <= now) {
        await finalizeAttempt(attempt._id, { reason: "TIME_EXPIRED", now });
        return response.status(409).json({
          error: { code: "ATTEMPT_EXPIRED", message: "Time is up. Your exam has been submitted." },
        });
      }

      const [quiz, question] = await Promise.all([
        Quiz.findById(attempt.quizId).select("status"),
        Question.findOne({ _id: questionId, quizId: attempt.quizId }).select("options.id"),
      ]);
      if (!quiz || quiz.status !== "ACTIVE") {
        const finalized = await finalizeAttempt(attempt._id, { reason: "QUIZ_ENDED", now });
        return response.status(409).json({
          error: {
            code: "QUIZ_ENDED",
            message: "The quiz has ended.",
            attemptId: finalized.attempt?._id.toString(),
          },
        });
      }
      if (!question || !question.options.some((option) => option.id === optionId)) {
        return response.status(422).json({
          error: { code: "INVALID_ANSWER", message: "Choose a valid answer option." },
        });
      }

      const updated = await Attempt.updateOne(
        {
          _id: attempt._id,
          studentId: request.user.id,
          status: "IN_PROGRESS",
          expiresAt: { $gt: now },
          $expr: { $gt: ["$expiresAt", "$$NOW"] },
          $or: [
            { "finalizeLock.expiresAt": { $exists: false } },
            { "finalizeLock.expiresAt": { $lt: now } },
          ],
        },
        [
          {
            $set: {
              answers: {
                $concatArrays: [
                  {
                    $filter: {
                      input: { $ifNull: ["$answers", []] },
                      as: "answer",
                      cond: { $ne: ["$$answer.questionId", new mongoose.Types.ObjectId(questionId)] },
                    },
                  },
                  [{ questionId: new mongoose.Types.ObjectId(questionId), optionId, savedAt: now }],
                ],
              },
            },
          },
        ],
      );
      if (updated.modifiedCount !== 1) {
        attempt = await Attempt.findById(attempt._id);
        if (attempt?.status === "IN_PROGRESS" && attempt.expiresAt <= new Date()) {
          await finalizeAttempt(attempt._id, { reason: "TIME_EXPIRED" });
        }
        return response.status(409).json({
          error: {
            code: attempt?.status === "IN_PROGRESS" ? "ATTEMPT_EXPIRED" : "ATTEMPT_COMPLETED",
            message: "This answer could not be saved because the exam has ended.",
          },
        });
      }
      const currentQuiz = await Quiz.findById(attempt.quizId).select("status endedAt");
      if (currentQuiz?.status === "COMPLETED") {
        await Attempt.updateOne(
          { _id: attempt._id, status: "IN_PROGRESS" },
          { $pull: { answers: { questionId, savedAt: { $gt: currentQuiz.endedAt } } } },
        );
        return response.status(409).json({
          error: { code: "QUIZ_ENDED", message: "The quiz has ended." },
        });
      }
      response.json({ saved: true, questionId, optionId, savedAt: now.toISOString() });
    } catch (error) {
      next(error);
    }
  });

  router.post("/:attemptId/submit", requireCsrf, async (request, response, next) => {
    try {
      const attempt = await findOwnedAttempt(request.params.attemptId, request.user.id);
      if (!attempt) return notFound(response);
      if (attempt.status !== "IN_PROGRESS") {
        return response.json({ attempt: { id: attempt._id.toString(), status: attempt.status }, alreadySubmitted: true });
      }

      const now = new Date();
      const quiz = await Quiz.findById(attempt.quizId).select("status");
      const reason =
        quiz?.status === "COMPLETED"
          ? "QUIZ_ENDED"
          : attempt.expiresAt <= now
            ? "TIME_EXPIRED"
            : "MANUAL";
      const finalized = await finalizeAttempt(attempt._id, { reason, now });
      if (!finalized.attempt) return notFound(response);
      const eventDelivery = finalized.finalized
        ? await publishSubmissionEvent(eventPublisher, finalized.attempt, request.user.id)
        : { status: "already_finalized" };
      response.json({
        attempt: {
          id: finalized.attempt._id.toString(),
          status: finalized.attempt.status,
          submittedAt: finalized.attempt.submittedAt,
        },
        alreadySubmitted: !finalized.finalized,
        eventDelivery,
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
