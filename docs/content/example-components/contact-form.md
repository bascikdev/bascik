# Contact Form

A form that validates in the browser, posts JSON to an API route, and announces the result. Without JavaScript it is an ordinary form `POST`, and the field names reach the server unchanged.

[Source on GitHub](https://github.com/bascikdev/bascik/tree/main/examples/components/contact-form)

## Usage

<!-- demo:usage -->

```html
<contact-form />
```

<!-- example:demo -->

This docs site is static, so it has no `/api/contact` route and sending shows the error message. The [starter site](https://github.com/bascikdev/bascik/tree/main/examples/starter-site) in the Bascik repository includes the handler and runs it under `bascik --server`.

## How It Works

- `name` ships as written, so `new FormData(form)` and the no-JavaScript post both send the keys `name`, `email`, and `message`. See [Component Best Practices](/component-best-practices#naming-form-fields-for-submission).
- The form keeps native validation, so without JavaScript the browser still blocks an empty or malformed submit. With JavaScript, the script calls `checkValidity()` and `reportValidity()`, which shows the browser's messages and focuses the first invalid field. `:user-invalid` styles a field only after the visitor has interacted with it.
- The script sends JSON with `fetch`, disables the button while sending, and writes the outcome to a `role="status"` element.

## The API Route

The starter site's handler accepts both the JSON request and the no-JavaScript form post. It answers JSON with `201` or `422` and an `errors` list, and a form post with a `303` redirect back to the page with `?sent=1`. `validateContact()` is exported so it can be unit tested.

<!-- example:file starter-site/src/api/contact.ts -->

API routes need `bascik --server` or a serverless target such as the [Cloudflare adapter](/deployment/cloudflare). On a static host, point the form's `action` at a form service and leave the handler out.

## Adapt It

- To send email, call your provider's HTTP API in `POST` after validation and read the API key from `process.env`. Never put the key in browser code.
- For inline messages instead of the browser's bubbles, add a `<p id="email-error">` per field, point `aria-describedby` at it, and fill it from `input.validationMessage`. Bascik rewrites `aria-describedby` along with the IDs.
