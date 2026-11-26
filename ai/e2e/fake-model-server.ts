/**
 * A stand-in for a local model server (Ollama, LM Studio): it speaks enough
 * of the OpenAI chat completions API for the demo to list it and stream a
 * reply from it. Started by playwright.config.ts.
 */
import { createServer } from "node:http";

const PORT = Number(process.argv[2] ?? 4479);
const REPLY = [
  "From the fake local model: ",
  `<book-card title="The Local `,
  `Model" author="Ada Quill" rating="4.2">Runs on `,
  "your own machine.</book-card>",
];

createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/v1/models") {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ data: [{ id: "fake-local:7b" }] }));
    return;
  }
  if (request.method === "POST" && request.url === "/v1/chat/completions") {
    let body = "";
    for await (const chunk of request) body += chunk;
    const { model } = JSON.parse(body) as { model: string };
    response.setHeader("content-type", "text/event-stream");
    for (const content of [...REPLY, ` (asked for ${model})`]) {
      response.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`,
      );
    }
    response.end(
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
    return;
  }
  response.statusCode = 404;
  response.end();
}).listen(PORT, "127.0.0.1");
