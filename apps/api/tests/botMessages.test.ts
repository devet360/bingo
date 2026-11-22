import test from 'node:test';
import assert from 'node:assert/strict';
import { botCopy } from '../src/bot/messages';

test('contact-verification follow-up copy is available in both bot locales', () => {
  for (const locale of ['en', 'am'] as const) {
    assert.ok(botCopy[locale].contactVerified);
    assert.ok(botCopy[locale].playPrompt);
    assert.ok(botCopy[locale].contactSaved('+251911234567'));
  }
});

test('English and Amharic bot copy keep the same keys', () => {
  assert.deepEqual(
    Object.keys(botCopy.en).sort(),
    Object.keys(botCopy.am).sort(),
  );
});
