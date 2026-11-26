/**
 * The pieces `createChat` builds once and its parts share: the resolved
 * options (`ChatBase`) and what each part hands the others. Every part of the
 * chat takes the pieces it needs from these, so each can be read alone.
 */
import type { Catalog } from "../catalog.ts";
import type { FileStore, ResolvedFileLimits } from "../files.ts";
import type { SharedKeys } from "../keys.ts";
import type { MemoryStore } from "../memory.ts";
import type { ChatMessage, FilePart, Tool } from "../model.ts";
import type { TurnRenderOptions } from "../render-turn.ts";
import type { Lease, Shared } from "../shared.ts";
import type { Conversation, ConversationStore } from "../store.ts";
import type { VoiceTurn } from "../voice.ts";
import type { ChatOptions } from "./options.ts";
import type { ChatSessions, Session } from "./sessions.ts";
import type { TurnRecord } from "./turn-record.ts";
import type { Chat, HostContext, LiveTurn } from "./types.ts";

/** The options as `createChat` resolved them, and what it made from them. */
export interface ChatBase {
  options: ChatOptions;
  id: string;
  tools: Tool[];
  memory: MemoryStore | undefined;
  memoryApproval: boolean;
  page: string;
  turnLimitMs: number;
  maxRounds: number | undefined;
  followLocally: boolean;
  store: ConversationStore;
  sessions: ChatSessions;
  onError: (error: unknown, what: string) => void;
  renderOptions: TurnRenderOptions;
  shared: Shared;
  keys: SharedKeys;
}

/** The catalog, and what a model is given: its tools and its prompt. */
export interface ChatPrompts {
  toolsFor(session: Session, conversationId?: string): Tool[];
  catalog(): Promise<Catalog>;
  promptFor(voice: boolean, session?: Session): Promise<string>;
}

/** Reading and storing conversations, one write at a time. */
export interface ChatConversations {
  load: Chat["load"];
  roomIn(conversation: Conversation, adding: readonly ChatMessage[]): boolean;
  save: Chat["save"];
  redirect: Chat["redirect"];
  serialized<T>(
    session: Session,
    conversationId: string,
    change: () => Promise<T>,
  ): Promise<T>;
  changingOpen<T>(
    session: Session,
    change: (conversation: Conversation | null) => Promise<T>,
  ): Promise<T>;
  loadForCaller: Chat["load"];
  saveForCaller: Chat["save"];
  change: Chat["change"];
  addMessage: Chat["addMessage"];
}

/** A form handler's body, and the files a send attaches. */
export interface ChatUploads {
  fileStore: FileStore | undefined;
  fileLimits: ResolvedFileLimits;
  maxBodyBytes: number;
  formOf(request: Request, notAForm: string): Promise<FormData | Response>;
  readFileFor(
    session: Session,
  ): ((part: FilePart) => Promise<Uint8Array | null>) | undefined;
  attach(
    session: Session,
    form: FormData,
    text: string,
  ): Promise<FilePart[] | Response>;
}

/** The replies this server writes or follows, by conversation. */
export interface LiveTurnsState {
  live: Map<string, LiveTurn>;
  writtenHere: WeakMap<LiveTurn, { turn: string; activeAt: () => number }>;
}

/** Writing a reply this server holds the claim for. */
export interface TurnWriter {
  startTurn(
    session: Session,
    conversation: Conversation,
    request: Request,
    held: { lease: Lease; turn: string },
    context: HostContext | undefined,
  ): LiveTurn;
}

/** Finding and following a reply, wherever it is written. */
export interface TurnFollower {
  follow(conversation: Conversation, record: TurnRecord): LiveTurn;
  writerThere(conversationId: string, turn: string): Promise<boolean>;
  localEntry(conversationId: string): Promise<LiveTurn | undefined>;
  following(conversation: Conversation): Promise<LiveTurn | undefined>;
}

/** What a page and Stop need of the live turns. */
export interface ChatLiveTurns {
  thread: Chat["thread"];
  stopTurn: Chat["stopTurn"];
}

/** A voice call's state in the shared store. */
export interface ChatVoiceState {
  pickedVoice: boolean;
  voiceOpenKey: SharedKeys["voiceOpen"];
  voiceOpen(conversationId: string): Promise<boolean>;
  noVoice(): Response;
  viewKey: SharedKeys["view"];
  updateVoice<T>(
    conversationId: string,
    change: (turn: VoiceTurn) => T | Promise<T>,
  ): Promise<T>;
}
