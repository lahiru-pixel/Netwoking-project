import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import http from "node:http";
import mongoose from "mongoose";
import supertest from "supertest";
import bcrypt from "bcryptjs";
import { once } from "node:events";
import { createApp } from "../app.js";
import { User } from "../models/User.js";
import { Quiz } from "../models/Quiz.js";
import { Attempt } from "../models/Attempt.js";
import { createJavaTcpBridge } from "./java-bridge.js";

process.env.MONGODB_URI = "mongodb://127.0.0.1:27017/examflow_java_sse_test";
process.env.SESSION_SECRET = "java-sse-test-session-secret-that-is-long-enough";
process.env.CLIENT_ORIGIN = "http://localhost:5173";
process.env.NODE_ENV = "test";
process.env.JAVA_TCP_HOST ??= "127.0.0.1";
process.env.JAVA_TCP_PORT ??= "9090";
process.env.JAVA_TCP_SHARED_SECRET ??= "local-integration-shared-secret-at-least-32";

class SseBrowserClient {
  constructor(serverPort, cookie, path = "/api/realtime/events") {
    this.buffer = "";
    this.events = [];
    this.waiters = [];
    this.request = http.get({
      host: "127.0.0.1",
      port: serverPort,
      path,
      headers: { Cookie: cookie, Accept: "text/event-stream" },
    });
    this.response = null;
    this.ready = new Promise((resolve, reject) => {
      this.request.once("response", (response) => {
        this.response = response;
        if (response.statusCode !== 200) {
          reject(new Error(`SSE request failed with HTTP ${response.statusCode}.`));
          response.resume();
          return;
        }
        response.setEncoding("utf8");
        response.on("data", (chunk) => this.receive(chunk));
        response.once("error", reject);
        resolve();
      });
      this.request.once("error", reject);
    });
  }

