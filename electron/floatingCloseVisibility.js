const BUTTON = { right: 4, top: 3, size: 21 };
const REVEAL_DISTANCE = 56;

function closeVisibility(cursor, bounds) {
  const right = bounds.x + bounds.width - BUTTON.right;
  const top = bounds.y + BUTTON.top;
  const dx = Math.max(0, right - BUTTON.size - cursor.x, cursor.x - right);
  const dy = Math.max(0, top - cursor.y, cursor.y - top - BUTTON.size);
  const proximity = Math.max(0, 1 - Math.hypot(dx, dy) / REVEAL_DISTANCE);
  return proximity * proximity * (3 - 2 * proximity);
}

module.exports = { BUTTON, closeVisibility };
