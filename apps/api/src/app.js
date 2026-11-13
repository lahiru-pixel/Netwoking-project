import express from "express";
import session from "express-session";
import mongoose from "mongoose";
import MongoStore from "connect-mongo";
import { randomUUID } from "node:crypto";
import authRoutes from "./auth/routes.js";
import { requireAuth, requireRole } from "./auth/middleware.js";
import { createQuizRouter } from "./quizzes/routes.js";
import { createUnconfiguredEventPublisher } from "./quizzes/event-publisher.js";
import { createRealtimeRouter } from "./realtime/routes.js";
import { createAttemptRouter } from "./attempts/routes.js";
import { createResultRouter } from "./results/routes.js";
import { Attempt } from "./models/Attempt.js";
import { Quiz } from "./models/Quiz.js";
import { Question } from "./models/Question.js";
import "./config.js";

export function createApp({
  sessionStore,
  eventPublisher = createUnconfiguredEventPublisher(),
  realtimeBridge,
} = {}) {
  const sessionSecret = process.env.SESSION_SECRET;
  const mongoUri = process.env.MONGODB_URI;

  if (!sessionSecret || sessionSecret.length < 32 || sessionSecret.includes("replace-this")) {
    throw new Error("SESSION_SECRET must be a unique random value of at least 32 characters.");
  }
  if (!mongoUri) {
    throw new Error("MONGODB_URI must be set; refusing to start without local MongoDB.");
  }

  const app = express();
  const store =
    sessionStore ??
    MongoStore.create({
      mongoUrl: mongoUri,
      collectionName: "sessions",
      ttl: 8 * 60 * 60,
      autoRemove: "native",
    });

  app.disable("x-powered-by");
  app.set("trust proxy", process.env.NODE_ENV === "production" ? 1 : false);
  app.use((request, response, next) => {
    request.requestId = randomUUID();
    response.set("X-Request-Id", request.requestId);
    const json = response.json.bind(response);
    response.json = (body) => json(
      response.statusCode >= 400 && body?.error
        ? { ...body, requestId: request.requestId }
        : body,
    );
    next();
  });
  app.use(express.json({ limit: "16kb" }));
  app.use(
    session({
      name: "examflow.sid",
      secret: sessionSecret,
      store,
      resave: false,
      saveUninitialized: false,
      rolling: true,
      cookie: {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        maxAge: 8 * 60 * 60 * 1000,
        path: "/",
      },
    }),
  );

  const allowedOrigins = new Set(
    (process.env.CLIENT_ORIGIN ?? "http://localhost:5173")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  );
  app.use((request, response, next) => {
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) return next();

    const origin = request.get("origin");
    const requestHost = request.get("x-forwarded-host") ?? request.get("host");
    const sameDevelopmentHost =
      process.env.NODE_ENV !== "production" &&
      requestHost?.endsWith(":5173") &&
      origin === `http://${requestHost}`;
    if (origin && !allowedOrigins.has(origin) && !sameDevelopmentHost) {
      return response.status(403).json({
        error: { code: "ORIGIN_NOT_ALLOWED", message: "This request origin is not allowed." },
        requestId: request.requestId,
      });
    }

    next();
  });

  app.get("/api/health", (_request, response) => {
    const databaseConnected = mongoose.connection.readyState === 1;

    response.status(databaseConnected ? 200 : 503).json({
      status: databaseConnected ? "ok" : "unavailable",
      database: databaseConnected ? "connected" : "disconnected",
    });
  });
  app.use("/api/auth", authRoutes);
  const realtimeRouter = createRealtimeRouter({ bridge: realtimeBridge });
  app.use("/api/events", realtimeRouter);
  app.use("/api/realtime/events", realtimeRouter);
  app.use("/api/quizzes", createQuizRouter({ eventPublisher }));
  app.use("/api/attempts", createAttemptRouter({ eventPublisher }));
  app.use("/api/results", createResultRouter());
  app.get(
    "/api/student/dashboard",
    requireAuth,
    requireRole("STUDENT"),
    async (request, response, next) => {
      try {
        const [quizzes, attempts] = await Promise.all([
          Quiz.find({ status: "ACTIVE" }).sort({ startedAt: -1 }).select("title description durationMinutes startedAt").lean(),
          Attempt.find({
            studentId: request.user.id,
            status: { $in: ["SUBMITTED", "AUTO_SUBMITTED"] },
          }).select("quizId status score totalMarks submittedAt").sort({ submittedAt: -1 }).lean(),
        ]);
        const releasedQuizzes = await Quiz.find({
          _id: { $in: attempts.map((attempt) => attempt.quizId) },
          resultsReleased: true,
          status: "COMPLETED",
        }).select("_id").lean();
        const releasedIds = new Set(releasedQuizzes.map((quiz) => quiz._id.toString()));
        response.set("Cache-Control", "no-store");
        response.json({
          user: request.user,
          availableQuizzes: quizzes.map((quiz) => ({ ...quiz, id: quiz._id.toString() })),
          submittedAttempts: attempts.filter((attempt) => releasedIds.has(attempt.quizId.toString())).map((attempt) => ({
            ...attempt,
            id: attempt._id.toString(),
            quizId: attempt.quizId.toString(),
          })),
        });
      } catch (error) {
        next(error);
      }
    },
  );
  app.get(
    "/api/teacher/dashboard",
    requireAuth,
    requireRole("TEACHER"),
    async (request, response, next) => {
      try {
        const quizzes = await Quiz.find({ createdBy: request.user.id })
          .sort({ updatedAt: -1 })
          .lean();
        const counts = await Question.aggregate([
          { $match: { quizId: { $in: quizzes.map((quiz) => quiz._id) } } },
          { $group: { _id: "$quizId", count: { $sum: 1 } } },
        ]);
        const countByQuizId = new Map(
          counts.map((entry) => [entry._id.toString(), entry.count]),
        );
        response.json({
          user: request.user,
          quizzes: quizzes.map((quiz) => ({
            ...quiz,
            id: quiz._id.toString(),
            createdBy: quiz.createdBy.toString(),
            questionCount: countByQuizId.get(quiz._id.toString()) ?? 0,
          })),
        });
      } catch (error) {
        next(error);
      }
    },
  );
  app.use(
    "/api/student",
    requireAuth,
    requireRole("STUDENT"),
    (_request, response) => response.status(404).json({
      error: { code: "NOT_FOUND", message: "The requested resource was not found." },
    }),
  );
  app.use(
    "/api/teacher",
    requireAuth,
    requireRole("TEACHER"),
    (_request, response) => response.status(404).json({
      error: { code: "NOT_FOUND", message: "The requested resource was not found." },
    }),
  );
  app.use((request, response) => {
    response.status(404).json({
      error: { code: "NOT_FOUND", message: "The requested resource was not found." },
      requestId: request.requestId,
    });
  });
  app.use((error, request, response, _next) => {
    if (error?.type === "entity.parse.failed") {
      return response.status(400).json({
        error: { code: "INVALID_JSON", message: "Request body must be valid JSON." },
        requestId: request.requestId,
      });
    }
    console.error(`[${request.requestId}] Request failed:`, error);
    response.status(500).json({
      error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred." },
      requestId: request.requestId,
    });
  });

  app.locals.sessionStore = store;
  app.locals.realtimeBridge = realtimeBridge;
  return app;
}
