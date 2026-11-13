import mongoose from "mongoose";

const answerSchema = new mongoose.Schema(
  {
    questionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Question",
      required: true,
    },
    optionId: { type: String, required: true },
    savedAt: { type: Date, required: true },
  },
  { _id: false },
);

const finalizeLockSchema = new mongoose.Schema(
  {
    token: { type: String, select: false },
    expiresAt: { type: Date, select: false },
  },
  { _id: false },
);

const attemptSchema = new mongoose.Schema(
  {
    quizId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Quiz",
      required: true,
      immutable: true,
    },
    studentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      immutable: true,
    },
    startedAt: { type: Date, required: true, immutable: true },
    expiresAt: { type: Date, required: true, immutable: true },
    answers: { type: [answerSchema], default: [] },
    status: {
      type: String,
      enum: ["IN_PROGRESS", "SUBMITTED", "AUTO_SUBMITTED"],
      default: "IN_PROGRESS",
      required: true,
    },
    submittedAt: { type: Date, default: null },
    submissionReason: {
      type: String,
      enum: ["MANUAL", "TIME_EXPIRED", "QUIZ_ENDED", null],
      default: null,
    },
    score: { type: Number, default: null, min: 0 },
    totalMarks: { type: Number, default: null, min: 0 },
    finalizeLock: { type: finalizeLockSchema, default: undefined, select: false },
  },
  { timestamps: true, collection: "attempts" },
);

attemptSchema.index({ quizId: 1, studentId: 1 }, { unique: true });
attemptSchema.index({ status: 1, expiresAt: 1 });
attemptSchema.index({ studentId: 1, submittedAt: -1 });

export const Attempt = mongoose.model("Attempt", attemptSchema);
