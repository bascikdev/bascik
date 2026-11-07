import { handler } from "../lib/platform.ts";
import { createFormRequest } from "../lib/checkout-form.ts";
export const POST = handler(createFormRequest);
