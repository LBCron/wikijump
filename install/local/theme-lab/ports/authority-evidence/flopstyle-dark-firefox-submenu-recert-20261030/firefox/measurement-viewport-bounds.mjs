// Document scrollWidth cannot detect content escaping to the left.
export function viewportEscape(rect, viewportWidth, tolerance = 1) {
  const left = rect.left ?? rect.x;
  const right = rect.right ?? left + rect.width;
  return {
    left, right, viewport_width: viewportWidth,
    off_left_px: Math.max(0, -left),
    off_right_px: Math.max(0, right - viewportWidth),
    pass: Number.isFinite(left) && Number.isFinite(right) &&
      left >= -tolerance && right <= viewportWidth + tolerance,
  };
}

// A closed drawer must exist and sit wholly outside the layout viewport.
// Applying ordinary containment would reject the required off-canvas state.
export function closedDrawerBounds(rect, viewportWidth, tolerance = 1) {
  const left = rect.left ?? rect.x;
  const right = rect.right ?? left + rect.width;
  return {left, right, viewport_width: viewportWidth, expected: 'off-canvas',
    pass: [left, right, rect.width, rect.height, viewportWidth].every(Number.isFinite) &&
      rect.width > 0 && rect.height > 0 && viewportWidth > 0 &&
      (right <= tolerance || left >= viewportWidth - tolerance)};
}
