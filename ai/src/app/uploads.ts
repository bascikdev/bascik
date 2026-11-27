/**
 * What a form handler may read, and the files a send attaches: the body's
 * byte limit, the form or the answer that refuses it, how a model reads an
 * attached file, and checking and storing a send's files.
 */
import { checkUploads, refusedPage, resolveLimits } from "../files.ts";
import type { FilePart } from "../model.ts";
import type { ChatBase, ChatUploads } from "./context.ts";
import { badRequest } from "./errors.ts";
import { crossSite, readForm } from "./forms.ts";
import { MULTIPART_ROOM, NO_STORE } from "./limits.ts";
import type { Session } from "./sessions.ts";

/** The chat's form reading and attached files. */
export function chatUploads(base: ChatBase): ChatUploads {
  const { options, page, onError } = base;

  const fileStore = options.files;
  const fileLimits = resolveLimits(options.fileLimits);
  const maxBodyBytes =
    options.maxBodyBytes ??
    (fileStore ? fileLimits.maxTotalBytes + MULTIPART_ROOM : MULTIPART_ROOM);
  /** A form handler's form, or its answer when there is none. */
  const formOf = async (
    request: Request,
    notAForm: string,
  ): Promise<FormData | Response> => {
    // Every form changes something: another site's page may not send one.
    const refused = crossSite(request);
    if (refused) return refused;
    const form = await readForm(request, maxBodyBytes);
    if (form === "not a form") return badRequest(notAForm);
    if (form === "too large") {
      return new Response("The request is too large.", {
        status: 413,
        headers: NO_STORE,
      });
    }
    return form;
  };
  const readFileFor = (session: Session) =>
    fileStore
      ? async (part: FilePart): Promise<Uint8Array | null> =>
          (await fileStore.get(session.reader, part.id))?.bytes ?? null
      : undefined;

  /**
   * The files of a send, checked and stored, as message parts; or the
   * response that refuses them. Nothing is stored unless every file passes.
   */
  async function attach(
    session: Session,
    form: FormData,
    text: string,
  ): Promise<FilePart[] | Response> {
    if (!fileStore) return [];
    // An empty file input still sends one empty, unnamed part: that is no file.
    const uploads = form
      .getAll("files")
      .filter(
        (value): value is File =>
          typeof value !== "string" && (value.size > 0 || value.name !== ""),
      );
    if (uploads.length === 0) return [];
    const checked = await checkUploads(uploads, fileLimits);
    if (!checked.ok) return refusedPage(checked.message, text, page);
    const stored: string[] = [];
    try {
      for (const file of checked.files) {
        await fileStore.put(session.reader, file.id, {
          name: file.name,
          mediaType: file.mediaType,
          size: file.bytes.byteLength,
          bytes: file.bytes,
        });
        stored.push(file.id);
      }
    } catch (error) {
      onError(error, "an attached file could not be stored");
      await Promise.all(
        stored.map((id) =>
          fileStore.remove(session.reader, id).catch(() => {}),
        ),
      );
      return refusedPage(
        "The files could not be saved. Nothing was sent; try again.",
        text,
        page,
      );
    }
    return checked.files.map((file) => ({
      type: "file" as const,
      id: file.id,
      name: file.name,
      mediaType: file.mediaType,
      size: file.bytes.byteLength,
    }));
  }

  return { fileStore, fileLimits, maxBodyBytes, formOf, readFileFor, attach };
}
