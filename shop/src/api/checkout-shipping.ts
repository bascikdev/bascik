import { handler } from "../lib/platform.ts";
import { updateFormShipping } from "../lib/checkout-form.ts";
export const POST = handler(updateFormShipping);
