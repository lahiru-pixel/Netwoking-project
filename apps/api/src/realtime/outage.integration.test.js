import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import mongoose from 'mongoose';
import supertest from 'supertest';
import { createApp } from '../app.js';
import { createTeacherUser } from '../auth/seed-teacher.js';
import { OutboxEvent } from '../models/OutboxEvent.js';
import { Quiz } from '../models/Quiz.js';
import { createJavaTcpBridge } from './java-bridge.js';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const java = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : 'java';
const jars = ['jackson-databind', 'jackson-core', 'jackson-annotations'].map((name) =>
  join(homedir(), '.m2/repository/com/fasterxml/jackson/core', name, '2.18.2', `${name}-2.18.2.jar`));
const classpath = process.env.JAVA_TEST_CLASSPATH ?? [join(root, 'services/java-socket-server/target/classes'), ...jars].join(delimiter);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('AT-11 real Java process outage persists pending event and recovers after restart', { timeout: 45000 }, async () => {
  process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/examflow_outage_test';
  process.env.SESSION_SECRET = randomBytes(48).toString('hex');
  process.env.NODE_ENV = 'test';
  const secret = randomBytes(48).toString('hex');
  const reservation = net.createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  let child, bridge, app, server;
  let javaLog = '';
  async function startJava() {
    child = spawn(java, ['-cp', classpath, 'lk.examflow.socket.SocketServer'], {
      env: { ...process.env, JAVA_TCP_HOST: '127.0.0.1', JAVA_TCP_PORT: String(port), JAVA_TCP_SHARED_SECRET: secret },
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Java startup timeout: ${javaLog}`)), 10000);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Java exited ${code}: ${javaLog}`)); });
      child.stdout.on('data', (data) => {
        javaLog += data.toString();
        if (data.toString().includes('listening on')) { clearTimeout(timer); resolve(); }
      });
      child.stderr.on('data', (data) => { javaLog += data.toString(); });
    });
  }
  async function stopJava() {
    if (!child || child.exitCode !== null) return;
    const exited = once(child, 'exit');
    child.kill();
    await exited;
  }
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    await mongoose.connection.dropDatabase();
    await startJava();
    bridge = createJavaTcpBridge({ port, sharedSecret: secret });
    await bridge.start();
    await bridge.control.waitUntilReady();
    app = createApp({ eventPublisher: bridge, realtimeBridge: bridge });
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const password = randomBytes(20).toString('hex');
    await createTeacherUser({ name: 'Outage Teacher', email: 'outage@example.test', password });
    const agent = supertest.agent(server);
    let token = (await agent.get('/api/auth/csrf')).body.csrfToken;
    token = (await agent.post('/api/auth/teacher/login').set('X-CSRF-Token', token).send({ email: 'outage@example.test', password }).expect(200)).body.csrfToken;
    const quizId = (await agent.post('/api/quizzes').set('X-CSRF-Token', token).send({ title: 'Outage recovery exam', durationMinutes: 1 }).expect(201)).body.quiz.id;
    await agent.post(`/api/quizzes/${quizId}/questions`).set('X-CSRF-Token', token).send({
      text: 'Choose the correct answer', options: ['a', 'b', 'c', 'd'].map((id) => ({ id, text: id })), correctOptionId: 'a', marks: 1,
    }).expect(201);
    await stopJava();
    const response = await agent.post(`/api/quizzes/${quizId}/start`).set('X-CSRF-Token', token).send({}).expect(200);
    assert.equal(response.body.eventDelivery.status, 'retry_scheduled');
    assert.equal((await Quiz.findById(quizId)).status, 'ACTIVE');
    const pending = await OutboxEvent.findOne({ quizId });
    assert.equal(pending.deliveryStatus, 'PENDING');
    assert.ok(pending.retryCount >= 1);
    await agent.get('/api/health').expect(200);
    await startJava();
    const deadline = Date.now() + 20000;
    let delivered;
    do {
      delivered = await OutboxEvent.findById(pending._id);
      if (delivered.deliveryStatus === 'DELIVERED') break;
      await delay(250);
    } while (Date.now() < deadline);
    assert.equal(delivered.deliveryStatus, 'DELIVERED');
    assert.equal(delivered.eventId, pending.eventId);
    assert.match(javaLog, /Broadcasting Java TCP event QUIZ_STARTED/);
    console.info('AT-11: Java stopped; REST persisted ACTIVE + PENDING, health stayed 200; restarted Java ACKed the same eventId and outbox became DELIVERED.');
  } finally {
    await bridge?.close();
    if (server) await new Promise((resolve) => server.close(resolve));
    await app?.locals.sessionStore.close();
    await stopJava();
    if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});
