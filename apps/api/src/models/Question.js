import mongoose from "mongoose";

const optionSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    text: { type: String, required: true, trim: true, maxlength: 500 },
  },
  { _id: false },
);

const questionSchema = new mongoose.Schema(
  {
    quizId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Quiz",
      required: true,
      immutable: true,
      index: true,
    },
    text: { type: String, required: true, trim: true, minlength: 3, maxlength: 2000 },
    options: {
      type: [optionSchema],
      required: true,
      validate: {
        validator: (options) => Array.isArray(options) && options.length === 4,
        message: "A question must have exactly four options.",
      },
    },
    correctOptionId: { type: String, required: true },
    marks: { type: Number, required: true, min: Number.MIN_VALUE, max: 10000 },
    order: { type: Number, required: true, min: 1, max: 10000 },
  },
  { timestamps: true, collection: "questions" },
);

questionSchema.index({ quizId: 1, order: 1 }, { unique: true });

export const Question = mongoose.model("Question", questionSchema);
