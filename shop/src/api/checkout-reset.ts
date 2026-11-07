import { handler } from "../lib/platform.ts";
import { resetFormRequest } from "../lib/checkout-form.ts";
export const POST = handler(resetFormRequest);
