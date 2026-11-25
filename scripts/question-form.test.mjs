import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium, expect } from '@playwright/test';
import { questionSchema } from '../apps/api/src/quizzes/validation.js';

const base = process.env.AUDIT_BASE_URL ?? 'http://localhost:5173';

for (const withoutRandomUUID of [false, true]) {
  test(`question form can add and edit with randomUUID ${withoutRandomUUID ? 'unavailable' : 'available'}`, async () => {
    const browser = await chromium.launch({ channel: process.env.AUDIT_BROWSER ?? 'chrome', headless: true });
    try {
      const page = await browser.newPage();
      const errors = [];
      const saved = [];
      const quiz = {
        id: 'question-form-test', title: 'Question form regression', status: 'DRAFT',
        description: '', instructions: '', durationMinutes: 10,
      };
      page.on('pageerror', (error) => errors.push(error.message));
      if (withoutRandomUUID) {
        await page.addInitScript(() => {
          Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true });
        });
      }
      // Isolate this browser regression from real accounts, quizzes and services.
      await page.route('**/api/**', async (route) => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        let body;
        if (path === '/api/auth/csrf') body = { csrfToken: 'test-token' };
        else if (path === '/api/auth/me') body = { user: { id: 'teacher-test', name: 'Test teacher', role: 'TEACHER' } };
        else if (path === '/api/realtime/events') {
          return route.fulfill({ contentType: 'text/event-stream', body: ': connected\n\n' });
        } else if (path === `/api/quizzes/${quiz.id}`) body = { quiz, questions: [] };
        else if (path.startsWith(`/api/quizzes/${quiz.id}/questions`)) {
          const payload = request.postDataJSON();
          const validation = questionSchema.safeParse(payload);
          if (!validation.success) {
            return route.fulfill({ status: 400, json: { message: validation.error.message } });
          }
          saved.push(payload);
          body = { question: { ...payload, id: 'saved-question' } };
        } else {
          return route.fulfill({ status: 404, json: { message: `Unexpected test request: ${path}` } });
        }
        return route.fulfill({ json: body });
      });
      await page.goto(`${base}/teacher/quizzes/${quiz.id}/edit`);
      await page.getByRole('button', { name: 'Add question', exact: true }).click();
      await expect(page.getByLabel('Question', { exact: true })).toBeVisible();
      await page.getByLabel('Question', { exact: true }).fill('Which answer is correct?');
      for (const letter of ['A', 'B', 'C', 'D']) {
        await page.getByRole('textbox', { name: `Option ${letter}`, exact: true }).fill(`Answer ${letter}`);
      }
      await page.getByRole('radio', { name: 'Mark option B correct' }).check();
      await page.locator('form').filter({ has: page.getByLabel('Question', { exact: true }) })
        .getByRole('button', { name: 'Add question', exact: true }).click();
      await expect(page.getByText('Question added.', { exact: true })).toBeVisible();
      assert.equal(new Set(saved[0].options.map((option) => option.id)).size, 4);
      assert.equal(saved[0].correctOptionId, saved[0].options[1].id);

      await page.getByRole('button', { name: 'Edit question 1', exact: true }).click();
      await expect(page.getByRole('textbox', { name: 'Option B', exact: true })).toHaveValue('Answer B');
      await expect(page.getByRole('radio', { name: 'Mark option B correct' })).toBeChecked();
      await page.getByRole('textbox', { name: 'Option B', exact: true }).fill('Updated answer B');
      await page.getByRole('button', { name: 'Save changes', exact: true }).click();
      await expect(page.getByText('Question updated.', { exact: true })).toBeVisible();
      assert.deepEqual(saved[1].options.map((option) => option.id), saved[0].options.map((option) => option.id));
      assert.equal(saved[1].correctOptionId, saved[0].correctOptionId);

      await page.getByRole('button', { name: 'Add question', exact: true }).click();
      await expect(page.getByLabel('Question', { exact: true })).toHaveValue('');
      await expect(page.getByLabel('Display order')).toHaveValue('2');
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  });
}
