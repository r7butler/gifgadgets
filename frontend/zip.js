/* Standards-compliant, uncompressed ZIP writer.
   Stored (method 0) on purpose: PNG, JPEG and WebP payloads are already
   compressed, so deflating them costs time and saves almost nothing. */
(function (root) {
  'use strict';
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
    return new Blob([...parts, ...directory, end], {type: 'application/zip'});
  }
  // A ZIP entry name must be unique, so repeated basenames get a numeric suffix.
  function uniqueName(name, used) {
    if (!used.has(name)) { used.add(name); return name; }
    const dot = name.lastIndexOf('.'), stem = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : '';
    for (let n = 2; ; n++) {
      const candidate = stem + '-' + n + ext;
      if (!used.has(candidate)) { used.add(candidate); return candidate; }
    }
  }
  root.GWZip = {zip, crc32, uniqueName};
})(typeof self !== 'undefined' ? self : this);
