export function componentElements(root: HTMLElement) {
  const element = <T extends HTMLElement>(selector: string) =>
    root.matches(selector) ? (root as T) : root.querySelector<T>(selector);
  const status = (selector: string, message: string, error = false) => {
    const target = element(selector);
    if (target) {
      target.textContent = message;
      target.classList.toggle("error", error);
    }
  };
  const elements = <T extends HTMLElement>(selector: string) =>
    root.querySelectorAll<T>(selector);
  return { element, elements, status };
}
export async function api(path: string, body?: unknown) {
  const response = await fetch(
    path,
    body === undefined
      ? undefined
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.error ?? "The request failed. Please try again.");
  return data;
}
