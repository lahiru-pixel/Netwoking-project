import { randomUUID } from "node:crypto";
import { Attempt } from "../models/Attempt.js";
import { OutboxEvent } from "../models/OutboxEvent.js";
import { Quiz } from "../models/Quiz.js";
import { JavaTcpClient } from "./tcp-client.js";

const LOBBY_ROOM = "__examflow_lobby__";

export class JavaTcpBridge {
  constructor({
    host = process.env.JAVA_TCP_HOST ?? "127.0.0.1",
    port = Number.parseInt(process.env.JAVA_TCP_PORT ?? "9090", 10),
    sharedSecret = process.env.JAVA_TCP_SHARED_SECRET,
  } = {}) {
    if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
      throw new Error("JAVA_TCP_HOST must be a loopback address.");
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error("JAVA_TCP_PORT must be a valid TCP port.");
    }
    if (!sharedSecret || sharedSecret.length < 32 || sharedSecret.toLowerCase().includes("replace-this")) {
      throw new Error("JAVA_TCP_SHARED_SECRET must be a unique value of at least 32 characters.");
    }

    this.host = host;
    this.port = port;
    this.sharedSecret = sharedSecret;
    this.control = null;
    this.sessions = new Set();
    this.outboxDeliveries = new Set();
    this.outboxTimer = null;
    this.started = false;
    this.closing = false;
  }

  async start() {
    if (this.started) return;
    this.started = true;
    this.control = new JavaTcpClient({
      host: this.host,
      port: this.port,
      sharedSecret: this.sharedSecret,
      sessionId: `node-control-${randomUUID()}`,
      role: "GATEWAY",
    });
    this.control.start()
      .then(() => console.info(`Authenticated persistent Java TCP control connection to ${this.host}:${this.port}.`))
      .catch((error) => console.error("Initial Java TCP control connection failed; reconnecting:", error.message));
    this.outboxTimer = setInterval(() => {
      this.flushOutbox().catch((error) => console.error("Could not process pending Java TCP notifications:", error));
    }, 1_000);
    this.outboxTimer.unref();
    this.flushOutbox().catch((error) => console.error("Could not process pending Java TCP notifications:", error));
  }

  async publishLifecycleEvent(event) {
    return this.enqueueEvent(event);
  }

  async publishStudentEvent(event) {
    if (!["STUDENT_JOINED", "PARTICIPATION_UPDATED", "ATTEMPT_SUBMITTED"].includes(event.type)) {
      throw new Error(`Unsupported Java TCP student event: ${event.type}`);
    }
    return this.enqueueEvent(event);
  }

  async enqueueEvent(event) {
    const record = await OutboxEvent.create({
      eventId: randomUUID(),
      type: event.type,
      quizId: event.quizId,
      teacherId: event.teacherId ?? null,
      studentId: event.studentId ?? null,
      attemptId: event.attemptId ?? null,
      occurredAt: event.occurredAt ?? new Date(),
    });
    return this.deliverOutboxEvent(record);
  }

  async deliverOutboxEvent(record) {
    const eventKey = record._id.toString();
    if (this.outboxDeliveries.has(eventKey)) {
      return { status: "retry_scheduled", eventId: record.eventId };
    }
    this.outboxDeliveries.add(eventKey);
    try {
      if (!this.control) throw new Error("Java TCP control connection is unavailable.");
      const commandType = record.type === "QUIZ_STARTED"
        ? "START_QUIZ"
        : record.type === "QUIZ_ENDED" ? "END_QUIZ" : record.type;
      const payload = {
        quizId: record.quizId.toString(),
        ...(record.teacherId ? { teacherId: record.teacherId.toString() } : {}),
        ...(record.studentId ? { studentId: record.studentId.toString() } : {}),
        ...(record.attemptId ? { attemptId: record.attemptId.toString() } : {}),
        occurredAt: record.occurredAt.toISOString(),
      };
      await this.control.request(commandType, payload, {
        timeoutMs: 2_500,
        messageId: record.eventId,
      });
      await OutboxEvent.updateOne(
        { _id: record._id, deliveryStatus: "PENDING" },
        { $set: { deliveryStatus: "DELIVERED", deliveredAt: new Date(), lastError: null } },
      );
      return { status: "accepted_by_java", messageId: record.eventId };
    } catch (error) {
      const retryCount = record.retryCount + 1;
      const delayMs = Math.min(30_000, 500 * (2 ** Math.min(retryCount - 1, 6)));
      const message = error instanceof Error ? error.message.slice(0, 500) : "Unknown Java TCP delivery error.";
      await OutboxEvent.updateOne(
        { _id: record._id, deliveryStatus: "PENDING" },
        {
          $inc: { retryCount: 1 },
          $set: { nextAttemptAt: new Date(Date.now() + delayMs), lastError: message },
        },
      );
      console.error(`Java TCP event ${record.type} (${record.eventId}) queued for retry: ${message}`);
      return { status: "retry_scheduled", eventId: record.eventId, retryCount };
    } finally {
      this.outboxDeliveries.delete(eventKey);
    }
  }

  async flushOutbox() {
    const pending = await OutboxEvent.find({
      deliveryStatus: "PENDING",
      nextAttemptAt: { $lte: new Date() },
    }).sort({ createdAt: 1 }).limit(25);
    for (const record of pending) {
      await this.deliverOutboxEvent(record);
    }
  }

  async openSession(user, onEvent) {
    if (this.closing) throw new Error("Java TCP bridge is shutting down.");
    const quizFilter =
      user.role === "TEACHER"
        ? { createdBy: user.id, status: "ACTIVE" }
        : { status: "ACTIVE" };
    const activeQuizzes = await Quiz.find(quizFilter).select("_id").lean();
    const rooms = new Set([LOBBY_ROOM, ...activeQuizzes.map((quiz) => quiz._id.toString())]);
    const connection = new JavaTcpClient({
      host: this.host,
      port: this.port,
      sharedSecret: this.sharedSecret,
      sessionId: `sse-${randomUUID()}`,
      role: user.role,
      rooms: [...rooms],
    });
    const session = { user, connection, onEvent, rooms, closed: false };
    this.sessions.add(session);

    connection.on("event", (message) => {
      this.forwardJavaEvent(session, message).catch((error) => {
        console.error(`Could not forward Java TCP event to SSE session ${connection.sessionId}:`, error);
      });
    });
    connection.on("reconnected", () => {
      if (session.closed) return;
      this.refreshSessionRooms(session)
        .then(() => {
          console.info(`Java TCP session reconnected: ${connection.sessionId}; requesting REST state sync.`);
          session.onEvent("sync", { reason: "java_reconnected", source: "rest" });
        })
        .catch((error) => console.error(`Could not resynchronize Java TCP rooms for ${connection.sessionId}:`, error));
    });
    connection.on("disconnect", () => {
      if (!session.closed) {
        console.warn(`Java TCP session disconnected: ${connection.sessionId}. Reconnecting.`);
      }
    });

    try {
      await connection.start();
      session.onEvent("sync", { reason: "connected", source: "rest" });
      return {
        close: () => this.closeSession(session),
      };
    } catch (error) {
      await this.closeSession(session);
      throw error;
    }
  }

  async forwardJavaEvent(session, message) {
    if (session.closed) return;
    const eventType = message.type;
    const quizId = message.payload?.quizId;
    if (typeof quizId !== "string") return;

    if (eventType === "QUIZ_STARTED") {
      const quiz = await Quiz.findOne({ _id: quizId, status: "ACTIVE" }).select("createdBy").lean();
      if (!quiz) return;
      if (session.user.role === "TEACHER" && quiz.createdBy.toString() !== session.user.id) return;
      await session.connection.joinRoom(quizId);
      session.rooms.add(quizId);
    } else if (eventType === "QUIZ_ENDED") {
      const quiz = await Quiz.findOne({ _id: quizId, status: "COMPLETED" }).select("createdBy").lean();
      if (!quiz) return;
      if (session.user.role === "TEACHER" && quiz.createdBy.toString() !== session.user.id) return;
      if (session.user.role === "STUDENT") {
        const hasAttempt = await Attempt.exists({ quizId, studentId: session.user.id });
        if (!hasAttempt) return;
      }
    } else if (["STUDENT_JOINED", "PARTICIPATION_UPDATED", "ATTEMPT_SUBMITTED"].includes(eventType)) {
      const quiz = await Quiz.findOne({
        _id: quizId,
        status: { $in: ["ACTIVE", "COMPLETED"] },
      }).select("createdBy").lean();
      if (!quiz) return;
      if (session.user.role === "TEACHER") {
        if (quiz.createdBy.toString() !== session.user.id) return;
      } else {
        const hasAttempt = await Attempt.exists({ quizId, studentId: session.user.id });
        if (!hasAttempt) return;
      }
    } else if (!session.rooms.has(quizId)) {
      return;
    }

    console.info(`Java TCP event received: ${eventType} quiz=${quizId} -> SSE session ${session.connection.sessionId}.`);
    const forwarded = { ...message, source: "java_tcp" };
    if (session.user.role === "STUDENT"
      && ["STUDENT_JOINED", "PARTICIPATION_UPDATED", "ATTEMPT_SUBMITTED"].includes(eventType)) {
      forwarded.payload = { quizId };
    }
    session.onEvent(eventType, forwarded);
    if (eventType === "QUIZ_ENDED") {
      await session.connection.leaveRoom(quizId);
      session.rooms.delete(quizId);
    }
  }

  async refreshSessionRooms(session) {
    if (session.closed) return;
    const filter =
      session.user.role === "TEACHER"
        ? { createdBy: session.user.id, status: "ACTIVE" }
        : { status: "ACTIVE" };
    const quizzes = await Quiz.find(filter).select("_id").lean();
    const activeRooms = new Set([LOBBY_ROOM, ...quizzes.map((quiz) => quiz._id.toString())]);
    for (const roomId of session.rooms) {
      if (roomId !== LOBBY_ROOM && !activeRooms.has(roomId)) {
        await session.connection.leaveRoom(roomId);
        session.rooms.delete(roomId);
      }
    }
    for (const roomId of activeRooms) {
      if (roomId === LOBBY_ROOM) continue;
      await session.connection.joinRoom(roomId);
      session.rooms.add(roomId);
    }
  }

  async closeSession(session) {
    if (session.closed) return;
    session.closed = true;
    this.sessions.delete(session);
    await session.connection.close();
  }

  async close() {
    if (this.closing) return;
    this.closing = true;
    clearInterval(this.outboxTimer);
    await Promise.all([...this.sessions].map((session) => this.closeSession(session)));
    await this.control?.close();
    this.control = null;
  }
}

export function createJavaTcpBridge(options) {
  return new JavaTcpBridge(options);
}
