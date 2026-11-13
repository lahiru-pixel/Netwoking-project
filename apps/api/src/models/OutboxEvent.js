import mongoose from "mongoose";

const outboxEventSchema = new mongoose.Schema(
  {
    eventId: { type: String, required: true, unique: true, immutable: true },
    type: {
      type: String,
      enum: [
        "QUIZ_STARTED",
        "QUIZ_ENDED",
        "STUDENT_JOINED",
        "PARTICIPATION_UPDATED",
        "ATTEMPT_SUBMITTED",
      ],
      required: true,
      immutable: true,
    },
    quizId: { type: mongoose.Schema.Types.ObjectId, ref: "Quiz", required: true, immutable: true },
    teacherId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, immutable: true },
    studentId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, immutable: true },
    attemptId: { type: mongoose.Schema.Types.ObjectId, ref: "Attempt", default: null, immutable: true },
    occurredAt: { type: Date, required: true, immutable: true },
    deliveryStatus: { type: String, enum: ["PENDING", "DELIVERED"], default: "PENDING", required: true },
    retryCount: { type: Number, min: 0, default: 0, required: true },
    nextAttemptAt: { type: Date, default: Date.now, required: true },
    deliveredAt: { type: Date, default: null },
    lastError: { type: String, default: null },
  },
  { timestamps: true, collection: "outboxEvents" },
);

outboxEventSchema.index({ deliveryStatus: 1, nextAttemptAt: 1 });

export const OutboxEvent = mongoose.model("OutboxEvent", outboxEventSchema);
