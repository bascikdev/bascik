// The newsletter box renders only after the visitor scrolls past the fold, so the first render never has it.
export function Footer({ showNewsletter }) {
  return (
    <footer>
      {showNewsletter && (
        <form
          data-testid="footer-newsletter"
          action="/newsletter"
          method="post"
        >
          <input name="email" type="email" aria-label="Email" />
          <button type="submit">Subscribe</button>
        </form>
      )}
    </footer>
  );
}
