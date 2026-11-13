import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import mongoose from "mongoose";
import supertest from "supertest";

process.env.MONGODB_URI = "mongodb://127.0.0.1:27017/examflow_attempts_test";
process.env.SESSION_SECRET = "attempt-test-session-secret-that-is-long-enough";
process.env.CLIENT_ORIGIN = "http://localhost:5173";
process.env.NODE_ENV = "test";

const { createApp } = await import("../app.js");
const { User } = await import("../models/User.js");
const { Quiz } = await import("../models/Quiz.js");
const { Question } = await import("../models/Question.js");
const { Attempt } = await import("../models/Attempt.js");
const { createTeacherUser } = await import("../auth/seed-teacher.js");
const { startAttemptExpiryWorker } = await import("./expiry-worker.js");
const bcrypt = (await import("bcryptjs")).default;

let app;
let server;
let teacher;
let student;
let secondStudent;
let teacherSession;
let studentSession;
let secondStudentSession;

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

async function createActiveQuiz(title) {
  const quizResponse = await teacherSession.agent
    .post("/api/quizzes")
    .set("X-CSRF-Token", teacherSession.csrfToken)
    .send({ title, durationMinutes: 10 })
    .expect(201);
  const quizId = quizResponse.body.quiz.id;
  const questionResponse = await teacherSession.agent
    .post(`/api/quizzes/${quizId}/questions`)
    .set("X-CSRF-Token", teacherSession.csrfToken)
    .send({
      text: "Which option is correct?",
      options: [
        { id: "option-a", text: "Correct answer" },
        { id: "option-b", text: "Wrong answer one" },
        { id: "option-c", text: "Wrong answer two" },
        { id: "option-d", text: "Wrong answer three" },
      ],
      correctOptionId: "option-a",
      marks: 2,
      order: 1,
    })
    .expect(201);
  await teacherSession.agent
    .post(`/api/quizzes/${quizId}/start`)
    .set("X-CSRF-Token", teacherSession.csrfToken)
    .send({})
    .expect(200);
  return { quizId, questionId: questionResponse.body.question.id };
}

