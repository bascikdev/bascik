/**
 * Which saves take turns: a reader's saves to one store (or to two file
 * stores over one folder) queue behind each other, so a cap on how many
 * conversations a reader keeps holds within one server.
 */
import type { ConversationStore } from "./types.ts";

/**
 * What a store keeps its conversations in, when two store objects can share
 * it: `fileStore` names its folder. Saves take turns by this, so two stores
 * over one folder hold one reader's cap together.
 */
export const sharedKeys = new WeakMap<ConversationStore, Promise<string>>();

/**
 * Each store's saves in progress, by reader. It is kept by what the store
 * keeps its conversations in (its `sharedKeys` name) when it has one, and by
 * the store object when not, so two chats over one store, or over two file
 * stores of one folder, take turns too.
 */
const savingByStore = new WeakMap<
  ConversationStore,
  Map<string, Promise<unknown>>
>();
const savingByName = new Map<string, Map<string, Promise<unknown>>>();

export async function savingOf(
  store: ConversationStore,
): Promise<Map<string, Promise<unknown>>> {
  const named = sharedKeys.get(store);
  if (named) {
    const name = await named;
    let saving = savingByName.get(name);
    if (!saving) savingByName.set(name, (saving = new Map()));
    return saving;
  }
  let saving = savingByStore.get(store);
  if (!saving) savingByStore.set(store, (saving = new Map()));
  return saving;
}
