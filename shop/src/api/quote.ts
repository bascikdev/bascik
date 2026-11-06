import { handler } from "../lib/platform.ts";
import { quoteRequest } from "../lib/checkout.ts";

export const POST = handler(quoteRequest);
