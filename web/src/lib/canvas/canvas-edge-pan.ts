// Match the existing node-drag behavior: 48 screen pixels, independent of canvas zoom.
export function canvasEdgePan(pointer: { x: number; y: number }, rect: { left: number; right: number; top: number; bottom: number }, elapsedMs: number) {
    const velocity = (point: number, min: number, max: number) => point < min + 48 ? min + 48 - point : point > max - 48 ? max - 48 - point : 0;
    const elapsed = Math.max(0, elapsedMs) / 1000;
    const vx = velocity(pointer.x, rect.left, rect.right);
    const vy = velocity(pointer.y, rect.top, rect.bottom);
    return { x: vx * 10 * elapsed, y: vy * 10 * elapsed, active: Boolean(vx || vy) };
}
