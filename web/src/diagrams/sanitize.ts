import DOMPurify from "dompurify";

const tags = ["svg", "g", "defs", "marker", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "tspan", "title", "desc"];
const attributes = ["id", "class", "viewBox", "width", "height", "x", "y", "x1", "x2", "y1", "y2", "dx", "dy", "cx", "cy", "r", "rx", "ry",
  "d", "points", "transform", "text-anchor", "dominant-baseline", "font-size", "font-weight", "font-family",
  "fill", "stroke", "stroke-width", "stroke-dasharray", "stroke-linecap", "stroke-linejoin", "fill-rule", "fill-opacity", "stroke-opacity", "opacity",
  "marker-start", "marker-mid", "marker-end", "markerWidth", "markerHeight", "markerUnits", "orient", "refX", "refY", "preserveAspectRatio", "role", "aria-label", "aria-labelledby", "aria-describedby"];

/** An allowlist sanitizer, followed only by attribute removal and trusted accessibility metadata. */
export function sanitizeDiagram(svg: string, title: string): string {
  if (svg.length > 2 * 1024 * 1024) throw new Error("Rendered diagram is too large.");
  const fragment = DOMPurify.sanitize(svg, { ALLOWED_TAGS: tags, ALLOWED_ATTR: attributes,
    ALLOW_DATA_ATTR: false, RETURN_DOM_FRAGMENT: true });
  const root = fragment.firstElementChild;
  if (!root || root.localName !== "svg" || fragment.childElementCount !== 1) throw new Error("Renderer did not produce a diagram.");
  const nodes = [root, ...root.querySelectorAll("*")];
  if (nodes.length > 10_000) throw new Error("Rendered diagram is too complex.");
  const markers = new Set([...root.querySelectorAll("marker[id]")].map((node) => node.id));
  for (const node of nodes) {
    for (const attribute of [...node.attributes]) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value;
      if (name.startsWith("marker-")) {
        const local = /^url\(["']?#([\w:.-]+)["']?\)$/.exec(value);
        if (!local || !markers.has(local[1]!)) node.removeAttribute(attribute.name);
      } else if (/url\s*\(|(?:https?|data|javascript|vbscript|file|blob):|\/\/|[\\]/i.test(value)) {
        node.removeAttribute(attribute.name);
      }
      // Colors are host-controlled. Labels and geometry cannot carry executable attributes.
      if (["fill", "stroke", "font-family", "font-size"].includes(name)) node.removeAttribute(attribute.name);
    }
  }
  root.setAttribute("role", "img");
  root.setAttribute("aria-label", title);
  root.removeAttribute("aria-labelledby");
  root.removeAttribute("aria-describedby");
  return root.outerHTML;
}
