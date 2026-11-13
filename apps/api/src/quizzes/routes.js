import { Router } from "express";
import mongoose from "mongoose";
import { randomUUID } from "node:crypto";
import { requireAuth, requireRole, requireCsrf } from "../auth/middleware.js";
import { finalizeAttempt, finalizeQuizAttempts } from "../attempts/finalize.js";
import { Attempt } from "../models/Attempt.js";
import { Question } from "../models/Question.js";
import { Quiz } from "../models/Quiz.js";
import { User } from "../models/User.js";
import { createQuizSchema, questionSchema, updateQuizSchema } from "./validation.js";

function validationFailure(response, parsed) {
  return response.status(422).json({
    error: {
      code: "VALIDATION_FAILED",
      message: "Check the quiz details and try again.",
      fields: parsed.error.flatten().fieldErrors,
    },
  });
}

function validObjectId(value) {
  return mongoose.isValidObjectId(value);
}

async function loadOwnedQuiz(request, response, next) {
  if (!validObjectId(request.params.quizId)) {
    return response.status(404).json({
      error: { code: "QUIZ_NOT_FOUND", message: "Quiz not found." },
    });
  }

  try {
    const quiz = await Quiz.findById(request.params.quizId);
    if (!quiz || quiz.createdBy.toString() !== request.user.id) {
      return response.status(404).json({
        error: { code: "QUIZ_NOT_FOUND", message: "Quiz not found." },
      });
    }
    request.quiz = quiz;
    next();
  } catch (error) {
    next(error);
  }
}

