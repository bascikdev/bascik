# Attachments

A reader can attach images and files to a message. The model receives them, and they show in the thread. It is a plain file input in a plain form: nothing here needs browser JavaScript, and scripts only make the picking nicer.

## The smallest setup

Give the chat a file store, put one route in front of it, and turn attachments on in the composer.

```ts
import { createChat } from "@bascik/genui/app";
import { diskFiles } from "@bascik/genui/files";

export const chat = createChat({
  // ...store, catalog, model, system
  files: diskFiles(".data/files"),
});
```

```ts
// src/api/file.ts
import { chat } from "../lib/chat.ts";

export const GET = chat.file;
```

```html
<chat-composer data-bascik-prop-enctype="multipart/form-data" />
```

`send` now accepts `multipart/form-data` with a `files` field, stores each file under the reader, and puts file parts on the message. `file` serves one back with `GET /api/file?id=<id>`. Without the `files` option, uploads are ignored and the chat behaves as before. Without the `enctype` prop, the composer shows no Attach button.

## What the reader sees

The Attach button is a `<label>` for a real `<input type="file" name="files" multiple>`, so it works with JavaScript off: the reader picks files, presses Send, and the page reloads with the message in the thread.

With scripts on, the composer adds:

- chosen files as removable chips with a name and a size, and a small preview for an image
- a check before sending for what can be known without the bytes (the type, the size, the count), in the same words the server uses
- paste and drag-and-drop of files onto the composer

In the thread, an image is a thumbnail that opens the full image, and any other file is a labelled link with its name and size. The `chat-attachment` component draws one of these, and a file name is always shown as escaped text.

A refused upload does not lose what the reader typed. With scripts on, the message appears in the composer and the text and files stay where they are. With scripts off, the server answers with a short page that gives the reason, repeats the text so it can be copied, and links back to the chat.

## What the model receives

A user message with attachments holds a text part followed by file parts:

```ts
type FilePart = {
  type: "file";
  id: string;
  name: string;
  mediaType: string;
  size: number;
};
```

The conversation keeps only this description. The bytes stay in the file store, and the chat gives each model request a `readFile(part)` function that returns them. An adapter never touches storage. Files go first in the message, then the reader's words.

| Adapter                          | Images (PNG, JPEG, WebP, GIF)    | PDF                                | Text, Markdown, CSV |
| -------------------------------- | -------------------------------- | ---------------------------------- | ------------------- |
| `@bascik/genui/anthropic`        | `image` block with base64 source | `document` block with base64 `pdf` | inlined as text     |
| `@bascik/genui/openai`           | `image_url` with a data URL      | a note naming the file             | inlined as text     |
| `@bascik/genui/openai-responses` | `input_image` with a data URL    | a note naming the file             | inlined as text     |

A text file is inlined as text, up to 20,000 characters, between begin and end markers and labelled as the reader's file content, with a line saying it is data and not instructions. A file a model cannot take, or one that is no longer in the store, is never dropped silently: the model gets a short note with the file's name and type.

Your own model function receives the same `ModelRequest`. `userPieces(message, attachments, accepts)` and `readAttachments(messages, readFile)` from `@bascik/genui` make the same decisions the adapters make, so you can build the wire format of any other API from them.

## Your own file store

A store has three methods. The reader and the file id are keys the library made, never values from an upload, but a store still refuses any key that is not letters, digits, `_` and `-`, so a key can never become a path.

```ts
import type { FileStore } from "@bascik/genui/files";

export const objectFiles: FileStore = {
  async put(reader, id, file) {
    // file: { name, mediaType, size, bytes }
    await bucket.put(`${reader}/${id}`, file.bytes, {
      customMetadata: { name: file.name, mediaType: file.mediaType },
    });
  },
  async get(reader, id) {
    // Return { name, mediaType, size, bytes }, or null when there is none.
    return null;
  },
  async remove(reader, id) {
    await bucket.delete(`${reader}/${id}`);
  },
};
```

`inMemoryFiles()` keeps files in the process, for tests and a first try. `diskFiles(directory)` writes `<directory>/<reader>/<id>.bin` and a `.json` beside it with the name and type. The name is data in that JSON and is never part of a path.

## Safety rules and limits

The library enforces these. A route or a component does not have to.

| Limit             | Default                                              | Option                        |
| ----------------- | ---------------------------------------------------- | ----------------------------- |
| Bytes per file    | 5 MB                                                 | `fileLimits.maxFileBytes`     |
| Files per message | 4                                                    | `fileLimits.maxFiles`         |
| Bytes per message | 10 MB                                                | `fileLimits.maxTotalBytes`    |
| Types accepted    | PNG, JPEG, WebP, GIF, PDF, plain text, Markdown, CSV | `fileLimits.types` (a subset) |

A request whose declared size is far past the total is turned away before it is read.

**The type is decided by the bytes.** A PNG, JPEG, GIF, WebP or PDF is recognized by its leading bytes. A text type must be valid UTF-8 with no control characters besides tab, line feed and carriage return, so a file with a NUL byte is refused. The type the browser sent and the file extension never make a file acceptable: they only choose between plain text, Markdown and CSV, and they refuse a file that says one thing and is another (a page that claims to be a PNG). A PNG renamed `.txt` is stored as the PNG it is.

**SVG and HTML are never accepted.** A file is refused when it claims to be HTML, SVG or XML by its type or its name, or when its text starts like one. `fileLimits.types` can only narrow the default list, because these are the types the library knows how to check.

**Files are served only to their reader.** `file` looks the id up under the session's reader, so another reader, or no reader, gets a 404. Every response carries `X-Content-Type-Options: nosniff`, `Cache-Control: private`, and `Content-Security-Policy: default-src 'none'; sandbox`. Images are sent inline with their checked type. Everything else is sent with `Content-Disposition: attachment` and a filename that is safe in a header, in both the plain and the encoded form.

**Names and ids are the library's.** The id is a generated UUID. The stored name keeps only the last path segment, drops control and direction-changing characters, and is cut to 120 characters. It is always escaped where it is shown, and never used as a path.

**Nothing is stored unless every file passes.** If storing fails part way, the files already stored for that message are removed.
