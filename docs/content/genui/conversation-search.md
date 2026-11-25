# Conversation Search

Readers find things in their past conversations with a search box, and the model can look there too when you let it. The search box is a plain `GET` form, so it works with scripts off.

## The smallest setup

`chat.search(request)` reads `?q=` from the request and answers the reader's matching conversations. Any store works, because without a search of its own the chat reads the reader's conversations and matches words itself. A page script calls it:

```ts
// In a server or stream script of the page
import { chat } from "@/lib/chat.ts";

const { query, tooShort, matches } = await chat.search(request);
```

Each match has the conversation's `id`, its `title`, when it was `updatedAt`, a short `snippet` of what was said, and `marks`, the `[start, end)` offsets of the matched words inside the snippet. The snippet is text a reader or a model wrote, so it is never markup: draw it by escaping it and wrapping each marked range in `<mark>`.

The form that sends the query is ordinary HTML:

```html
<search>
  <form method="get" action="/">
    <label for="q">Search conversations</label>
    <input id="q" type="search" name="q" maxlength="200" />
    <button>Search</button>
  </form>
</search>
```

## What the reader sees

The demo's sidebar shows the search box under "New chat". With a query in the address, the results take the place of the conversation list: each result is its conversation's title, a snippet with the matched words marked, and a button that opens it. Opening is the same form post the conversation list uses (`/api/open`), so a result works with scripts off, and the page it lands on has no query.

A query with no matches shows "No conversation mentions" and the words. A query shorter than two characters shows a hint instead of searching. The search box keeps what was typed.

The results list is a component, `search-result`, copied into `src/components/chat/` by `bascik add @bascik/genui`. Each one is a list item for an `ol`, and the snippet goes inside the tag:

```html
<search-result
  data-bascik-prop-app="books"
  data-bascik-prop-conversation="3f2a0c1e"
  data-bascik-prop-title="Books about lighthouses"
>
  A short <mark>lighthouse</mark> story
</search-result>
```

The sidebar around it is yours: where the box goes, what an empty result says, and how a match is dated.

## Matching

Without a search of the store's own, the words of a query are matched this way:

- Case does not matter.
- Every word has to appear somewhere in the conversation, though not in the same message.
- A conversation with more appearances ranks higher, and a tie goes to the more recent one.
- Only what was said is searched: the reader's messages, the model's text, and spoken text. Tool inputs and outputs are never read.

## Let the model search

Set `history: true` and the model gets a `search_conversations` tool, in typed chat and in a voice call:

```ts
export const chat = createChat({
  store,
  catalog,
  model,
  system: "You help readers choose books.",
  history: true,
});
```

The tool takes a `query` and looks only in the current reader's conversations, leaving out the one that is open. It returns at most five short quotes, each with the conversation's title and date.

What it returns is the reader's own past text, which can say anything, including text that reads like an order to the model. So the result is handed over as JSON data with a first line that says it is quoted data and not instructions, and the tool's description tells the model not to follow what is inside. That lowers the risk; it does not remove it. Do not combine `history` with a tool that acts without the reader's approval.

## Search with your own database

A store may add a `search` method. The chat uses it in place of reading every conversation:

```ts
import type { ConversationStore, SearchMatch } from "@bascik/genui/app";

export const store: ConversationStore = {
  load,
  save,
  list,
  async search(reader, query, limit): Promise<SearchMatch[]> {
    // Illustrative: a Postgres full-text query over a table of messages.
    // The query is a bound parameter, never part of the SQL text.
    const { rows } = await db.query(
      `select c.id, c.title, c.updated_at,
              ts_headline('english', m.text, plainto_tsquery('english', $2),
                'StartSel=\u0001, StopSel=\u0002, MaxFragments=1') as snippet
         from messages m
         join conversations c on c.id = m.conversation_id
        where c.reader = $1
          and m.role in ('user', 'assistant')
          and to_tsvector('english', m.text) @@ plainto_tsquery('english', $2)
        order by ts_rank(to_tsvector('english', m.text),
                         plainto_tsquery('english', $2)) desc
        limit $3`,
      [reader, query, limit],
    );
    return rows.map(toMatch); // turn the \u0001 and \u0002 markers into marks
  },
};
```

The method has three rules. Look only in the given reader's conversations. Search what was said, never tool inputs or outputs. Return the best matches first, at most `limit`, with plain-text snippets.

## Limits

- A query is cut to 200 characters, and one shorter than two finds nothing.
- Without a search of the store's own, at most the 200 newest conversations are read, and up to eight words of a query are matched.
- A search returns at most 20 matches to a page, and at most 50 from `searchConversations()`, which you can call yourself.
- The model's tool returns at most five quotes of about 240 characters each.
- The word matching is plain: no stemming, no typo tolerance, no phrase matching. A database's full-text search does those, which is why the store can bring its own.
- A model's reply is stored as the text it wrote, so a search can match a component's tag or prop as well as its words.
