import { FileText, Image as ImageIcon } from "lucide-react";
import { blobDataUrl } from "../api.js";
import { clientKinds } from "./attachment-kinds.js";
import { HistoryImage } from "./HistoryImage.js";

// Built-in kinds; importing this module registers them.
clientKinds.register({
  id: "image",
  label: "Image",
  icon: <ImageIcon size={14} aria-hidden="true" />,
  thumbnail: async (file) => {
    return blobDataUrl(file);
  },
  timeline: (attachment, sessionId, sequence) => (
    <HistoryImage
      key={attachment.index}
      sessionId={sessionId}
      sequence={sequence}
      attachment={attachment}
    />
  ),
});

/** Workspace file references have no bytes; they render as a chip. */
clientKinds.register({
  id: "file",
  label: "File",
  icon: <FileText size={14} aria-hidden="true" />,
  timeline: (attachment) => (
    <span className="attachment-chip" key={attachment.index} title={attachment.name}>
      <FileText size={14} aria-hidden="true" />
      <span className="attachment-name">{attachment.name}</span>
    </span>
  ),
});

