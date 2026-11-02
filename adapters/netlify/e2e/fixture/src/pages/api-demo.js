const buttons = [
  {
    button: document.querySelector('[data-testid="demo-api-send"]'),
    path: "/api/ping",
    status: document.querySelector('[data-testid="demo-api-status"]'),
    output: document.querySelector('[data-testid="demo-api-response"]'),
    includeStatusInBody: true,
  },
  {
    button: document.querySelector('[data-testid="fixture-api-send"]'),
    path: "/api/context",
    status: document.querySelector('[data-testid="fixture-api-status"]'),
    output: document.querySelector('[data-testid="fixture-api-response"]'),
    includeStatusInBody: false,
  },
];

for (const { button, path, status, output, includeStatusInBody } of buttons) {
  button.addEventListener("click", async () => {
    button.disabled = true;
    status.textContent = "Sending request...";
    output.textContent = "Waiting for response...";
    try {
      const response = await fetch(path);
      const body = await response.text();
      if (!response.ok) {
        status.textContent = `Request failed: HTTP ${response.status}`;
        output.textContent = [
          includeStatusInBody ? `HTTP ${response.status}` : "",
          body || "The server returned an empty error response.",
        ]
          .filter(Boolean)
          .join("\n");
        return;
      }
      try {
        output.textContent = JSON.stringify(JSON.parse(body), null, 2);
      } catch {
        output.textContent = body;
      }
      status.textContent = `HTTP ${response.status} - response received.`;
    } catch (error) {
      status.textContent = "Request failed.";
      output.textContent =
        error instanceof Error ? error.message : String(error);
    } finally {
      button.disabled = false;
    }
  });
}
