export function VideoModal({ open, onClose }) {
  if (!open) return null;
  return (
    <dialog open data-testid="video-modal">
      <h2>Demo</h2>
      <button data-testid="video-modal-close" onClick={onClose}>Close</button>
    </dialog>
  );
}
