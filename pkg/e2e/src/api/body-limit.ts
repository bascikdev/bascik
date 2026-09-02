// Distinctive test marker for verification
// MARKER: SECRET_SOURCE_CODE_MARKER_API_HANDLER_DO_NOT_LEAK_12345

let sideEffectOccurred = false;

export const POST = async (req: Request) => {
  // Read text to trigger body limit check
  await req.text();
  sideEffectOccurred = true;
  return Response.json({ ok: true, sideEffect: sideEffectOccurred });
};

export const GET = async () => {
  return Response.json({ sideEffect: sideEffectOccurred });
};
