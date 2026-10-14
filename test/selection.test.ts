import assert from "node:assert/strict";
import test from "node:test";
import { selectionBetween, selectionPixels } from "../src/popup/selection.ts";

test("selection handles reversed drags, edges and display scaling without a full-page fallback", () => {
  const selection = selectionBetween({ x: 0.8, y: 0.9 }, { x: 0.2, y: 0.1 });
  assert.deepEqual(selectionPixels(selection, 2000, 1000), {
    x: 400,
    y: 100,
    width: 1200,
    height: 800,
  });
  assert.deepEqual(selectionBetween({ x: -1, y: -2 }, { x: 2, y: 3 }), {
    x: 0,
    y: 0,
    width: 1,
    height: 1,
  });
  for (const invalid of [
    { x: 0, y: 0, width: 0, height: 1 },
    { x: -1, y: 0, width: 1, height: 1 },
    { x: 0.9, y: 0, width: 0.2, height: 1 },
    { x: 0, y: 0.9, width: 1, height: 0.2 },
    { x: NaN, y: 0, width: 1, height: 1 },
  ])
    assert.throws(() => selectionPixels(invalid, 2000, 1000), /select an area/);
});
