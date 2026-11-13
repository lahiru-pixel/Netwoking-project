import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import mongoose from "mongoose";
import supertest from "supertest";

process.env.MONGODB_URI = "mongodb://127.0.0.1:27017/examflow_quiz_test";
process.env.SESSION_SECRET = "quiz-test-session-secret-that-is-long-enough";
process.env.CLIENT_ORIGIN = "http://localhost:5173";
process.env.NODE_ENV = "test";

const { createApp } = await import("../app.js");
const { User } = await import("../models/User.js");
const { Question } = await import("../models/Question.js");
const { Quiz } = await import("../models/Quiz.js");
const { OutboxEvent } = await import("../models/OutboxEvent.js");
const { createJavaTcpBridge } = await import("../realtime/java-bridge.js");
const { createTeacherUser } = await import("../auth/seed-teacher.js");
const bcrypt = (await import("bcryptjs")).default;

let server;
let app;
let owner;
let otherTeacher;
let student;
let lifecycleEvents;

async function login(role, email, password) {
  const agent = supertest.agent(server);
  const csrfToken = (await agent.get("/api/auth/csrf").expect(200)).body.csrfToken;
  const response = await agent
    .post(`/api/auth/${role.toLowerCase()}/login`)
    .set("X-CSRF-Token", csrfToken)
    .send({ email, password })
    .expect(200);
  return { agent, csrfToken: response.body.csrfToken };
}

function quizBody(overrides = {}) {
  return {
    title: "Operating Systems",
    description: "Core concepts assessment",
    instructions: "Choose the best answer.",
    durationMinutes: 30,
    ...overrides,
  };
}

function questionBody(overrides = {}) {
  const options = [
    { id: "option-a", text: "First answer" },
    { id: "option-b", text: "Second answer" },
    { id: "option-c", text: "Third answer" },
    { id: "option-d", text: "Fourth answer" },
  ];
  return {
    text: "Which answer is correct?",
    options,
    correctOptionId: "option-a",
    marks: 2,
    order: 1,
    ...overrides,
  };
}

before(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  await mongoose.connection.dropDatabase();
  owner = await createTeacherUser({
    name: "Quiz Owner",
    email: "quiz-owner@example.test",
    password: "quiz-owner-password-123",
  });
  otherTeacher = await createTeacherUser({
    name: "Other Teacher",
    email: "other-teacher@example.test",
    password: "other-teacher-password-123",
  });
  student = await User.create({
    name: "Quiz Student",
    email: "quiz-student@example.test",
    passwordHash: await bcrypt.hash("quiz-student-password-123", 12),
    role: "STUDENT",
  });

  lifecycleEvents = [];
  app = createApp({
    eventPublisher: {
      async publishLifecycleEvent(event) {
        lifecycleEvents.push(event);
        return { status: "accepted_by_test_publisher" };
      },
    },
  });
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
});

