import type { FullConfig } from "@playwright/test";
import { removeVerificationFixture } from "./verification-fixture.ts";

export default async function teardown(config: FullConfig): Promise<void> {
  await removeVerificationFixture(config.metadata.verificationRoot as string);
}