async function publishLifecycleEvent(publisher, quiz, type, request) {
  try {
    return await publisher.publishLifecycleEvent({
      type,
      quizId: quiz._id.toString(),
      teacherId: request.user.id,
      occurredAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error(`Quiz event ${type} was not delivered:`, error);
    return { status: "failed" };
  }
}

async function publishStudentEvent(publisher, event) {
  if (!publisher?.publishStudentEvent) return { status: "not_configured" };
  try {
    return await publisher.publishStudentEvent({
      ...event,
      occurredAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error(`Student event ${event.type} was not delivered:`, error);
    return { status: "failed" };
  }
}

async function withDraftEditLock(quizId, ownerId, operation) {
  const token = randomUUID();
  const now = new Date();
  const lockedQuiz = await Quiz.findOneAndUpdate(
    {
      _id: quizId,
      createdBy: ownerId,
      status: "DRAFT",
      $or: [
        { "draftEditLock.expiresAt": { $exists: false } },
        { "draftEditLock.expiresAt": { $lt: now } },
      ],
    },
    {
      $set: {
        draftEditLock: {
          token,
          expiresAt: new Date(now.getTime() + 5 * 60 * 1000),
        },
      },
    },
    { new: true },
  );
  if (!lockedQuiz) return { locked: false };

  try {
    return { locked: true, value: await operation() };
  } finally {
    await Quiz.updateOne(
      { _id: quizId, "draftEditLock.token": token },
      { $unset: { draftEditLock: 1 } },
    );
  }
}

export function createQuizRouter({ eventPublisher }) {
  const router = Router();
  router.use(requireAuth);

  router.get("/", async (request, response, next) => {
    try {
      const filter =
        request.user.role === "TEACHER"
          ? { createdBy: request.user.id }
          : request.user.role === "STUDENT"
            ? { status: "ACTIVE" }
            : null;
      if (!filter) {
        return response.status(403).json({
          error: { code: "FORBIDDEN", message: "You do not have access to quizzes." },
        });
      }

      const quizzes = await Quiz.find(filter).sort({ updatedAt: -1 }).lean();
      const counts = await Question.aggregate([
        { $match: { quizId: { $in: quizzes.map((quiz) => quiz._id) } } },
        { $group: { _id: "$quizId", count: { $sum: 1 } } },
      ]);
      const countByQuizId = new Map(counts.map((entry) => [entry._id.toString(), entry.count]));
      const studentView = request.user.role === "STUDENT";
      response.json({
        quizzes: quizzes.map((quiz) =>
          studentView
            ? {
                id: quiz._id.toString(),
                title: quiz.title,
                description: quiz.description,
                instructions: quiz.instructions,
                durationMinutes: quiz.durationMinutes,
                status: quiz.status,
                startedAt: quiz.startedAt,
                questionCount: countByQuizId.get(quiz._id.toString()) ?? 0,
              }
            : {
                ...quiz,
                id: quiz._id.toString(),
                questionCount: countByQuizId.get(quiz._id.toString()) ?? 0,
                createdBy: quiz.createdBy.toString(),
              },
        ),
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/", requireRole("TEACHER"), requireCsrf, async (request, response, next) => {
    const parsed = createQuizSchema.safeParse(request.body);
    if (!parsed.success) return validationFailure(response, parsed);

    try {
      const quiz = await Quiz.create({ ...parsed.data, createdBy: request.user.id });
      response.status(201).json({ quiz: { ...quiz.toObject(), id: quiz._id.toString(), questionCount: 0 } });
    } catch (error) {
      next(error);
    }
  });

  router.get(
    "/:quizId/monitor",
    requireRole("TEACHER"),
    loadOwnedQuiz,
    async (request, response, next) => {
      try {
        const [attempts, total, inProgress, submitted] = await Promise.all([
          Attempt.find({ quizId: request.quiz._id })
            .sort({ updatedAt: -1 })
            .limit(50)
            .lean(),
          Attempt.countDocuments({ quizId: request.quiz._id }),
          Attempt.countDocuments({ quizId: request.quiz._id, status: "IN_PROGRESS" }),
          Attempt.countDocuments({
            quizId: request.quiz._id,
            status: { $in: ["SUBMITTED", "AUTO_SUBMITTED"] },
          }),
        ]);
        const users = await User.find({
          _id: { $in: attempts.map((attempt) => attempt.studentId) },
        }).select("name email").lean();
        const userById = new Map(users.map((user) => [user._id.toString(), user]));
        response.set("Cache-Control", "no-store");
        response.json({
          quiz: {
            id: request.quiz._id.toString(),
            title: request.quiz.title,
            status: request.quiz.status,
            startedAt: request.quiz.startedAt,
            endedAt: request.quiz.endedAt,
          },
          counts: { joined: total, inProgress, submitted },
          participants: attempts.map((attempt) => {
            const student = userById.get(attempt.studentId.toString());
            return {
              attemptId: attempt._id.toString(),
              studentId: attempt.studentId.toString(),
              name: student?.name ?? "Student",
              email: student?.email ?? "",
              status: attempt.status,
              startedAt: attempt.startedAt,
              submittedAt: attempt.submittedAt,
              score: attempt.score,
              totalMarks: attempt.totalMarks,
            };
          }),
        });
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    "/:quizId/results",
    requireRole("TEACHER"),
    loadOwnedQuiz,
    async (request, response, next) => {
      if (request.quiz.status !== "COMPLETED" || !request.quiz.resultsReleased) {
        return response.status(409).json({
          error: {
            code: "RESULTS_NOT_RELEASED",
            message: "Results are available after the quiz is completed and released.",
          },
        });
      }
      try {
        const attempts = await Attempt.find({
          quizId: request.quiz._id,
          status: { $in: ["SUBMITTED", "AUTO_SUBMITTED"] },
        }).sort({ submittedAt: -1 }).lean();
        const users = await User.find({
          _id: { $in: attempts.map((attempt) => attempt.studentId) },
        }).select("name email").lean();
        const userById = new Map(users.map((user) => [user._id.toString(), user]));

        response.set("Cache-Control", "no-store");
        response.json({
          quiz: {
            id: request.quiz._id.toString(),
            title: request.quiz.title,
            status: request.quiz.status,
            endedAt: request.quiz.endedAt,
            resultsReleased: request.quiz.resultsReleased,
          },
          results: attempts.map((attempt) => {
            const student = userById.get(attempt.studentId.toString());
            return {
              attemptId: attempt._id.toString(),
              studentId: attempt.studentId.toString(),
              studentName: student?.name ?? "Student",
              studentEmail: student?.email ?? "",
              status: attempt.status,
              submittedAt: attempt.submittedAt,
              score: attempt.score,
              totalMarks: attempt.totalMarks,
            };
          }),
        });
      } catch (error) {
        next(error);
      }
    },
  );

  router.get("/:quizId", async (request, response, next) => {
    if (!validObjectId(request.params.quizId)) {
      return response.status(404).json({
        error: { code: "QUIZ_NOT_FOUND", message: "Quiz not found." },
      });
    }

    try {
      let quiz;
      if (request.user.role === "TEACHER") {
        quiz = await Quiz.findOne({
          _id: request.params.quizId,
          createdBy: request.user.id,
        });
      } else if (request.user.role === "STUDENT") {
        quiz = await Quiz.findOne({ _id: request.params.quizId, status: "ACTIVE" });
        if (!quiz && (await Quiz.exists({ _id: request.params.quizId }))) {
          return response.status(403).json({
            error: { code: "FORBIDDEN", message: "Only active quizzes are available to students." },
          });
        }
      }
      if (!quiz) {
        return response.status(404).json({
          error: { code: "QUIZ_NOT_FOUND", message: "Quiz not found." },
        });
      }

      const questions = await Question.find({ quizId: quiz._id }).sort({ order: 1 }).lean();
      if (request.user.role === "STUDENT") {
        let attempt = await Attempt.findOne({
          quizId: quiz._id,
          studentId: request.user.id,
        }).select("_id status expiresAt");
        if (attempt?.status === "IN_PROGRESS" && attempt.expiresAt <= new Date()) {
          const finalized = await finalizeAttempt(attempt._id, { reason: "TIME_EXPIRED" });
          attempt = finalized.attempt;
        }
        response.set("Cache-Control", "no-store");
        return response.json({
          quiz: {
            id: quiz._id.toString(),
            title: quiz.title,
            description: quiz.description,
            instructions: quiz.instructions,
            durationMinutes: quiz.durationMinutes,
            status: quiz.status,
            questionCount: questions.length,
          },
          questions: questions.map((question) => ({
            id: question._id.toString(),
            text: question.text,
            options: question.options.map(({ id, text }) => ({ id, text })),
            marks: question.marks,
            order: question.order,
          })),
          attempt: attempt
            ? {
                id: attempt._id.toString(),
                status: attempt.status,
                expiresAt: attempt.expiresAt,
              }
            : null,
        });
      }

      response.json({
        quiz: {
          ...quiz.toObject(),
          id: quiz._id.toString(),
          questionCount: questions.length,
        },
        questions: questions.map((question) => ({ ...question, id: question._id.toString() })),
      });
    } catch (error) {
      next(error);
    }
  });

  router.post(
    "/:quizId/join",
    requireRole("STUDENT"),
    requireCsrf,
    async (request, response, next) => {
      if (!validObjectId(request.params.quizId)) {
        return response.status(404).json({
          error: { code: "QUIZ_NOT_FOUND", message: "Quiz not found." },
        });
      }
      try {
        const quiz = await Quiz.findOne({ _id: request.params.quizId, status: "ACTIVE" });
        if (!quiz) {
          return response.status(404).json({
            error: { code: "QUIZ_NOT_FOUND", message: "Quiz is not available." },
          });
        }

        const existing = await Attempt.findOne({
          quizId: quiz._id,
          studentId: request.user.id,
        });
        if (existing) {
          if (existing.status === "IN_PROGRESS" && existing.expiresAt <= new Date()) {
            const finalized = await finalizeAttempt(existing._id, { reason: "TIME_EXPIRED" });
            return response.status(200).json({
              attempt: {
                id: finalized.attempt._id.toString(),
                status: finalized.attempt.status,
                expiresAt: finalized.attempt.expiresAt,
              },
              alreadyJoined: true,
            });
          }
          return response.status(200).json({
            attempt: {
              id: existing._id.toString(),
              status: existing.status,
              expiresAt: existing.expiresAt,
            },
            alreadyJoined: true,
          });
        }

        const startedAt = new Date();
        let attempt;
        let created = false;
        try {
          attempt = await Attempt.create({
            quizId: quiz._id,
            studentId: request.user.id,
            startedAt,
            expiresAt: new Date(startedAt.getTime() + quiz.durationMinutes * 60_000),
          });
          created = true;
        } catch (error) {
          if (error?.code !== 11000) throw error;
          attempt = await Attempt.findOne({ quizId: quiz._id, studentId: request.user.id });
        }

        const currentQuiz = await Quiz.findById(quiz._id).select("status");
        if (currentQuiz?.status !== "ACTIVE" && attempt.status === "IN_PROGRESS") {
          const finalized = await finalizeAttempt(attempt._id, { reason: "QUIZ_ENDED" });
          attempt = finalized.attempt;
        }
        const eventDelivery = created
          ? await publishStudentEvent(eventPublisher, {
              type: "STUDENT_JOINED",
              quizId: quiz._id.toString(),
              studentId: request.user.id,
              attemptId: attempt._id.toString(),
            })
          : { status: "duplicate_join" };
        response.status(201).json({
          attempt: {
            id: attempt._id.toString(),
            status: attempt.status,
            expiresAt: attempt.expiresAt,
          },
          alreadyJoined: false,
          eventDelivery,
        });
      } catch (error) {
        next(error);
      }
    },
  );

  router.patch(
    "/:quizId",
    requireRole("TEACHER"),
    requireCsrf,
    loadOwnedQuiz,
    async (request, response, next) => {
      if (request.quiz.status !== "DRAFT") {
        return response.status(409).json({
          error: { code: "QUIZ_NOT_EDITABLE", message: "Only draft quizzes can be changed." },
        });
      }
      const parsed = updateQuizSchema.safeParse(request.body);
      if (!parsed.success) return validationFailure(response, parsed);

      try {
        const result = await withDraftEditLock(
          request.quiz._id,
          request.user.id,
          () =>
            Quiz.findOneAndUpdate(
              { _id: request.quiz._id, createdBy: request.user.id, status: "DRAFT" },
              { $set: parsed.data },
              { new: true, runValidators: true },
            ),
        );
        if (!result.locked || !result.value) {
          return response.status(409).json({
            error: { code: "QUIZ_NOT_EDITABLE", message: "Only draft quizzes can be changed." },
          });
        }
        const quiz = result.value;
        response.json({ quiz: { ...quiz.toObject(), id: quiz._id.toString() } });
      } catch (error) {
        next(error);
      }
    },
  );

  router.delete(
    "/:quizId",
    requireRole("TEACHER"),
    requireCsrf,
    loadOwnedQuiz,
    async (request, response, next) => {
      if (request.quiz.status !== "DRAFT") {
        return response.status(409).json({
          error: { code: "QUIZ_NOT_EDITABLE", message: "Only draft quizzes can be deleted." },
        });
      }
      try {
        const result = await withDraftEditLock(request.quiz._id, request.user.id, async () => {
          const deleted = await Quiz.findOneAndDelete({
            _id: request.quiz._id,
            createdBy: request.user.id,
            status: "DRAFT",
          });
          if (deleted) await Question.deleteMany({ quizId: request.quiz._id });
          return deleted;
        });
        if (!result.locked || !result.value) {
          return response.status(409).json({
            error: { code: "QUIZ_NOT_EDITABLE", message: "Only draft quizzes can be deleted." },
          });
        }
        response.status(204).end();
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    "/:quizId/questions",
    requireRole("TEACHER"),
    requireCsrf,
    loadOwnedQuiz,
    async (request, response, next) => {
      if (request.quiz.status !== "DRAFT") {
        return response.status(409).json({
          error: { code: "QUIZ_NOT_EDITABLE", message: "Questions are immutable after a quiz starts." },
        });
      }
      const parsed = questionSchema.safeParse(request.body);
      if (!parsed.success) return validationFailure(response, parsed);

      try {
        const result = await withDraftEditLock(request.quiz._id, request.user.id, async () => {
          const questionData = { ...parsed.data, quizId: request.quiz._id };
          if (questionData.order === undefined) {
            const lastQuestion = await Question.findOne({ quizId: request.quiz._id })
              .sort({ order: -1 })
              .select("order")
              .lean();
            questionData.order = (lastQuestion?.order ?? 0) + 1;
          }
          return Question.create(questionData);
        });
        if (!result.locked) {
          return response.status(409).json({
            error: { code: "QUIZ_NOT_EDITABLE", message: "Questions are immutable after a quiz starts." },
          });
        }
        const question = result.value;
        response.status(201).json({ question: { ...question.toObject(), id: question._id.toString() } });
      } catch (error) {
        if (error?.code === 11000) {
          return response.status(409).json({
            error: { code: "QUESTION_ORDER_IN_USE", message: "That question order is already in use." },
          });
        }
        next(error);
      }
    },
  );

  router.put(
    "/:quizId/questions/:questionId",
    requireRole("TEACHER"),
    requireCsrf,
    loadOwnedQuiz,
    async (request, response, next) => {
      if (request.quiz.status !== "DRAFT") {
        return response.status(409).json({
          error: { code: "QUIZ_NOT_EDITABLE", message: "Questions are immutable after a quiz starts." },
        });
      }
      if (!validObjectId(request.params.questionId)) {
        return response.status(404).json({
          error: { code: "QUESTION_NOT_FOUND", message: "Question not found." },
        });
      }
      const parsed = questionSchema.safeParse(request.body);
      if (!parsed.success) return validationFailure(response, parsed);

      try {
        const result = await withDraftEditLock(
          request.quiz._id,
          request.user.id,
          () =>
            Question.findOneAndUpdate(
              { _id: request.params.questionId, quizId: request.quiz._id },
              { $set: parsed.data },
              { new: true, runValidators: true },
            ),
        );
        if (!result.locked) {
          return response.status(409).json({
            error: { code: "QUIZ_NOT_EDITABLE", message: "Questions are immutable after a quiz starts." },
          });
        }
        const question = result.value;
        if (!question) {
          return response.status(404).json({
            error: { code: "QUESTION_NOT_FOUND", message: "Question not found." },
          });
        }
        response.json({ question: { ...question.toObject(), id: question._id.toString() } });
      } catch (error) {
        if (error?.code === 11000) {
          return response.status(409).json({
            error: { code: "QUESTION_ORDER_IN_USE", message: "That question order is already in use." },
          });
        }
        next(error);
      }
    },
  );

  router.delete(
    "/:quizId/questions/:questionId",
    requireRole("TEACHER"),
    requireCsrf,
    loadOwnedQuiz,
    async (request, response, next) => {
      if (request.quiz.status !== "DRAFT") {
        return response.status(409).json({
          error: { code: "QUIZ_NOT_EDITABLE", message: "Questions are immutable after a quiz starts." },
        });
      }
      if (!validObjectId(request.params.questionId)) {
        return response.status(404).json({
          error: { code: "QUESTION_NOT_FOUND", message: "Question not found." },
        });
      }
      try {
        const result = await withDraftEditLock(
          request.quiz._id,
          request.user.id,
          () =>
            Question.findOneAndDelete({
              _id: request.params.questionId,
              quizId: request.quiz._id,
            }),
        );
        if (!result.locked) {
          return response.status(409).json({
            error: { code: "QUIZ_NOT_EDITABLE", message: "Questions are immutable after a quiz starts." },
          });
        }
        const deleted = result.value;
        if (!deleted) {
          return response.status(404).json({
            error: { code: "QUESTION_NOT_FOUND", message: "Question not found." },
          });
        }
        response.status(204).end();
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    "/:quizId/start",
    requireRole("TEACHER"),
    requireCsrf,
    loadOwnedQuiz,
    async (request, response, next) => {
      if (request.quiz.status !== "DRAFT") {
        return response.status(409).json({
          error: { code: "INVALID_QUIZ_STATE", message: "Only draft quizzes can be started." },
        });
      }
      try {
        const questionCount = await Question.countDocuments({ quizId: request.quiz._id });
        if (questionCount < 1) {
          return response.status(422).json({
            error: { code: "QUIZ_REQUIRES_QUESTIONS", message: "Add at least one valid question before starting." },
          });
        }
        const quiz = await Quiz.findOneAndUpdate(
          {
            _id: request.quiz._id,
            createdBy: request.user.id,
            status: "DRAFT",
            $or: [
              { "draftEditLock.expiresAt": { $exists: false } },
              { "draftEditLock.expiresAt": { $lt: new Date() } },
            ],
          },
          { $set: { status: "ACTIVE", startedAt: new Date() } },
          { new: true, runValidators: true },
        );
        if (!quiz) {
          return response.status(409).json({
            error: { code: "INVALID_QUIZ_STATE", message: "Only draft quizzes can be started." },
          });
        }
        const eventDelivery = await publishLifecycleEvent(
          eventPublisher,
          quiz,
          "QUIZ_STARTED",
          request,
        );
        response.json({ quiz: { ...quiz.toObject(), id: quiz._id.toString() }, eventDelivery });
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    "/:quizId/end",
    requireRole("TEACHER"),
    requireCsrf,
    loadOwnedQuiz,
    async (request, response, next) => {
      if (request.quiz.status !== "ACTIVE") {
        return response.status(409).json({
          error: { code: "INVALID_QUIZ_STATE", message: "Only active quizzes can be completed." },
        });
      }
      try {
        const quiz = await Quiz.findOneAndUpdate(
          { _id: request.quiz._id, createdBy: request.user.id, status: "ACTIVE" },
          { $set: { status: "COMPLETED", endedAt: new Date(), resultsReleased: true } },
          { new: true, runValidators: true },
        );
        if (!quiz) {
          return response.status(409).json({
            error: { code: "INVALID_QUIZ_STATE", message: "Only active quizzes can be completed." },
          });
        }
        const finalizedAttempts = await finalizeQuizAttempts(quiz._id);
        for (const attempt of finalizedAttempts) {
          await publishStudentEvent(eventPublisher, {
            type: "ATTEMPT_SUBMITTED",
            quizId: quiz._id.toString(),
            studentId: attempt.studentId.toString(),
            attemptId: attempt._id.toString(),
          });
        }
        const eventDelivery = await publishLifecycleEvent(
          eventPublisher,
          quiz,
          "QUIZ_ENDED",
          request,
        );
        response.json({ quiz: { ...quiz.toObject(), id: quiz._id.toString() }, eventDelivery });
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}

export default createQuizRouter;