  receive(chunk) {
    this.buffer += chunk;
    let boundary;
    while ((boundary = this.buffer.indexOf("\n\n")) !== -1) {
      const frame = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      let type = "message";
      let data = "";
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) type = line.slice(6).trim();
        if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (!data) continue;
      const event = { type, data: JSON.parse(data) };
      const waiterIndex = this.waiters.findIndex((waiter) => waiter.type === type);
      if (waiterIndex >= 0) this.waiters.splice(waiterIndex, 1)[0].resolve(event);
      else this.events.push(event);
    }
  }

  async waitFor(type, timeoutMs = 5_000) {
    await this.ready;
    const queuedIndex = this.events.findIndex((event) => event.type === type);
    if (queuedIndex >= 0) return this.events.splice(queuedIndex, 1)[0];
    return new Promise((resolve, reject) => {
      const waiter = {
        type,
        resolve: (event) => {
          clearTimeout(timer);
          resolve(event);
        },
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((item) => item !== waiter);
        reject(new Error(`Timed out waiting for SSE event ${type}.`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  close() {
    this.response?.destroy();
    this.request.destroy();
  }
}

async function login(role, email, password) {
  const agent = supertest.agent(server);
  const csrf = (await agent.get("/api/auth/csrf").expect(200)).body.csrfToken;
  const response = await agent
    .post(`/api/auth/${role.toLowerCase()}/login`)
    .set("X-CSRF-Token", csrf)
    .send({ email, password })
    .expect(200);
  return {
    agent,
    csrfToken: response.body.csrfToken,
    cookie: response.headers["set-cookie"]
      .find((value) => value.startsWith("examflow.sid="))
      .split(";")[0],
  };
}

let server;
let app;
let bridge;
let teacher;
let students;
let browsers = [];

before(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  await mongoose.connection.dropDatabase();
  teacher = await User.create({
    name: "TCP Teacher",
    email: "tcp-teacher@example.test",
    passwordHash: await bcrypt.hash("tcp-teacher-password-123", 4),
    role: "TEACHER",
  });
  students = await Promise.all([
    User.create({
      name: "TCP Student One",
      email: "tcp-student-one@example.test",
      passwordHash: await bcrypt.hash("tcp-student-one-password-123", 4),
      role: "STUDENT",
    }),
    User.create({
      name: "TCP Student Two",
      email: "tcp-student-two@example.test",
      passwordHash: await bcrypt.hash("tcp-student-two-password-123", 4),
      role: "STUDENT",
    }),
  ]);
  bridge = createJavaTcpBridge();
  await bridge.start();
  app = createApp({ eventPublisher: bridge, realtimeBridge: bridge });
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
});

after(async () => {
  for (const browser of browsers) browser.close();
  await bridge.close();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await app.locals.sessionStore.close();
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

test("one teacher and two student SSE browsers receive Java TCP events", async () => {
  const teacherSession = await login("teacher", teacher.email, "tcp-teacher-password-123");
  const studentSessions = await Promise.all([
    login("student", students[0].email, "tcp-student-one-password-123"),
    login("student", students[1].email, "tcp-student-two-password-123"),
  ]);
  browsers = [
    new SseBrowserClient(server.address().port, teacherSession.cookie),
    ...studentSessions.map((session) => new SseBrowserClient(server.address().port, session.cookie)),
  ];
  await Promise.all(browsers.map(async (browser) => {
    const event = await browser.waitFor("sync");
    assert.equal(event.data.source, "rest");
  }));

  const created = await teacherSession.agent
    .post("/api/quizzes")
    .set("X-CSRF-Token", teacherSession.csrfToken)
    .send({ title: "TCP SSE Integration Exam", durationMinutes: 5 })
    .expect(201);
  const quizId = created.body.quiz.id;
  const restReadStartedAt = performance.now();
  await studentSessions[0].agent.get("/api/quizzes").expect(200);
  const restReadMs = performance.now() - restReadStartedAt;
  assert.ok(restReadMs < 1_000, "local quiz REST read must finish within one second");
  await teacherSession.agent
    .post(`/api/quizzes/${quizId}/questions`)
    .set("X-CSRF-Token", teacherSession.csrfToken)
    .send({
      text: "Which answer is correct?",
      options: [
        { id: "option-a", text: "Correct answer" },
        { id: "option-b", text: "Wrong answer one" },
        { id: "option-c", text: "Wrong answer two" },
        { id: "option-d", text: "Wrong answer three" },
      ],
      correctOptionId: "option-a",
      marks: 1,
      order: 1,
    })
    .expect(201);

  const broadcastStartedAt = performance.now();
  const startResponse = await teacherSession.agent
    .post(`/api/quizzes/${quizId}/start`)
    .set("X-CSRF-Token", teacherSession.csrfToken)
    .send({})
    .expect(200);
  assert.equal(startResponse.body.eventDelivery.status, "accepted_by_java");
  const startEvents = await Promise.all(browsers.map((browser) => browser.waitFor("QUIZ_STARTED")));
  for (const event of startEvents) {
    assert.equal(event.data.source, "java_tcp");
    assert.equal(event.data.type, "QUIZ_STARTED");
    assert.equal(event.data.payload.quizId, quizId);
  }
  const broadcastMs = performance.now() - broadcastStartedAt;
  assert.ok(broadcastMs < 3_000, "quiz start must reach connected SSE clients within three seconds");
  console.info(`NFR-03 local timings: REST read ${restReadMs.toFixed(1)} ms; three-client quiz broadcast ${broadcastMs.toFixed(1)} ms.`);

  const firstJoin = await studentSessions[0].agent
    .post(`/api/quizzes/${quizId}/join`)
    .set("X-CSRF-Token", studentSessions[0].csrfToken)
    .send({})
    .expect(201);
  assert.equal(firstJoin.body.eventDelivery.status, "accepted_by_java");
  const teacherJoin = await browsers[0].waitFor("STUDENT_JOINED");
  assert.equal(teacherJoin.data.source, "java_tcp");
  assert.equal(teacherJoin.data.payload.quizId, quizId);
  assert.equal(teacherJoin.data.payload.attemptId, firstJoin.body.attempt.id);

  const secondJoin = await studentSessions[1].agent
    .post(`/api/quizzes/${quizId}/join`)
    .set("X-CSRF-Token", studentSessions[1].csrfToken)
    .send({})
    .expect(201);
  assert.equal(secondJoin.body.eventDelivery.status, "accepted_by_java");
  const secondStudentTcpSession = [...bridge.sessions]
    .find((session) => session.user.id === students[1]._id.toString());
  assert.ok(secondStudentTcpSession, "second student must have its own Java TCP session");
  secondStudentTcpSession.connection.socket.destroy();
  const reconnectSync = await browsers[2].waitFor("sync");
  assert.equal(reconnectSync.data.reason, "java_reconnected");
  assert.equal(reconnectSync.data.source, "rest");
  browsers[2].close();
  browsers[2] = new SseBrowserClient(server.address().port, studentSessions[1].cookie);
  const browserReconnectSync = await browsers[2].waitFor("sync");
  assert.equal(browserReconnectSync.data.reason, "connected");
  assert.equal(browserReconnectSync.data.source, "rest");

  const submissionEventOne = browsers[1].waitFor("ATTEMPT_SUBMITTED");
  const submissionEventTwo = browsers[2].waitFor("ATTEMPT_SUBMITTED");
  await studentSessions[0].agent
    .post(`/api/attempts/${firstJoin.body.attempt.id}/submit`)
    .set("X-CSRF-Token", studentSessions[0].csrfToken)
    .send({})
    .expect(200);
  for (const event of await Promise.all([submissionEventOne, submissionEventTwo])) {
    assert.equal(event.data.source, "java_tcp");
    assert.equal(event.data.payload.quizId, quizId);
    assert.equal(event.data.payload.attemptId, undefined);
  }

  const completed = await Quiz.findById(quizId).select("status").lean();
  assert.equal(completed.status, "ACTIVE");
  assert.equal(await Attempt.countDocuments({ quizId }), 2);
});

test("logged-out SSE streams close before forwarding subsequent Java events", async () => {
  const session = await login("teacher", teacher.email, "tcp-teacher-password-123");
  const browser = new SseBrowserClient(server.address().port, session.cookie);
  browsers.push(browser);
  await browser.waitFor("sync");
  await session.agent.post("/api/auth/logout").set("X-CSRF-Token", session.csrfToken).expect(204);
  const ended = once(browser.response, "end", { signal: AbortSignal.timeout(5000) });
  const quiz = await Quiz.findOne({ createdBy: teacher._id, status: "ACTIVE" });
  await bridge.publishLifecycleEvent({ type: "QUIZ_STARTED", quizId: quiz._id.toString(), teacherId: teacher._id.toString() });
  await ended;
  assert.equal(browser.events.some((event) => event.type === "QUIZ_STARTED"), false);
});
