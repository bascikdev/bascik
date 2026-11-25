# Attachments

A reader can attach images and files to a message. The model receives them, and they show in the thread. It is a plain file input in a plain form: nothing here needs browser JavaScript, and scripts only make the picking nicer.

## The smallest setup

Give the chat a file store, put one route in front of it, and turn attachments on in the composer.

```ts
import { createChat } from "@bascik/ai/app";
import { diskFiles } from "@bascik/ai/files";

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

In the thread, an image is a thumbnail that opens the full image, and any other file is a labeled link with its name and size. The `chat-attachment` component draws one of these, and a file name is always shown as escaped text.

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

| Adapter                       | Images (PNG, JPEG, WebP, GIF)    | PDF                                | Text, Markdown, CSV |
| ----------------------------- | -------------------------------- | ---------------------------------- | ------------------- |
| `@bascik/ai/anthropic`        | `image` block with base64 source | `document` block with base64 `pdf` | inlined as text     |
| `@bascik/ai/openai`           | `image_url` with a data URL      | a note naming the file             | inlined as text     |
| `@bascik/ai/openai-responses` | `input_image` with a data URL    | a note naming the file             | inlined as text     |

A text file is inlined as text, up to 20,000 characters, between begin and end markers and labeled as the reader's file content, with a line saying it is data and not instructions. Each marker carries a random boundary made for that file, so text inside the file cannot close the block, and anything in the file that looks like a marker, even split across lines, is changed to read `end-of-file`. The random boundary is the real defense: a forged line cannot carry it. The look-alike check is a second layer, and it reads the file folded first: in any case or spacing, with fullwidth and other compatibility letters as plain ones, and without accents and zero-width characters. Any letter outside ASCII may stand in for a marker letter (small capitals, Lisu, Cherokee, Cyrillic), as long as each marker word keeps one Latin letter, or the line starts like a real marker, after two or more dashes or other marks. Ordinary text in other scripts is left as it is. The lines a match touches are shown folded; every other line is shown as it was. A file a model cannot take, or one that is no longer in the store, is never dropped silently: the model gets a short note with the file's name and type.

A model request carries only recent files: those of the last 3 user messages that have files, up to `fileLimits.maxAttachedBytes` (20 MB by default) in all, counted from the newest file back. The newest message's files are always sent, even when they alone are past the cap, so a large file the reader just attached is never described as attached earlier. Each older file is named in a short note saying it was attached earlier and is not sent again, so the model can ask the reader to attach it again. Without this, every reply in a long conversation would read and send every file ever attached. A turn reads each file from the store once, however many tool rounds it takes. `readAttachments` applies this window, so your own model function gets it too.

Your own model function receives the same `ModelRequest`. `userPieces(message, attachments, accepts)` and `readAttachments(messages, readFile, maxBytes?)` from `@bascik/ai` make the same decisions the adapters make, so you can build the wire format of any other API from them.

## Your own file store

A store has three methods. The reader and the file id are keys the library made, never values from an upload, but a store still refuses any key that is not letters, digits, `_` and `-`, so a key can never become a path.

```ts
import type { FileStore } from "@bascik/ai/files";

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
| Files per request | those of the last 3 messages with files              | none (older files are named)  |
| Bytes per request | 20 MB, or `maxTotalBytes` when that is larger        | `fileLimits.maxAttachedBytes` |

`maxAttachedBytes` cannot be below `maxTotalBytes`, and it must be a positive whole number or `Infinity` for no cap: either mistake throws when the chat is created, not on a reader's request. Left unset, it follows `maxTotalBytes` when that is larger, so raising `maxTotalBytes` (even to `Infinity`) never throws.

A request whose declared size is far past the total is turned away before it is read.

**The type is decided by the bytes.** A PNG, JPEG, GIF, WebP or PDF is recognized by its leading bytes. A text type must be valid UTF-8 with no control characters besides tab, line feed and carriage return, so a file with a NUL byte is refused. The type the browser sent and the file extension never make a file acceptable: they only choose between plain text, Markdown and CSV, and they refuse a file that says one thing and is another (a page that claims to be a PNG). A PNG renamed `.txt` is stored as the PNG it is.

**SVG and HTML are never accepted.** A file is refused when it claims to be HTML, SVG or XML by its type or its name, or when its text starts like one. The name is checked without invisible characters and trailing dots or spaces, both as sent and as it will be stored, so `report.html` followed by a zero-width space, a variation selector or a Hangul filler is refused too. This check names what the reader tried; it is not what keeps a file safe. That is the stored name, below. `fileLimits.types` can only narrow the default list, because these are the types the library knows how to check.

**Files are served only to their reader.** `file` looks the id up under the session's reader, so another reader, or no reader, gets a 404. Every response carries `X-Content-Type-Options: nosniff`, `Cache-Control: private`, and `Content-Security-Policy: default-src 'none'; sandbox`. Images are sent inline with their checked type. Everything else is sent with `Content-Disposition: attachment` and a filename that is safe in a header, in both the plain and the encoded form.

**Names and ids are the library's.** The id is a generated UUID. The stored name keeps only the last path segment, drops control and direction-changing characters, and is cut to 120 characters. It always ends in an extension of the type the bytes were checked to be: when it ends any other way, that extension is added, so `report.xht` holding plain text is stored as `report.xht.txt`, a PNG named `photo.txt` as `photo.txt.png`, and `README` as `README.txt`. A downloaded file then opens as only what it was checked to be, whatever extension the reader's file had. `file` applies the same rule when it serves a file, so a name kept by another store gets it too. It is always escaped where it is shown, and never used as a path.

**Nothing is stored unless every file passes.** If storing fails part way, the files already stored for that message are removed.
