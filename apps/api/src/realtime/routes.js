import { Router } from "express";
import mongoose from "mongoose";
import { requireAuth } from "../auth/middleware.js";
import { Quiz } from "../models/Quiz.js";
import { Attempt } from "../models/Attempt.js";

export function createRealtimeRouter({ bridge }) {
  const router = Router();
  router.get("/", requireAuth, async (request, response, next) => {
    const quizId = request.query.quizId;
    if (quizId !== undefined) {
      if (typeof quizId !== "string" || !mongoose.isValidObjectId(quizId)) {
        return response.status(400).json({
          error: { code: "INVALID_QUIZ_ID", message: "Quiz ID is invalid." },
        });
      }
      try {
        const quiz =
          request.user.role === "TEACHER"
            ? await Quiz.findOne({ _id: quizId, createdBy: request.user.id }).select("_id")
            : await Quiz.findOne({ _id: quizId, status: "ACTIVE" }).select("_id");
        if (!quiz) {
          return response.status(404).json({
            error: { code: "QUIZ_NOT_FOUND", message: "Quiz is not available." },
          });
        }
        if (request.user.role === "STUDENT") {
          const attempt = await Attempt.findOne({ quizId, studentId: request.user.id }).select("_id");
          if (!attempt) {
            return response.status(403).json({
              error: { code: "QUIZ_ACCESS_REQUIRED", message: "Join this quiz before subscribing to its events." },
            });
          }
        }
      } catch (error) {
        return next(error);
      }
    }
    if (!bridge) {
      return response.status(503).json({
        error: { code: "REALTIME_UNAVAILABLE", message: "Java TCP event delivery is not configured." },
      });
    }

    response.status(200);
    response.set({
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Accel-Buffering": "no",
    });
    response.flushHeaders();
    response.write("retry: 3000\n\n");

    // An open HTTP stream must not retain authorization after logout or expiry.
    let delivery = Promise.resolve();
    const queueWrite = (frame) => {
      delivery = delivery.then(async () => {
        if (response.writableEnded || response.destroyed) return;
        const session = await new Promise((resolve, reject) => {
          request.sessionStore.get(request.sessionID, (error, value) => error ? reject(error) : resolve(value));
        });
        if (!session || session.userId !== request.user.id || session.role !== request.user.role) {
          request.session = null;
          response.end();
          return;
        }
        response.write(frame);
      }).catch((error) => {
        console.error("SSE session validation failed:", error.message);
        response.end();
      });
      return delivery;
    };
    const sendEvent = (type, data) => {
      if (quizId && data.payload?.quizId && data.payload.quizId !== quizId) return delivery;
      return queueWrite(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    let subscription;
    let responseClosed = false;
    const keepAlive = setInterval(() => {
      void queueWrite(": keepalive\n\n");
    }, 15_000);
    keepAlive.unref();
    response.on("close", () => {
      responseClosed = true;
      clearInterval(keepAlive);
      subscription?.close();
    });

    try {
      subscription = await bridge.openSession(request.user, sendEvent);
      if (responseClosed) await subscription.close();
    } catch (error) {
      console.error("Could not establish authenticated Java TCP SSE session:", error);
      await sendEvent("error", {
        code: "JAVA_TCP_UNAVAILABLE",
        message: "Live notifications are temporarily unavailable; refresh REST state and reconnect.",
      });
      response.end();
    }
  });
  return router;
}
