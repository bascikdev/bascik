/**
 * E2E tests for TC39 JavaScript Isolation Conformance.
 *
 * Verifies per-instance IIFE variable isolation, DOM query rewritings, and async microtask resolution.
 */
import { test, expect } from '@playwright/test';

test.describe('tc39-javascript-test page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/tc39-javascript-test');
  });

  test('lexical isolation: instance 1 and instance 2 maintain independent count state and event handling', async ({ page }) => {
    const inst1 = page.getByTestId('js-instance-1');
    const inst2 = page.getByTestId('js-instance-2');

    const badge1 = inst1.getByTestId('js-badge');
    const incBtn1 = inst1.getByTestId('js-inc-btn');
    const countVal1 = inst1.getByTestId('js-count-val');

    const badge2 = inst2.getByTestId('js-badge');
    const incBtn2 = inst2.getByTestId('js-inc-btn');
    const countVal2 = inst2.getByTestId('js-count-val');

    // Initial state
    await expect(badge1).toHaveText('State: Initial');
    await expect(badge2).toHaveText('State: Initial');
    await expect(countVal1).toHaveText('0');
    await expect(countVal2).toHaveText('0');

    // Click instance 1 button 3 times
    await incBtn1.click();
    await incBtn1.click();
    await incBtn1.click();

    await expect(countVal1).toHaveText('3');
    await expect(badge1).toHaveText('State: Counted (3)');

    // Verify instance 2 is unchanged
    await expect(countVal2).toHaveText('0');
    await expect(badge2).toHaveText('State: Initial');

    // Click instance 2 button once
    await incBtn2.click();
    await expect(countVal2).toHaveText('1');
    await expect(badge2).toHaveText('State: Counted (1)');
    await expect(countVal1).toHaveText('3');
  });

  test('async microtask: resolves async event handling independently per instance', async ({ page }) => {
    const inst1 = page.getByTestId('js-instance-1');
    const asyncBtn1 = inst1.getByTestId('js-async-btn');
    const countVal1 = inst1.getByTestId('js-count-val');
    const badge1 = inst1.getByTestId('js-badge');

    await asyncBtn1.click();
    await expect(countVal1).toHaveText('5');
    await expect(badge1).toHaveText('State: Async (+5)');
  });
});
