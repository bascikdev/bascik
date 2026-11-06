import { handler } from "../lib/platform.ts";
import { checkoutRequest } from "../lib/checkout.ts";

export const POST = handler(checkoutRequest);
