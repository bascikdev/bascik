import { handler } from "../lib/platform.ts";
import { confirmFormRequest } from "../lib/checkout-form.ts";
export const POST = handler(confirmFormRequest);
