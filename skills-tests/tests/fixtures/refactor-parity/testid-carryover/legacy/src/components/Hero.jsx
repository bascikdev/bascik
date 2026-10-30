export function Hero({ onStart }) {
  return (
    <div className="row">
      <h1>Plan work your team can see</h1>
      <button type="button" data-testid="hero-cta" onClick={onStart}>
        Get started
      </button>
    </div>
  );
}
