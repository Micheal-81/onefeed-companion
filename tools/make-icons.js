// Regenerates deploy/extension/icons/*.png. A 16x16 pixel glyph upscaled with
// nearest neighbour, so the icon stays crisp at every size and no image editor
// or npm package is ever involved. Run: node tools/make-icons.js

const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

// The glyph: a gold "O" ring (OneFeed) holding three staggered feed lines.
// O = gold, # = light text colour, . = the dark background.
const GRID = [
  '................',
  '................',
  '....OOOOOOOO....',
  '..OOOOOOOOOOOO..',
  '.OOOOOOOOOOOOOO.',
  '.OOO........OOO.',
  '.OOO..####..OOO.',
  '.OOO........OOO.',
  '.OOO..###...OOO.',
  '.OOO........OOO.',
  '.OOO..#####.OOO.',
  '.OOO........OOO.',
  '.OOOOOOOOOOOOOO.',
  '..OOOOOOOOOOOO..',
  '....OOOOOOOO....',
  '................',
];

const PALETTE = {
  O: [0xF0, 0xB4, 0x3F, 0xFF], // --secondary gold
  '#': [0xd8, 0xde, 0xd3, 0xFF], // --text
  '.': [0x0c, 0x0c, 0x0c, 0xFF], // --dark-primary
};

// minimal PNG writer
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, grid) {
  const scale = size / grid.length;
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0; // filter: none
    const srcRow = GRID[Math.floor(y / scale)];
    for (let x = 0; x < size; x++) {
      const px = PALETTE[srcRow[Math.floor(x / scale)]];
      raw.set(px, y * stride + 1 + x * 4);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const outDir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(outDir, { recursive: true });
for (const size of [16, 48, 128]) {
  const file = path.join(outDir, 'icon' + size + '.png');
  fs.writeFileSync(file, png(size, GRID));
  console.log('wrote', file);
}
