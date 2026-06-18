const fs = require('fs');
const path = require('path');

function bufferStartsWith(buffer, bytes) {
  if (!buffer || buffer.length < bytes.length) return false;
  return bytes.every((byte, index) => buffer[index] === byte);
}

function isSvgBuffer(buffer) {
  const text = buffer.toString('utf8').trimStart().toLowerCase();
  return text.startsWith('<svg') || (text.startsWith('<?xml') && text.includes('<svg'));
}

function hasFtypBrand(buffer, brands) {
  if (!buffer || buffer.length < 12) return false;
  const boxType = buffer.slice(4, 8).toString('ascii');
  const brand = buffer.slice(8, 12).toString('ascii');
  return boxType === 'ftyp' && brands.includes(brand);
}

function isValidMediaBuffer(buffer, ext) {
  switch (ext) {
    case '.jpg':
    case '.jpeg':
      return bufferStartsWith(buffer, [0xff, 0xd8, 0xff]);
    case '.png':
      return bufferStartsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case '.gif': {
      const signature = buffer.slice(0, 6).toString('ascii');
      return signature === 'GIF87a' || signature === 'GIF89a';
    }
    case '.webp':
      return buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP';
    case '.bmp':
      return buffer.slice(0, 2).toString('ascii') === 'BM';
    case '.avif':
      return hasFtypBrand(buffer, ['avif', 'avis']);
    case '.mp4':
      return buffer.length >= 12 && buffer.slice(4, 8).toString('ascii') === 'ftyp';
    case '.webm':
      return bufferStartsWith(buffer, [0x1a, 0x45, 0xdf, 0xa3]);
    case '.svg':
      return isSvgBuffer(buffer);
    default:
      return true;
  }
}

async function validateStoredMediaFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const probeSize = ext === '.svg' ? 2048 : 64;
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(probeSize);
    const { bytesRead } = await handle.read(buffer, 0, probeSize, 0);
    return isValidMediaBuffer(buffer.slice(0, bytesRead), ext);
  } finally {
    await handle.close();
  }
}

module.exports = {
  validateStoredMediaFile,
};
