import { randomUUID } from "node:crypto";
import { Attempt } from "../models/Attempt.js";
import { Question } from "../models/Question.js";
import { Quiz } from "../models/Quiz.js";

export async function finalizeAttempt(attemptId, { reason, now = new Date() }) {
  const token = randomUUID();
  const lockTime = new Date(Math.max(now.getTime(), Date.now()));
  const lockExpiry = new Date(lockTime.getTime() + 60_000);
  const initialAttempt =
    reason === "MANUAL" ? await Attempt.findById(attemptId).select("expiresAt") : null;
  const requestedReason =
    reason === "MANUAL" && initialAttempt?.expiresAt <= lockTime ? "TIME_EXPIRED" : reason;
  const filter = {
    _id: attemptId,
    status: "IN_PROGRESS",
    $or: [
      { "finalizeLock.expiresAt": { $exists: false } },
      { "finalizeLock.expiresAt": { $lt: lockTime } },
    ],
  };
  if (requestedReason === "MANUAL") {
    filter.expiresAt = { $gt: lockTime };
  } else if (requestedReason === "TIME_EXPIRED") {
    filter.expiresAt = { $lte: lockTime };
  }

  const locked = await Attempt.findOneAndUpdate(
    filter,
    { $set: { finalizeLock: { token, expiresAt: lockExpiry } } },
    { new: true },
  );
  if (!locked) return { finalized: false, attempt: await Attempt.findById(attemptId) };

  try {
    const finalizedAt = new Date(Math.max(now.getTime(), Date.now()));
    const [quiz, questions] = await Promise.all([
      Quiz.findById(locked.quizId).select("status endedAt"),
      Question.find({ quizId: locked.quizId }).select("_id correctOptionId marks"),
    ]);
    if (!quiz) throw new Error(`Attempt ${attemptId} references a missing quiz.`);

    const submissionReason =
      requestedReason === "QUIZ_ENDED" || quiz.status === "COMPLETED"
        ? "QUIZ_ENDED"
        : finalizedAt >= locked.expiresAt
          ? "TIME_EXPIRED"
          : requestedReason;
    const answerByQuestion = new Map(
      locked.answers
        .filter((answer) => !quiz.endedAt || answer.savedAt <= quiz.endedAt)
        .map((answer) => [answer.questionId.toString(), answer.optionId]),
    );
    let score = 0;
    let totalMarks = 0;

    for (const question of questions) {
      totalMarks += question.marks;
      if (answerByQuestion.get(question._id.toString()) === question.correctOptionId) {
        score += question.marks;
      }
    }

    const status = submissionReason === "MANUAL" ? "SUBMITTED" : "AUTO_SUBMITTED";
    const updated = await Attempt.findOneAndUpdate(
      { _id: attemptId, status: "IN_PROGRESS", "finalizeLock.token": token },
      {
        $set: {
          status,
          submissionReason,
          submittedAt: finalizedAt,
          score,
          totalMarks,
        },
        $unset: { finalizeLock: 1 },
      },
      { new: true },
    );

    return { finalized: Boolean(updated), attempt: updated ?? (await Attempt.findById(attemptId)) };
  } catch (error) {
    await Attempt.updateOne(
      { _id: attemptId, status: "IN_PROGRESS", "finalizeLock.token": token },
      { $unset: { finalizeLock: 1 } },
    );
    throw error;
  }
}

export async function finalizeQuizAttempts(quizId, now = new Date()) {
  const attempts = await Attempt.find({ quizId, status: "IN_PROGRESS" }).select("_id").lean();
  const finalized = [];
  for (const attempt of attempts) {
    const result = await finalizeAttempt(attempt._id, { reason: "QUIZ_ENDED", now });
    if (result.finalized) finalized.push(result.attempt);
  }
  return finalized;
}

export async function finalizeDueAttempts(now = new Date(), limit = 100) {
  const completedQuizzes = await Quiz.find({ status: "COMPLETED" }).select("_id").lean();
  const completedQuizIds = new Set(completedQuizzes.map((quiz) => quiz._id.toString()));
  const expired = await Attempt.find({
    status: "IN_PROGRESS",
    $or: [
      { expiresAt: { $lte: now } },
      { quizId: { $in: completedQuizzes.map((quiz) => quiz._id) } },
    ],
  })
    .sort({ expiresAt: 1 })
    .limit(limit)
    .select("_id quizId")
    .lean();

  const finalized = [];
  for (const attempt of expired) {
    const result = await finalizeAttempt(attempt._id, {
      reason: completedQuizIds.has(attempt.quizId.toString())
        ? "QUIZ_ENDED"
        : "TIME_EXPIRED",
      now,
    });
    if (result.finalized) finalized.push(result.attempt);
  }
  return finalized;
}
