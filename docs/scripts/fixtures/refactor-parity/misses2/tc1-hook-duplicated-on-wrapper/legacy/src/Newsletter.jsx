export function Newsletter() {
  return (
    <form data-testid="newsletter-form">
      <label>Email <input type="email" data-testid="newsletter-email" /></label>
      <button type="submit" data-testid="newsletter-submit">Subscribe</button>
    </form>
  );
}
