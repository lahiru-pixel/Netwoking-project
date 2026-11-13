import mongoose from "mongoose";

const draftEditLockSchema = new mongoose.Schema(
  {
    token: { type: String, select: false },
    expiresAt: { type: Date, select: false },
  },
  { _id: false },
);

const quizSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, minlength: 3, maxlength: 120 },
    description: { type: String, trim: true, maxlength: 1000, default: "" },
    instructions: { type: String, trim: true, maxlength: 2000, default: "" },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
      immutable: true,
    },
    durationMinutes: { type: Number, required: true, min: 1, max: 1440 },
    status: {
      type: String,
      enum: ["DRAFT", "ACTIVE", "COMPLETED"],
      default: "DRAFT",
      required: true,
    },
    startedAt: { type: Date, default: null },
    endedAt: { type: Date, default: null },
    resultsReleased: { type: Boolean, default: false },
    draftEditLock: { type: draftEditLockSchema, default: undefined, select: false },
  },
  { timestamps: true, collection: "quizzes" },
);

quizSchema.index({ createdBy: 1, status: 1, updatedAt: -1 });

export const Quiz = mongoose.model("Quiz", quizSchema);
