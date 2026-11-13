import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import mongoose from "mongoose";
import supertest from "supertest";

process.env.MONGODB_URI = "mongodb://127.0.0.1:27017/examflow_auth_test";
process.env.SESSION_SECRET = "test-only-session-secret-that-is-long-enough";
process.env.CLIENT_ORIGIN = "http://localhost:5173";
process.env.NODE_ENV = "test";

const { createApp } = await import("../app.js");
const { User } = await import("../models/User.js");
const { createTeacherUser } = await import("./seed-teacher.js");

let server;
let app;
let student;
let teacher;

async function getCsrf(agent) {
  const response = await agent.get("/api/auth/csrf").expect(200);
  return response.body.csrfToken;
}

before(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  await mongoose.connection.dropDatabase();
  app = createApp();
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

test("FR-A01–A06 student and teacher authentication is role-isolated", async (t) => {
  await t.test("unauthenticated requests are denied and CSRF is required", async () => {
    const agent = supertest.agent(server);
    await agent.get("/api/auth/me").expect(401);
    await agent.get("/api/teacher/dashboard").expect(401);
    await agent.post("/api/auth/student/register").send({}).expect(403);
    await agent.post("/api/auth/teacher/register").send({}).expect(404);
  });

  await t.test("registration always creates a student, stores a hash, and validates input", async () => {
    const agent = supertest.agent(server);
    const csrfToken = await getCsrf(agent);
    await agent
      .post("/api/auth/student/register")
      .set("X-CSRF-Token", csrfToken)
      .set("Origin", "https://untrusted.example")
      .send({ name: "Blocked User", email: "blocked@example.test", password: "student-password-123" })
      .expect(403);
    await agent
      .post("/api/auth/student/register")
      .set("X-CSRF-Token", csrfToken)
      .set("Host", "127.0.0.1:4000")
      .set("X-Forwarded-Host", "192.168.1.20:5173")
      .set("Origin", "http://192.168.1.20:5173")
      .send({})
      .expect(422);
    const response = await agent
      .post("/api/auth/student/register")
      .set("X-CSRF-Token", csrfToken)
      .send({
        name: "Student One",
        email: "  STUDENT@example.test ",
        password: "student-password-123",
        role: "TEACHER",
      })
      .expect(201);

    assert.equal(response.body.user.role, "STUDENT");
    assert.equal(response.body.user.email, "student@example.test");
    student = await User.findOne({ email: "student@example.test" }).select("+passwordHash");
    assert.equal(student.role, "STUDENT");
    assert.notEqual(student.passwordHash, "student-password-123");
    assert.equal(await (await import("bcryptjs")).default.compare("student-password-123", student.passwordHash), true);

    await agent
      .post("/api/auth/student/register")
      .set("X-CSRF-Token", csrfToken)
      .send({ name: "Student One", email: "student@example.test", password: "student-password-123" })
      .expect(409);
    await agent
      .post("/api/auth/student/register")
      .set("X-CSRF-Token", csrfToken)
      .send({ name: "X", email: "not-an-email", password: "short" })
      .expect(422);
  });

  await t.test("student login persists session and denies teacher access", async () => {
    const agent = supertest.agent(server);
    let csrfToken = await getCsrf(agent);
    await agent
      .post("/api/auth/teacher/login")
      .set("X-CSRF-Token", csrfToken)
      .send({ email: "student@example.test", password: "student-password-123" })
      .expect(401)
      .expect((response) =>
        assert.equal(response.body.error.message, "Invalid email or password."),
      );
    await agent
      .post("/api/auth/teacher/login")
      .set("X-CSRF-Token", csrfToken)
      .send({ email: "missing@example.test", password: "valid-looking-password" })
      .expect(401)
      .expect((response) =>
        assert.equal(response.body.error.message, "Invalid email or password."),
      );
    await agent
      .post("/api/auth/student/login")
      .set("X-CSRF-Token", csrfToken)
      .send({ email: "student@example.test", password: "wrong-password-123" })
      .expect(401);

    const login = await agent
      .post("/api/auth/student/login")
      .set("X-CSRF-Token", csrfToken)
      .send({ email: "student@example.test", password: "student-password-123" })
      .expect(200);
    assert.equal(login.body.user.role, "STUDENT");
    assert.match(login.headers["set-cookie"].join(";"), /HttpOnly/i);
    assert.match(login.headers["set-cookie"].join(";"), /SameSite=Lax/i);
    csrfToken = login.body.csrfToken;

    const sessionCookie = login.headers["set-cookie"]
      .find((cookie) => cookie.startsWith("examflow.sid="))
      .split(";")[0];
    await supertest(server)
      .get("/api/auth/me")
      .set("Cookie", sessionCookie)
      .expect(200)
      .expect((response) => assert.equal(response.body.user.role, "STUDENT"));
    await agent.get("/api/auth/me").expect(200).expect((response) => {
      assert.equal(response.body.user.id, student._id.toString());
    });
    await agent.get("/api/student/dashboard").expect(200);
    await agent.get("/api/teacher/dashboard").expect(403);
    await agent.get("/api/teacher/secret-resource").expect(403);
    await agent.post("/api/auth/logout").set("X-CSRF-Token", csrfToken).expect(204);
    await agent.get("/api/auth/me").expect(401);
  });

  await t.test("only the seed path provisions teachers and teacher routes are isolated", async () => {
    teacher = await createTeacherUser({
      name: "Teacher One",
      email: "teacher@example.test",
      password: "teacher-password-123",
    });
    assert.equal(teacher.role, "TEACHER");

    const studentAgent = supertest.agent(server);
    let studentCsrf = await getCsrf(studentAgent);
    await studentAgent
      .post("/api/auth/student/login")
      .set("X-CSRF-Token", studentCsrf)
      .send({ email: "student@example.test", password: "student-password-123" })
      .expect(200);
    studentCsrf = (await studentAgent.get("/api/auth/csrf").expect(200)).body.csrfToken;
    await studentAgent
      .post("/api/auth/logout")
      .set("X-CSRF-Token", studentCsrf)
      .expect(204);

    const agent = supertest.agent(server);
    const csrfToken = await getCsrf(agent);
    await agent
      .post("/api/auth/student/login")
      .set("X-CSRF-Token", csrfToken)
      .send({ email: "teacher@example.test", password: "teacher-password-123" })
      .expect(401);

    const login = await agent
      .post("/api/auth/teacher/login")
      .set("X-CSRF-Token", csrfToken)
      .send({ email: "teacher@example.test", password: "teacher-password-123" })
      .expect(200);
    assert.equal(login.body.user.role, "TEACHER");
    await agent.get("/api/teacher/dashboard").expect(200);
    await agent.get("/api/student/dashboard").expect(403);
    await mongoose.connection.collection("sessions").updateMany({}, {
      $set: { expires: new Date(Date.now() - 1000) },
    });
    const expired = await agent.get("/api/teacher/dashboard").expect(401);
    assert.equal(expired.body.requestId, expired.headers["x-request-id"]);
  });
});
