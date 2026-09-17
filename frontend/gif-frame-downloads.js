/* PNG exports and a standards-compliant, uncompressed ZIP (PNGs are compressed already). */
(function () {
  function crc32(bytes) {
    let crc = -1;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return (crc ^ -1) >>> 0;
  }
  function zip(entries) {
    const parts = [], directory = []; let offset = 0, directorySize = 0;
    for (const entry of entries) {
      const name = new TextEncoder().encode(entry.name), crc = crc32(entry.bytes);
      const local = new Uint8Array(30 + name.length), l = new DataView(local.buffer);
      l.setUint32(0, 0x04034b50, true); l.setUint16(4, 20, true); l.setUint16(12, 33, true);
      l.setUint32(14, crc, true); l.setUint32(18, entry.bytes.length, true); l.setUint32(22, entry.bytes.length, true);
      l.setUint16(26, name.length, true); local.set(name, 30);
      parts.push(local, entry.bytes);
      const central = new Uint8Array(46 + name.length), c = new DataView(central.buffer);
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(14, 33, true);
      c.setUint32(16, crc, true); c.setUint32(20, entry.bytes.length, true); c.setUint32(24, entry.bytes.length, true);
      c.setUint16(28, name.length, true); c.setUint32(42, offset, true); central.set(name, 46);
      directory.push(central); directorySize += central.length; offset += local.length + entry.bytes.length;
    }
    const end = new Uint8Array(22), view = new DataView(end.buffer);
    view.setUint32(0, 0x06054b50, true); view.setUint16(8, entries.length, true); view.setUint16(10, entries.length, true);
    view.setUint32(12, directorySize, true); view.setUint32(16, offset, true);
    return new Blob([...parts, ...directory, end], {type:'application/zip'});
  }
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
