import { expect, type Locator } from "@playwright/test";

/** Exercise the actual Kiln popup; never synthesize a native select change. */
export async function selectOption(trigger: Locator, value: string): Promise<void> {
  await trigger.click();
  const option = trigger.page().locator(`[role="option"][data-value=${JSON.stringify(value)}]`);
  await expect(option).toBeVisible();
  await option.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
}