after(async () => {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await app.locals.sessionStore.close();
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

test("FR-T01–T05 teacher quiz CRUD, validation, ownership, and lifecycle", async (t) => {
  const ownerSession = await login("teacher", owner.email, "quiz-owner-password-123");
  const otherSession = await login("teacher", otherTeacher.email, "other-teacher-password-123");
  const studentSession = await login("student", student.email, "quiz-student-password-123");
  let quizId;
  let questionId;

  await t.test("only teachers can create valid draft quizzes", async () => {
    await studentSession.agent
      .post("/api/quizzes")
      .set("X-CSRF-Token", studentSession.csrfToken)
      .send(quizBody())
      .expect(403);
    await ownerSession.agent
      .post("/api/quizzes")
      .set("X-CSRF-Token", ownerSession.csrfToken)
      .send(quizBody({ title: "x", durationMinutes: 0 }))
      .expect(422);
    await ownerSession.agent
      .post("/api/quizzes")
      .set("X-CSRF-Token", ownerSession.csrfToken)
      .send(quizBody({ createdBy: otherTeacher._id.toString() }))
      .expect(422);

    const response = await ownerSession.agent
      .post("/api/quizzes")
      .set("X-CSRF-Token", ownerSession.csrfToken)
      .send(quizBody())
      .expect(201);
    quizId = response.body.quiz.id;
    assert.equal(response.body.quiz.status, "DRAFT");
    assert.equal(response.body.quiz.createdBy.toString(), owner._id.toString());

    const storedQuiz = await Quiz.findById(quizId);
    assert.equal(storedQuiz.durationMinutes, 30);
    assert.equal(storedQuiz.createdBy.toString(), owner._id.toString());
  });

  await t.test("Java notification outbox retries failed delivery with a stable event ID", async () => {
    const bridge = createJavaTcpBridge({
      sharedSecret: "outbox-test-shared-secret-at-least-32",
    });
    const requestIds = [];
    bridge.control = {
      async close() {},
      async request(_type, _payload, options) {
        requestIds.push(options.messageId);
        if (requestIds.length === 1) throw new Error("Java unavailable");
        return { type: "ACK" };
      },
    };

    try {
      const delivery = await bridge.publishLifecycleEvent({
        type: "QUIZ_STARTED",
        quizId,
        teacherId: owner._id.toString(),
      });
      assert.equal(delivery.status, "retry_scheduled");
      const pending = await OutboxEvent.findOne({ eventId: delivery.eventId });
      assert.equal(pending.deliveryStatus, "PENDING");
      assert.equal(pending.retryCount, 1);

      await OutboxEvent.updateOne({ _id: pending._id }, { $set: { nextAttemptAt: new Date(0) } });
      await bridge.flushOutbox();

      const delivered = await OutboxEvent.findById(pending._id);
      assert.equal(delivered.deliveryStatus, "DELIVERED");
      assert.deepEqual(requestIds, [delivery.eventId, delivery.eventId]);
    } finally {
      await bridge.close();
    }
  });

  await t.test("owner can read, edit and delete questions in a draft", async () => {
    await ownerSession.agent
      .post(`/api/quizzes/${quizId}/start`)
      .set("X-CSRF-Token", ownerSession.csrfToken)
      .expect(422);
    await ownerSession.agent
      .patch(`/api/quizzes/${quizId}`)
      .set("X-CSRF-Token", ownerSession.csrfToken)
      .send({ title: "Updated operating systems" })
      .expect(200)
      .expect((response) => assert.equal(response.body.quiz.title, "Updated operating systems"));

    await ownerSession.agent
      .post(`/api/quizzes/${quizId}/questions`)
      .set("X-CSRF-Token", ownerSession.csrfToken)
      .send(questionBody({ options: questionBody().options.slice(0, 3) }))
      .expect(422);
    await ownerSession.agent
      .post(`/api/quizzes/${quizId}/questions`)
      .set("X-CSRF-Token", ownerSession.csrfToken)
      .send(questionBody({ correctOptionId: "missing-option" }))
      .expect(422);
    await ownerSession.agent
      .post(`/api/quizzes/${quizId}/questions`)
      .set("X-CSRF-Token", ownerSession.csrfToken)
      .send(questionBody({ marks: 0 }))
      .expect(422);
    await ownerSession.agent
      .post(`/api/quizzes/${quizId}/questions`)
      .set("X-CSRF-Token", ownerSession.csrfToken)
      .send(questionBody({ order: 0 }))
      .expect(422);

    const createdQuestion = await ownerSession.agent
      .post(`/api/quizzes/${quizId}/questions`)
      .set("X-CSRF-Token", ownerSession.csrfToken)
      .send(questionBody())
      .expect(201);
    questionId = createdQuestion.body.question.id;
    assert.equal(createdQuestion.body.question.options.length, 4);
    assert.equal(createdQuestion.body.question.correctOptionId, "option-a");
    assert.equal(createdQuestion.body.question.marks, 2);
    assert.equal(createdQuestion.body.question.order, 1);
    for (const order of [2, 3]) {
      await ownerSession.agent
        .post(`/api/quizzes/${quizId}/questions`)
        .set("X-CSRF-Token", ownerSession.csrfToken)
        .send(questionBody({ order, text: `Question ${order}?` }))
        .expect(201);
    }
    await ownerSession.agent
      .post(`/api/quizzes/${quizId}/questions`)
      .set("X-CSRF-Token", ownerSession.csrfToken)
      .send(questionBody({ order: 1 }))
      .expect(409);

    const questionUpdate = questionBody({
      text: "Updated question?",
      correctOptionId: "option-b",
    });
    await ownerSession.agent
      .put(`/api/quizzes/${quizId}/questions/${questionId}`)
      .set("X-CSRF-Token", ownerSession.csrfToken)
      .send(questionUpdate)
      .expect(200)
      .expect((response) => assert.equal(response.body.question.text, "Updated question?"));

    const detail = await ownerSession.agent.get(`/api/quizzes/${quizId}`).expect(200);
    assert.equal(detail.body.questions.length, 3);
    assert.equal(detail.body.questions[0].correctOptionId, "option-b");
    assert.equal(detail.body.quiz.questionCount, 3);
  });

  await t.test("teacher ownership and student role restrictions are enforced", async () => {
    await otherSession.agent.get(`/api/quizzes/${quizId}`).expect(404);
    await otherSession.agent
      .patch(`/api/quizzes/${quizId}`)
      .set("X-CSRF-Token", otherSession.csrfToken)
      .send({ title: "Not yours" })
      .expect(404);
    await otherSession.agent
      .post(`/api/quizzes/${quizId}/questions`)
      .set("X-CSRF-Token", otherSession.csrfToken)
      .send(questionBody({ order: 2 }))
      .expect(404);
    await otherSession.agent
      .delete(`/api/quizzes/${quizId}`)
      .set("X-CSRF-Token", otherSession.csrfToken)
      .expect(404);
    await studentSession.agent.get(`/api/quizzes/${quizId}`).expect(403);
    await studentSession.agent.get("/api/teacher/dashboard").expect(403);
    const storedQuiz = await Quiz.findById(quizId);
    assert.equal(storedQuiz.createdBy.toString(), owner._id.toString());
    assert.equal(await Question.countDocuments({ quizId }), 3);
  });

  await t.test("teacher dashboard returns only owned quiz summaries", async () => {
    const dashboard = await ownerSession.agent.get("/api/teacher/dashboard").expect(200);
    assert.equal(dashboard.body.quizzes.length, 1);
    assert.equal(dashboard.body.quizzes[0].id, quizId);
    assert.equal(dashboard.body.quizzes[0].questionCount, 3);
    const otherDashboard = await otherSession.agent.get("/api/teacher/dashboard").expect(200);
    assert.equal(otherDashboard.body.quizzes.length, 0);
    await studentSession.agent.get("/api/teacher/dashboard").expect(403);
  });

  await t.test("lifecycle moves DRAFT to ACTIVE to COMPLETED and locks questions", async () => {
    const start = await ownerSession.agent
      .post(`/api/quizzes/${quizId}/start`)
      .set("X-CSRF-Token", ownerSession.csrfToken)
      .expect(200);
    assert.equal(start.body.quiz.status, "ACTIVE");
    assert.equal(start.body.eventDelivery.status, "accepted_by_test_publisher");
    assert.equal(lifecycleEvents[0].type, "QUIZ_STARTED");
    assert.ok(start.body.quiz.startedAt);
    const activeStudentList = await studentSession.agent.get("/api/quizzes").expect(200);
    assert.equal(activeStudentList.body.quizzes.length, 1);
    assert.equal(activeStudentList.body.quizzes[0].id, quizId);
    await studentSession.agent.get(`/api/quizzes/${quizId}/monitor`).expect(403);
    await otherSession.agent.get(`/api/quizzes/${quizId}/monitor`).expect(404);
    await ownerSession.agent.get(`/api/quizzes/${quizId}/monitor`).expect(200).expect((response) => {
      assert.deepEqual(response.body.counts, { joined: 0, inProgress: 0, submitted: 0 });
    });
    await ownerSession.agent.get(`/api/quizzes/${quizId}/results`).expect(409);

    await studentSession.agent
      .post(`/api/quizzes/${quizId}/join`)
      .set("X-CSRF-Token", studentSession.csrfToken)
      .send({})
      .expect(201);
    await ownerSession.agent
      .get(`/api/quizzes/${quizId}/monitor`)
      .expect(200)
      .expect((response) => {
        assert.deepEqual(response.body.counts, { joined: 1, inProgress: 1, submitted: 0 });
        assert.equal(response.body.participants[0].email, student.email);
      });

    await ownerSession.agent
      .patch(`/api/quizzes/${quizId}`)
      .set("X-CSRF-Token", ownerSession.csrfToken)
      .send({ title: "Cannot change" })
      .expect(409);
    await ownerSession.agent
      .post(`/api/quizzes/${quizId}/questions`)
      .set("X-CSRF-Token", ownerSession.csrfToken)
      .send(questionBody({ order: 2 }))
      .expect(409);
    await ownerSession.agent
      .put(`/api/quizzes/${quizId}/questions/${questionId}`)
      .set("X-CSRF-Token", ownerSession.csrfToken)
      .send(questionBody({ order: 1 }))
      .expect(409);
    await ownerSession.agent
      .delete(`/api/quizzes/${quizId}/questions/${questionId}`)
      .set("X-CSRF-Token", ownerSession.csrfToken)
      .expect(409);

    const end = await ownerSession.agent
      .post(`/api/quizzes/${quizId}/end`)
      .set("X-CSRF-Token", ownerSession.csrfToken)
      .expect(200);
    assert.equal(end.body.quiz.status, "COMPLETED");
    assert.equal(end.body.eventDelivery.status, "accepted_by_test_publisher");
    assert.equal(lifecycleEvents[1].type, "QUIZ_ENDED");
    assert.ok(end.body.quiz.endedAt);
    assert.equal(end.body.quiz.resultsReleased, true);
    await ownerSession.agent
      .get(`/api/quizzes/${quizId}/monitor`)
      .expect(200)
      .expect((response) => {
        assert.deepEqual(response.body.counts, { joined: 1, inProgress: 0, submitted: 1 });
        assert.equal(response.body.participants[0].status, "AUTO_SUBMITTED");
      });
    await ownerSession.agent
      .get(`/api/quizzes/${quizId}/results`)
      .expect(200)
      .expect((response) => {
        assert.equal(response.body.results.length, 1);
        assert.equal(response.body.results[0].studentEmail, student.email);
        assert.equal(response.body.results[0].totalMarks, 6);
      });
    await otherSession.agent.get(`/api/quizzes/${quizId}/results`).expect(404);
    await studentSession.agent.get(`/api/quizzes/${quizId}/results`).expect(403);
    assert.equal((await studentSession.agent.get("/api/quizzes").expect(200)).body.quizzes.length, 0);
    await ownerSession.agent
      .post(`/api/quizzes/${quizId}/start`)
      .set("X-CSRF-Token", ownerSession.csrfToken)
      .expect(409);
    await ownerSession.agent
      .post(`/api/quizzes/${quizId}/end`)
      .set("X-CSRF-Token", ownerSession.csrfToken)
      .expect(409);
  });

  await t.test("quiz list scopes teachers to their own quizzes and students to active quizzes", async () => {
    const teacherList = await ownerSession.agent.get("/api/quizzes").expect(200);
    assert.equal(teacherList.body.quizzes.length, 1);
    assert.equal(teacherList.body.quizzes[0].id, quizId);

    const studentList = await studentSession.agent.get("/api/quizzes").expect(200);
    assert.equal(studentList.body.quizzes.length, 0);

    const draft = await ownerSession.agent
      .post("/api/quizzes")
      .set("X-CSRF-Token", ownerSession.csrfToken)
      .send(quizBody({ title: "Draft to delete" }))
      .expect(201);
    await ownerSession.agent
      .post(`/api/quizzes/${draft.body.quiz.id}/questions`)
      .set("X-CSRF-Token", ownerSession.csrfToken)
      .send(questionBody())
      .expect(201);
    await ownerSession.agent
      .delete(`/api/quizzes/${draft.body.quiz.id}`)
      .set("X-CSRF-Token", ownerSession.csrfToken)
      .expect(204);
    assert.equal(await Quiz.findById(draft.body.quiz.id), null);
    assert.equal(await Question.countDocuments({ quizId: draft.body.quiz.id }), 0);

    const questionDraft = await ownerSession.agent
      .post("/api/quizzes")
      .set("X-CSRF-Token", ownerSession.csrfToken)
      .send(quizBody({ title: "Draft question cleanup" }))
      .expect(201);
    const removableQuestion = await ownerSession.agent
      .post(`/api/quizzes/${questionDraft.body.quiz.id}/questions`)
      .set("X-CSRF-Token", ownerSession.csrfToken)
      .send(questionBody())
      .expect(201);
    await ownerSession.agent
      .delete(`/api/quizzes/${questionDraft.body.quiz.id}/questions/${removableQuestion.body.question.id}`)
      .set("X-CSRF-Token", ownerSession.csrfToken)
      .expect(204);
    assert.equal(await Question.countDocuments({ quizId: questionDraft.body.quiz.id }), 0);
  });

  await t.test("starting a draft cannot race a question mutation into an active quiz", async () => {
    const draft = await ownerSession.agent
      .post("/api/quizzes")
      .set("X-CSRF-Token", ownerSession.csrfToken)
      .send(quizBody({ title: "Concurrent lifecycle check" }))
      .expect(201);
    await ownerSession.agent
      .post(`/api/quizzes/${draft.body.quiz.id}/questions`)
      .set("X-CSRF-Token", ownerSession.csrfToken)
      .send(questionBody())
      .expect(201);

    const [startResponse, addResponse] = await Promise.all([
      ownerSession.agent
        .post(`/api/quizzes/${draft.body.quiz.id}/start`)
        .set("X-CSRF-Token", ownerSession.csrfToken),
      ownerSession.agent
        .post(`/api/quizzes/${draft.body.quiz.id}/questions`)
        .set("X-CSRF-Token", ownerSession.csrfToken)
        .send(questionBody({ order: 2 })),
    ]);

    assert.ok([200, 409].includes(startResponse.status));
    assert.ok([201, 409].includes(addResponse.status));
    assert.notEqual(startResponse.status === 200, addResponse.status === 201);

    const finalQuiz = await Quiz.findById(draft.body.quiz.id);
    const finalQuestions = await Question.countDocuments({ quizId: draft.body.quiz.id });
    if (finalQuiz.status === "ACTIVE") {
      assert.equal(finalQuestions, 1);
    } else {
      assert.equal(finalQuiz.status, "DRAFT");
      assert.equal(finalQuestions, 2);
    }
  });
});
