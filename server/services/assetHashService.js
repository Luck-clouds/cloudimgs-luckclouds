const crypto = require('crypto');
const fs = require('fs');

const HASH_VERSION = 'sha256-25-v1';
const HASH_PREFIX_LENGTH = 25;

function createHashFields(assetHash) {
  const now = Date.now();
  if (!assetHash) {
    return {
      asset_hash: null,
      hash_version: HASH_VERSION,
      hash_status: 'missing',
      hash_generated_at: null,
    };
  }

  return {
    asset_hash: assetHash,
    hash_version: HASH_VERSION,
    hash_status: 'ready',
    hash_generated_at: now,
  };
}

async function computeAssetHash(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);

    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => {
      const digest = hash.digest('hex').slice(0, HASH_PREFIX_LENGTH);
      resolve(digest);
    });
  });
}

module.exports = {
  HASH_VERSION,
  HASH_PREFIX_LENGTH,
  createHashFields,
  computeAssetHash,
};
