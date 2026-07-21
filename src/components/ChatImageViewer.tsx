import { useEffect } from "react";
import { createPortal } from "react-dom";
import type { MessageAttachment } from "../domain/ocean";

interface ChatImageViewerProps {
  attachment: MessageAttachment | null;
  onClose: () => void;
}

export function ChatImageViewer({ attachment, onClose }: ChatImageViewerProps) {
  useEffect(() => {
    if (!attachment) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [attachment, onClose]);

  if (!attachment) return null;
  const shell = document.querySelector(".ocean-shell");
  if (!shell) return null;

  return createPortal(
    <div className="chat-image-viewer" onClick={onClose} role="presentation">
      <section
        aria-label={`查看图片：${attachment.name}`}
        aria-modal="true"
        className="chat-image-viewer-dialog"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        <img alt={attachment.name} src={attachment.previewDataUrl} />
        <button aria-label="关闭图片" className="chat-image-viewer-close" onClick={onClose}>
          <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M6 6 18 18M18 6 6 18" /></svg>
        </button>
      </section>
    </div>,
    shell,
  );
}
