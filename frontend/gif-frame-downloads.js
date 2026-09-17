/* PNG exports for extracted GIF frames, bundled with the shared ZIP writer. */
(function () {
  const zip = GWZip.zip;
  window.GWFrameDownloads = {zip, async render(result, active, progress) {
    const canvas = document.createElement('canvas'); canvas.width = result.width; canvas.height = result.height;
    const ctx = canvas.getContext('2d'), entries = []; let total = 0;
    for (let i = 0; i < result.frames.length; i++) {
      if (!active()) throw new Error('cancelled');
      const frame = result.frames[i];
      ctx.putImageData(new ImageData(new Uint8ClampedArray(frame.pixels), result.width, result.height), 0, 0);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      if (!blob || blob.type !== 'image/png') throw new Error('This browser could not create a PNG.');
      total += blob.size;
      if (total > 96 * 1024 * 1024) throw new Error('PNG exports exceed the memory limit. Select fewer frames.');
      const bytes = new Uint8Array(await blob.arrayBuffer());
      entries.push({name:'frame-' + String(frame.number).padStart(5, '0') + '.png', bytes, blob, number:frame.number, delay:frame.delay});
      progress(i + 1, result.frames.length);
    }
    if (!active()) throw new Error('cancelled');
    return {entries, blob:entries.length === 1 ? entries[0].blob : zip(entries)};
  }};
})();
