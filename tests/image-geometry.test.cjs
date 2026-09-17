/* Layout arithmetic for the bulk image tools, and the ZIP writer they share. */
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const context = vm.createContext({console, Uint8Array, DataView, TextEncoder, Blob});
context.self = context;
for (const file of ['image-geometry.js', 'zip.js']) {
  vm.runInContext(fs.readFileSync('frontend/' + file, 'utf8'), context, {filename: file});
}
const {resizePlan, containRect, contactSheetPlan, withinCanvasLimits} = context.GWImageGeometry;
const plan = (source, options) => JSON.parse(JSON.stringify(resizePlan(source, options)));
const size = result => [result.width, result.height];

test('every mode except exact preserves the aspect ratio', () => {
  const landscape = {width: 4000, height: 3000}, portrait = {width: 600, height: 1800};
  assert.deepEqual(size(plan(landscape, {mode: 'fit', width: 800, height: 800})), [800, 600]);
  assert.deepEqual(size(plan(portrait, {mode: 'fit', width: 800, height: 800})), [267, 800]);
  assert.deepEqual(size(plan(landscape, {mode: 'width', width: 1000})), [1000, 750]);
  assert.deepEqual(size(plan(landscape, {mode: 'height', height: 300})), [400, 300]);
  assert.deepEqual(size(plan(landscape, {mode: 'percent', percent: 25})), [1000, 750]);
  // Nothing is cropped unless the caller asked for an exact frame.
  for (const mode of ['fit', 'width', 'height', 'percent']) {
    const result = plan(landscape, {mode, width: 500, height: 500, percent: 50});
    assert.deepEqual(result.crop, {x: 0, y: 0, width: 4000, height: 3000}, mode + ' cropped');
  }
});

test('fit only enlarges when asked; exact size always fills the frame', () => {
  const small = {width: 100, height: 50};
  assert.deepEqual(size(plan(small, {mode: 'fit', width: 800, height: 800})), [100, 50]);
  assert.deepEqual(size(plan(small, {mode: 'fit', width: 800, height: 800, enlarge: true})), [800, 400]);
  const exact = plan({width: 400, height: 100}, {mode: 'exact', width: 200, height: 200});
  assert.deepEqual(size(exact), [200, 200]);
  // A 400x100 source centred in a square keeps its full height and the middle 100px.
  assert.deepEqual(exact.crop, {x: 150, y: 0, width: 100, height: 100});
  const tall = plan({width: 100, height: 400}, {mode: 'exact', width: 200, height: 200});
  assert.deepEqual(tall.crop, {x: 0, y: 150, width: 100, height: 100});
});

test('sizes are clamped to what a browser canvas will actually accept', () => {
  assert.deepEqual(size(plan({width: 1000, height: 1000}, {mode: 'percent', percent: 400})), [4000, 4000]);
  assert.deepEqual(size(plan({width: 4000, height: 4000}, {mode: 'width', width: 99999})), [8000, 8000]);
  assert.deepEqual(size(plan({width: 100, height: 100}, {mode: 'percent', percent: 0})), [100, 100]);
  assert.equal(withinCanvasLimits(8000, 5000), true);
  assert.equal(withinCanvasLimits(8001, 100), false);
  assert.equal(withinCanvasLimits(7000, 7000), false, '49 megapixels is past the area guard');
  assert.equal(withinCanvasLimits(0, 100), false);
});

test('contact sheet grid accounts for gaps, margins and the label strip', () => {
  const labelled = contactSheetPlan(5, {columns: 3, cell: 200, gap: 10, padding: 20, labels: true, labelHeight: 24});
  assert.equal(labelled.rows, 2);
  assert.equal(labelled.width, 20 * 2 + 3 * 200 + 2 * 10);
  assert.equal(labelled.height, 20 * 2 + 2 * (200 + 24) + 10);
  assert.deepEqual(labelled.cells.length, 5);
  assert.deepEqual([labelled.cells[0].x, labelled.cells[0].y], [20, 20]);
  assert.deepEqual([labelled.cells[3].x, labelled.cells[3].y], [20, 20 + 224 + 10]);
  assert.equal(labelled.cells[0].labelY, 220);
  // Dropping the labels shortens every row by exactly the label height.
  const plain = contactSheetPlan(5, {columns: 3, cell: 200, gap: 10, padding: 20, labels: false, labelHeight: 24});
  assert.equal(plain.height, labelled.height - 2 * 24);
  // Columns never exceed the number of images, so five images never make six columns.
  assert.equal(contactSheetPlan(2, {columns: 8, cell: 100, gap: 0, padding: 0, labels: false}).columns, 2);
});

test('images are letterboxed into their cell, never stretched or enlarged', () => {
  const cell = {x: 100, y: 50, width: 200, height: 200};
  const wide = containRect({width: 400, height: 100}, cell);
  assert.deepEqual([wide.width, wide.height], [200, 50]);
  assert.deepEqual([wide.x, wide.y], [100, 50 + 75], 'centred vertically in the cell');
  const small = containRect({width: 40, height: 20}, cell);
  assert.deepEqual([small.width, small.height], [40, 20], 'a small image is not blown up');
  assert.deepEqual([small.x, small.y], [180, 140]);
});

test('ZIP entry names stay unique so nothing overwrites a sibling', () => {
  const used = new Set();
  const names = ['photo.jpg', 'photo.jpg', 'photo.jpg', 'other.png'].map(n => context.GWZip.uniqueName(n, used));
  assert.deepEqual(names, ['photo.jpg', 'photo-2.jpg', 'photo-3.jpg', 'other.png']);
  assert.equal(context.GWZip.crc32(new Uint8Array([1, 2, 3, 4])), 0xb63cfbcd);
});
