export interface Point {
  readonly x: number;
  readonly y: number;
}

/** Normalized coordinates, independent of display scaling and device pixel ratio. */
export interface Selection {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export function selectionBetween(start: Point, end: Point): Selection {
  const clamp = (value: number) => Math.max(0, Math.min(1, value));
  const x = Math.min(clamp(start.x), clamp(end.x));
  const y = Math.min(clamp(start.y), clamp(end.y));
  return {
    x,
    y,
    width: Math.max(clamp(start.x), clamp(end.x)) - x,
    height: Math.max(clamp(start.y), clamp(end.y)) - y,
  };
}

export function selectionPixels(selection: Selection, width: number, height: number): Selection {
  const { x, y, width: w, height: h } = selection;
  if (
    ![x, y, w, h].every(Number.isFinite) ||
    x < 0 ||
    y < 0 ||
    w <= 0 ||
    h <= 0 ||
    x + w > 1 ||
    y + h > 1
  ) {
    throw new Error("Drag to select an area around the QR code first.");
  }
  const left = Math.floor(x * width);
  const top = Math.floor(y * height);
  return {
    x: left,
    y: top,
    width: Math.ceil((x + w) * width) - left,
    height: Math.ceil((y + h) * height) - top,
  };
}
