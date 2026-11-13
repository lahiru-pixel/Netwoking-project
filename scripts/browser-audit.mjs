import { chromium, expect } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import mongoose from 'mongoose';
import '../apps/api/src/config.js';
import { Attempt } from '../apps/api/src/models/Attempt.js';

// Run against the built preview (npm run start:web) and real local API/Java/MongoDB.
// Unique accounts and exams are retained for the operator's final demonstration.
const base = process.env.AUDIT_BASE_URL ?? 'http://localhost:5173';
const run = Date.now().toString(36);
const password = randomBytes(20).toString('hex');
const accounts = ['teacher', 'student-one', 'student-two'].map((role) => ({
  name: `Audit ${role} ${run}`, email: `${role}-${run}@example.test`, password,
}));
await mkdir('.audit', { recursive: true });
await mkdir('docs/evidence', { recursive: true });
await writeFile('.audit/demo-accounts.json', JSON.stringify(accounts, null, 2));
const seed = spawnSync(process.execPath, ['apps/api/scripts/seed-teacher.js'], {
  env: { ...process.env, TEACHER_NAME: accounts[0].name, TEACHER_EMAIL: accounts[0].email, TEACHER_PASSWORD: password },
  encoding: 'utf8',
});
if (seed.status !== 0) throw new Error(`Teacher seed failed: ${seed.stderr}`);
await mongoose.connect(process.env.MONGODB_URI);
const browser = await chromium.launch({ channel: process.env.AUDIT_BROWSER ?? 'chrome', headless: true });
const contexts = await Promise.all([
  browser.newContext({ viewport: { width: 1366, height: 900 } }),
  browser.newContext({ viewport: { width: 360, height: 800 }, hasTouch: true, isMobile: true }),
  browser.newContext({ viewport: { width: 1440, height: 900 } }),
]);
const pages = await Promise.all(contexts.map((context) => context.newPage()));
const [teacher, one, two] = pages;
const results = [];
const sockets = [];
const pageErrors = [];
for (const page of pages) {
  await page.route('**/*', (route) => {
    const host = new URL(route.request().url()).hostname;
    return ['localhost', '127.0.0.1'].includes(host) ? route.continue() : route.abort();
  });
  page.on('websocket', (socket) => sockets.push(socket.url()));
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('dialog', (dialog) => dialog.accept());
  await page.addInitScript(() => {
    window.auditEvents = [];
    window.addEventListener('examflow:refresh', (event) => window.auditEvents.push(event.detail));
  });
}
async function step(name, action) {
  const start = Date.now();
  try {
    const detail = await action();
    results.push({ name, status: 'PASS', ms: Date.now() - start, detail });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.push({ name, status: 'FAIL', error: error.message });
    console.error(`FAIL ${name}: ${error.message}`);
    throw error;
  }
}
async function api(page, path, method = 'GET', data) {
  const csrf = method === 'GET' ? null : await (await page.request.get(`${base}/api/auth/csrf`)).json();
  const response = await page.request.fetch(`${base}${path}`, {
    method, data, headers: csrf ? { 'X-CSRF-Token': csrf.csrfToken } : {},
  });
  return { status: response.status(), body: await response.json() };
}
async function login(page, role, account) {
  await page.goto(`${base}/${role}/login`);
  await page.getByLabel('Email address').fill(account.email);
  await page.getByLabel('Password', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/${role}/dashboard$`));
}
async function noOverflow(page) {
  const size = await page.evaluate(() => ({ viewport: innerWidth, content: document.documentElement.scrollWidth }));
  expect(size.content).toBeLessThanOrEqual(size.viewport);
  return size;
}
let quizId;
let attemptIds;
try {
  await step('AT-01 distinct portals at 360/390/768/1366/1440 px', async () => {
    const measured = [];
    for (const role of ['student', 'teacher']) {
      await teacher.goto(`${base}/${role}/login`);
      await expect(teacher.getByText(`Sign in to your ${role} workspace.`)).toBeVisible();
      for (const width of [360, 390, 768, 1366, 1440]) {
        await teacher.setViewportSize({ width, height: 900 });
        measured.push({ role, ...await noOverflow(teacher) });
      }
    }
    return measured;
  });
  await step('AT-03 UI registration and independent student sessions', async () => {
    for (const [index, page] of [one, two].entries()) {
      const account = accounts[index + 1];
      await page.goto(`${base}/student/register`);
      await page.getByLabel('Full name').fill(account.name);
      await page.getByLabel('Email address').fill(account.email);
      await page.getByLabel('Password', { exact: true }).fill(password);
      await page.getByRole('button', { name: 'Create student account' }).click();
      await expect(page).toHaveURL(/\/student\/login$/);
      await login(page, 'student', account);
    }
    await login(teacher, 'teacher', accounts[0]);
    const users = await Promise.all(pages.map((page) => api(page, '/api/auth/me')));
    expect(new Set(users.map((user) => user.body.user.id)).size).toBe(3);
  });
  await step('Protected routes redirect cross-role browser navigation', async () => {
    await one.goto(`${base}/teacher/dashboard`);
    await expect(one).toHaveURL(/\/student\/dashboard$/);
    await teacher.goto(`${base}/student/dashboard`);
    await expect(teacher).toHaveURL(/\/teacher\/dashboard$/);
  });
  await step('AT-04 teacher creates and previews three MCQs in UI', async () => {
    await teacher.goto(`${base}/teacher/quizzes/new`);
    await expect(teacher.getByLabel('Quiz title')).toBeVisible();
    for (const width of [360, 390, 768, 1366, 1440]) {
      await teacher.setViewportSize({ width, height: 900 });
      await noOverflow(teacher);
    }
    await teacher.getByLabel('Quiz title').fill(`Final integration ${run}`);
    await teacher.getByLabel('Description').fill('One teacher, two independent students, real Java TCP and SSE.');
    await teacher.getByLabel('Student instructions').fill('Choose one answer for each question.');
    await teacher.getByLabel('Duration').fill('10');
    await teacher.getByRole('button', { name: 'Create draft' }).click();
    await expect(teacher).toHaveURL(/\/teacher\/quizzes\/[^/]+\/edit$/);
    quizId = teacher.url().split('/').at(-2);
    for (let i = 1; i <= 3; i++) {
      await teacher.getByRole('button', { name: 'Add question', exact: true }).click();
      await teacher.getByLabel('Question', { exact: true }).fill(`Question ${i}: select the correct TCP answer`);
      for (const letter of ['A', 'B', 'C', 'D']) await teacher.getByLabel(`Option ${letter}`, { exact: true }).fill(`${letter === 'A' ? 'Correct' : 'Incorrect'} answer ${letter}`);
      await teacher.getByRole('radio', { name: 'Mark option A correct' }).check();
      await teacher.getByLabel('Marks', { exact: true }).fill('2');
      await teacher.locator('form').filter({ has: teacher.getByLabel('Question', { exact: true }) }).getByRole('button', { name: 'Add question', exact: true }).click();
      await expect(teacher.getByLabel('Question', { exact: true })).toHaveCount(0);
    }
    await noOverflow(teacher);
    await teacher.goto(`${base}/teacher/quizzes/${quizId}/preview`);
    await expect(teacher.getByText('Question 3: select the correct TCP answer')).toBeVisible();
  });
  await step('AT-05 both logged-in students receive Java-origin quiz start', async () => {
    await Promise.all([one, two].map((page) => expect.poll(() => page.evaluate(() => window.auditEvents.some((e) => e.source === 'rest'))).toBe(true)));
    await teacher.getByRole('button', { name: 'Start quiz', exact: true }).first().click();
    for (const page of [one, two]) await expect.poll(() => page.evaluate((id) => window.auditEvents.some((e) => e.source === 'java_tcp' && e.type === 'QUIZ_STARTED' && e.payload.quizId === id), quizId)).toBe(true);
  });
  await step('AT-06 two joins, save/replace/reload answers, server deadlines', async () => {
    for (const page of [one, two]) {
      await page.goto(`${base}/student/quizzes/${quizId}`);
      await page.getByRole('button', { name: 'Join exam', exact: true }).click();
      await expect(page).toHaveURL(/\/student\/attempts\//);
      await expect(page.getByRole('timer')).toBeVisible();
    }
    attemptIds = [one, two].map((page) => page.url().split('/').at(-1));
    await one.getByRole('button', { name: 'B Incorrect answer B' }).tap();
    await expect(one.getByText('Answer saved', { exact: true })).toBeVisible();
    await one.getByRole('button', { name: 'A Correct answer A' }).tap();
    await expect(one.getByText('Answer saved', { exact: true })).toBeVisible();
    await one.reload();
    await expect(one.getByRole('button', { name: 'A Correct answer A' })).toHaveAttribute('aria-pressed', 'true');
    const attempt = await api(one, `/api/attempts/${attemptIds[0]}`);
    expect(JSON.stringify(attempt.body)).not.toContain('correctOptionId');
    expect(Date.parse(attempt.body.attempt.expiresAt) - Date.parse(attempt.body.attempt.startedAt)).toBe(600000);
    await teacher.goto(`${base}/teacher/quizzes/${quizId}/monitor`);
    await expect(teacher.getByText(accounts[1].name, { exact: true })).toBeVisible();
    await expect(teacher.getByText(accounts[2].name, { exact: true })).toBeVisible();
  });
  await step('AT-13 360 px touch navigation and answer save failure/retry', async () => {
    const size = await noOverflow(one);
    const box = await one.getByRole('button', { name: 'A Correct answer A' }).boundingBox();
    expect(box.height).toBeGreaterThanOrEqual(44);
    await one.getByRole('button', { name: 'Next question' }).tap();
    await expect(one.getByText('Question 2 of 3')).toBeVisible();
    await one.route('**/api/attempts/*/answers/*', (route) => route.abort());
    await one.getByRole('button', { name: 'A Correct answer A' }).tap();
    await expect(one.getByRole('alert').first()).toBeVisible();
    await expect(one.getByText('Answer saved', { exact: true })).toHaveCount(0);
    await one.unroute('**/api/attempts/*/answers/*');
    await one.getByRole('button', { name: 'A Correct answer A' }).tap();
    await expect(one.getByText('Answer saved', { exact: true })).toBeVisible();
    await one.getByRole('button', { name: 'Previous', exact: true }).tap();
    await expect(one.getByRole('button', { name: 'A Correct answer A' })).toHaveAttribute('aria-pressed', 'true');
    await one.screenshot({ path: 'docs/evidence/student-360.png', fullPage: true });
    return { ...size, touchTargetHeight: box.height, touchEmulation: true, physicalDevice: false };
  });
  await step('AT-07 manual submission, official score and stable duplicate', async () => {
    await contexts[0].setOffline(true);
    await one.getByRole('button', { name: 'Next question' }).tap();
    await one.getByRole('button', { name: 'Next question' }).tap();
    await one.getByRole('button', { name: 'A Correct answer A' }).tap();
    await expect(one.getByText('Answer saved', { exact: true })).toBeVisible();
    await one.getByRole('button', { name: 'Submit exam' }).tap();
    await expect(one.getByRole('heading', { name: 'Exam submitted' })).toBeVisible();
    const before = await Attempt.findById(attemptIds[0]).lean();
    expect(before.score).toBe(6);
    const repeat = await api(one, `/api/attempts/${attemptIds[0]}/submit`, 'POST', {});
    expect(repeat.body.alreadySubmitted).toBe(true);
    expect((await Attempt.findById(attemptIds[0]).lean()).submittedAt).toEqual(before.submittedAt);
    expect((await api(one, '/api/student/dashboard')).body.submittedAttempts).toHaveLength(0);
    const monitorRefresh = teacher.waitForResponse((response) => response.url().endsWith(`/api/quizzes/${quizId}/monitor`) && response.status() === 200);
    await contexts[0].setOffline(false);
    expect((await (await monitorRefresh).json()).counts.submitted).toBe(1);
  });
  await step('AT-10 native EventSource reconnect refreshes canonical attempt after teacher end', async () => {
    await contexts[2].setOffline(true);
    await teacher.goto(`${base}/teacher/quizzes/${quizId}/preview`);
    await teacher.getByRole('button', { name: 'End quiz', exact: true }).first().click();
    await expect.poll(async () => (await Attempt.findById(attemptIds[1]).lean()).status).toBe('AUTO_SUBMITTED');
    await contexts[2].setOffline(false);
    await expect(two.getByRole('heading', { name: 'Exam submitted' })).toBeVisible({ timeout: 20000 });
    expect((await api(one, `/api/results/my/${attemptIds[0]}`)).body.result.score).toBe(6);
  });
  await step('AT-09 live teacher end finalizes and updates both browsers through SSE', async () => {
    const made = await api(teacher, '/api/quizzes', 'POST', { title: `Live end ${run}`, durationMinutes: 1 });
    const id = made.body.quiz.id;
    await api(teacher, `/api/quizzes/${id}/questions`, 'POST', { text: 'TCP transport?', options: ['a','b','c','d'].map((id) => ({ id, text: id })), correctOptionId: 'a', marks: 1, order: 1 });
    await api(teacher, `/api/quizzes/${id}/start`, 'POST', {});
    for (const page of [one, two]) {
      const join = await api(page, `/api/quizzes/${id}/join`, 'POST', {});
      await page.goto(`${base}/student/attempts/${join.body.attempt.id}`);
      await expect(page.getByRole('timer')).toBeVisible();
    }
    await api(teacher, `/api/quizzes/${id}/end`, 'POST', {});
    for (const page of [one, two]) await expect(page.getByRole('heading', { name: 'Exam submitted' })).toBeVisible();
  });
  await step('AT-08 real one-minute expiry worker with no browser submission', async () => {
    const made = await api(teacher, '/api/quizzes', 'POST', { title: `Expiry ${run}`, durationMinutes: 1 });
    const id = made.body.quiz.id;
    await api(teacher, `/api/quizzes/${id}/questions`, 'POST', { text: 'TCP transport?', options: ['a','b','c','d'].map((id) => ({ id, text: id })), correctOptionId: 'a', marks: 1, order: 1 });
    await api(teacher, `/api/quizzes/${id}/start`, 'POST', {});
    const joined = await api(two, `/api/quizzes/${id}/join`, 'POST', {});
    const attemptId = joined.body.attempt.id;
    // Never load this attempt in React: only the server worker can finalize it.
    console.log('Waiting for the real 60-second server deadline (no client submit)...');
    await expect.poll(async () => (await Attempt.findById(attemptId).lean()).status, { timeout: 75000, intervals: [1000] }).toBe('AUTO_SUBMITTED');
    expect((await Attempt.findById(attemptId).lean()).submissionReason).toBe('TIME_EXPIRED');
    const details = await api(two, `/api/attempts/${attemptId}`);
    expect((await api(two, `/api/attempts/${attemptId}/answers/${details.body.questions[0].id}`, 'PUT', { optionId: 'a' })).status).toBe(409);
    await api(teacher, `/api/quizzes/${id}/end`, 'POST', {});
  });
  await step('AT-12 result privacy and teacher results review', async () => {
    expect((await api(two, `/api/results/my/${attemptIds[0]}`)).status).toBe(404);
    expect((await api(one, `/api/quizzes/${quizId}/results`)).status).toBe(403);
    await teacher.goto(`${base}/teacher/quizzes/${quizId}/results`);
    await expect(teacher.getByText(accounts[1].name, { exact: true })).toBeVisible();
    await teacher.screenshot({ path: 'docs/evidence/teacher-results.png', fullPage: true });
    await one.goto(`${base}/student/results/${attemptIds[0]}`);
    await expect(one.getByText('Your score', { exact: true })).toBeVisible();
    await expect(one.getByText('6 / 6', { exact: true })).toBeVisible();
    await noOverflow(one);
    await one.screenshot({ path: 'docs/evidence/student-result.png', fullPage: true });
  });
  await step('AT-14 built browser flow opens zero WebSocket connections', async () => {
    expect(sockets).toEqual([]);
    expect(pageErrors).toEqual([]);
    return { webSockets: sockets, uncaughtPageErrors: pageErrors };
  });
} catch (error) {
  process.exitCode = 1;
  for (const [index, page] of pages.entries()) await page.screenshot({ path: `.audit/failure-${index}.png`, fullPage: true }).catch(() => {});
} finally {
  await writeFile('docs/evidence/browser-audit.json', JSON.stringify({ date: new Date().toISOString(), browser: browser.version(), base, quizId, attemptIds, results }, null, 2));
  await browser.close();
  await mongoose.disconnect();
}