before(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  await mongoose.connection.dropDatabase();
  teacher = await createTeacherUser({
    name: "Exam Teacher",
    email: "exam-teacher@example.test",
    password: "exam-teacher-password-123",
  });
  student = await User.create({
    name: "Exam Student",
    email: "exam-student@example.test",
    passwordHash: await bcrypt.hash("exam-student-password-123", 12),
    role: "STUDENT",
  });
  secondStudent = await User.create({
    name: "Another Student",
    email: "another-student@example.test",
    passwordHash: await bcrypt.hash("another-student-password-123", 12),
    role: "STUDENT",
  });
  app = createApp();
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  teacherSession = await login("teacher", teacher.email, "exam-teacher-password-123");
  studentSession = await login("student", student.email, "exam-student-password-123");
  secondStudentSession = await login("student", secondStudent.email, "another-student-password-123");
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  await app.locals.sessionStore.close();
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

test("FR-S01–S08 student attempt and results lifecycle", async (t) => {
  const { quizId, questionId } = await createActiveQuiz("Student Systems Exam");

  await t.test("students see active exams without answer keys and roles are enforced", async () => {
    const listing = await studentSession.agent.get("/api/quizzes").expect(200);
    assert.equal(listing.body.quizzes.some((quiz) => quiz.id === quizId), true);
    const details = await studentSession.agent.get(`/api/quizzes/${quizId}`).expect(200);
    assert.equal(JSON.stringify(details.body).includes("correctOptionId"), false);
    assert.equal(details.body.questions.length, 1);
    await studentSession.agent.get("/api/teacher/dashboard").expect(403);
    await teacherSession.agent.get("/api/attempts/not-an-id").expect(403);
  });

  let firstAttemptId;
  let secondAttemptId;
  await t.test("join-once, autosave, official scoring, duplicate submit, and result release", async () => {
    const join = await studentSession.agent
      .post(`/api/quizzes/${quizId}/join`)
      .set("X-CSRF-Token", studentSession.csrfToken)
      .send({})
      .expect(201);
    firstAttemptId = join.body.attempt.id;
    const duplicateJoin = await studentSession.agent
      .post(`/api/quizzes/${quizId}/join`)
      .set("X-CSRF-Token", studentSession.csrfToken)
      .send({})
      .expect(200);
    assert.equal(duplicateJoin.body.attempt.id, firstAttemptId);
    assert.equal(duplicateJoin.body.alreadyJoined, true);

    const attempt = await studentSession.agent.get(`/api/attempts/${firstAttemptId}`).expect(200);
    assert.equal(JSON.stringify(attempt.body).includes("correctOptionId"), false);
    await studentSession.agent
      .put(`/api/attempts/${firstAttemptId}/answers/${questionId}`)
      .set("X-CSRF-Token", studentSession.csrfToken)
      .send({ optionId: "option-a" })
      .expect(200);
    assert.deepEqual((await studentSession.agent.get("/api/results/my").expect(200)).body.results, []);

    const submitted = await studentSession.agent
      .post(`/api/attempts/${firstAttemptId}/submit`)
      .set("X-CSRF-Token", studentSession.csrfToken)
      .send({})
      .expect(200);
    assert.equal(submitted.body.attempt.status, "SUBMITTED");
    const duplicateSubmit = await studentSession.agent
      .post(`/api/attempts/${firstAttemptId}/submit`)
      .set("X-CSRF-Token", studentSession.csrfToken)
      .send({})
      .expect(200);
    assert.equal(duplicateSubmit.body.alreadySubmitted, true);
    await studentSession.agent.get(`/api/results/my/${firstAttemptId}`).expect(403);
    const unreleasedDashboard = await studentSession.agent.get("/api/student/dashboard").expect(200);
    assert.equal(unreleasedDashboard.body.submittedAttempts.length, 0, "dashboard must withhold unreleased scores");
    await secondStudentSession.agent.get(`/api/attempts/${firstAttemptId}`).expect(404);

    const secondJoin = await secondStudentSession.agent
      .post(`/api/quizzes/${quizId}/join`)
      .set("X-CSRF-Token", secondStudentSession.csrfToken)
      .send({})
      .expect(201);
    secondAttemptId = secondJoin.body.attempt.id;
    await teacherSession.agent
      .post(`/api/quizzes/${quizId}/end`)
      .set("X-CSRF-Token", teacherSession.csrfToken)
      .send({})
      .expect(200);

    const endedAttempt = await Attempt.findById(secondAttemptId).lean();
    assert.equal(endedAttempt.status, "AUTO_SUBMITTED");
    assert.equal(endedAttempt.submissionReason, "QUIZ_ENDED");

    const results = await studentSession.agent.get("/api/results/my").expect(200);
    assert.equal(results.body.results.length, 1);
    assert.equal(results.body.results[0].score, 2);
    const releasedDashboard = await studentSession.agent.get("/api/student/dashboard").expect(200);
    assert.equal(releasedDashboard.body.submittedAttempts[0].score, 2);
    const detail = await studentSession.agent.get(`/api/results/my/${firstAttemptId}`).expect(200);
    assert.equal(detail.body.questions[0].correctOptionId, "option-a");
    await secondStudentSession.agent.get(`/api/results/my/${firstAttemptId}`).expect(404);
    await studentSession.agent
      .put(`/api/attempts/${firstAttemptId}/answers/${questionId}`)
      .set("X-CSRF-Token", studentSession.csrfToken)
      .send({ optionId: "option-b" })
      .expect(409);
  });

  await t.test("server expiry worker submits due attempts and rejects late answers", async () => {
    const { quizId: expiryQuizId, questionId: expiryQuestionId } = await createActiveQuiz("Expiry Worker Exam");
    const joined = await studentSession.agent
      .post(`/api/quizzes/${expiryQuizId}/join`)
      .set("X-CSRF-Token", studentSession.csrfToken)
      .send({})
      .expect(201);
    await Attempt.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(joined.body.attempt.id) },
      { $set: { expiresAt: new Date(Date.now() - 1_000) } },
    );
    const worker = startAttemptExpiryWorker({ intervalMs: 60_000 });
    await worker.tick();
    await worker.stop();
    const attempt = await Attempt.findById(joined.body.attempt.id).lean();
    assert.equal(attempt.status, "AUTO_SUBMITTED");
    assert.equal(attempt.submissionReason, "TIME_EXPIRED");

    await studentSession.agent
      .put(`/api/attempts/${joined.body.attempt.id}/answers/${expiryQuestionId}`)
      .set("X-CSRF-Token", studentSession.csrfToken)
      .send({ optionId: "option-a" })
      .expect(409);
  });
});
