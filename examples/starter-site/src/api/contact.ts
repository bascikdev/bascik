// src/api/contact.ts: POST /api/contact. Runs under `bascik --server` or a serverless target, never on a static host.
// Accepts JSON (from the contact-form component's script) and a plain form POST (the no-JavaScript fallback).

const MAX_LENGTH = { name: 200, email: 320, message: 5000 } as const;
type Field = keyof typeof MAX_LENGTH;

export interface ContactMessage {
  name: string;
  email: string;
  message: string;
}

/** Validate untrusted input. Returns the cleaned message, or a list of problems. */
export function validateContact(
  input: Record<string, unknown>,
): { ok: true; value: ContactMessage } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const value = {} as ContactMessage;
  for (const field of Object.keys(MAX_LENGTH) as Field[]) {
    const raw =
      typeof input[field] === "string" ? (input[field] as string).trim() : "";
    if (!raw) errors.push(`${field} is required`);
    else if (raw.length > MAX_LENGTH[field])
      errors.push(`${field} is too long`);
    value[field] = raw;
  }
  if (value.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email))
    errors.push("email is not valid");
  if (value.message && value.message.length < 10)
    errors.push("message is too short");
  return errors.length ? { ok: false, errors } : { ok: true, value };
}

export const POST = async (request: Request): Promise<Response> => {
  const isJson = (request.headers.get("content-type") ?? "").includes(
    "application/json",
  );
  let input: unknown;
  try {
    input = isJson
      ? await request.json()
      : Object.fromEntries(await request.formData());
  } catch {
    return Response.json({ errors: ["invalid request body"] }, { status: 400 });
  }
  // JSON can be null, a string, or an array; only an object can hold the fields.
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return Response.json(
      { errors: ["expected an object with name, email, and message"] },
      { status: 400 },
    );
  }

  const result = validateContact(input as Record<string, unknown>);
  if (!result.ok)
    return Response.json({ errors: result.errors }, { status: 422 });

  // Replace this with your email or CRM provider. Keep API keys in process.env, never in client code.
  console.log(`[contact] message from ${result.value.email}`);

  // A browser without JavaScript posted a normal form: send it back to the contact page on this origin.
  // Never trust the Referer header here, it would make this an open redirect.
  if (!isJson)
    return Response.redirect(new URL("../contact?sent=1", request.url), 303);
  return Response.json({ ok: true }, { status: 201 });
};
