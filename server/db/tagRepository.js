const db = require('./database');

const TAG_COLOR_PALETTE = [
  '#1d4ed8',
  '#047857',
  '#334155',
  '#c2410c',
  '#7c3aed',
  '#be123c',
  '#0f766e',
  '#b45309',
  '#4338ca',
  '#15803d',
];

function normalizeTagName(name) {
  return String(name || '').trim().toLowerCase();
}

function pickRandomTagColor() {
  return TAG_COLOR_PALETTE[Math.floor(Math.random() * TAG_COLOR_PALETTE.length)];
}

const getTagByNormalizedName = db.prepare('SELECT * FROM tags WHERE normalized_name = ?');
const insertTag = db.prepare(`
  INSERT INTO tags (name, normalized_name, color, created_at, updated_at)
  VALUES (@name, @normalized_name, @color, @created_at, @updated_at)
`);
const getAllTagsQuery = db.prepare(`
  SELECT
    t.id,
    t.name,
    t.color,
    t.created_at,
    t.updated_at,
    COUNT(DISTINCT CASE WHEN i.id IS NOT NULL THEN it.asset_hash END) AS usageCount
  FROM tags t
  LEFT JOIN image_tags it ON it.tag_id = t.id
  LEFT JOIN images i ON i.asset_hash = it.asset_hash
  GROUP BY t.id
  ORDER BY usageCount DESC, t.name ASC
`);
const getTagsByAssetHashQuery = db.prepare(`
  SELECT t.id, t.name, t.color, t.created_at, t.updated_at
  FROM image_tags it
  INNER JOIN tags t ON t.id = it.tag_id
  WHERE it.asset_hash = ?
  ORDER BY t.name ASC
`);
const attachTagToAssetQuery = db.prepare(`
  INSERT OR IGNORE INTO image_tags (asset_hash, tag_id, created_at)
  VALUES (?, ?, ?)
`);
const removeTagFromAssetQuery = db.prepare('DELETE FROM image_tags WHERE asset_hash = ? AND tag_id = ?');
const removeRelationsByTagIdQuery = db.prepare('DELETE FROM image_tags WHERE tag_id = ?');
const deleteTagQuery = db.prepare('DELETE FROM tags WHERE id = ?');
const getAllAssetHashesQuery = db.prepare(`
  SELECT DISTINCT asset_hash
  FROM images
  WHERE asset_hash IS NOT NULL AND asset_hash != ''
`);
const hasTagByNormalizedNameQuery = db.prepare('SELECT 1 FROM tags WHERE normalized_name = ? LIMIT 1');

function createOrGetTag(name) {
  const trimmedName = String(name || '').trim();
  const normalized = normalizeTagName(trimmedName);
  if (!trimmedName || !normalized) return null;

  const existing = getTagByNormalizedName.get(normalized);
  if (existing) return existing;

  const now = Date.now();
  const result = insertTag.run({
    name: trimmedName,
    normalized_name: normalized,
    color: pickRandomTagColor(),
    created_at: now,
    updated_at: now,
  });
  return db.prepare('SELECT * FROM tags WHERE id = ?').get(result.lastInsertRowid);
}

const attachTagsTransaction = db.transaction((assetHash, tagNames) => {
  const attached = [];
  for (const tagName of tagNames) {
    const tag = createOrGetTag(tagName);
    if (!tag) continue;
    attachTagToAssetQuery.run(assetHash, tag.id, Date.now());
    attached.push(tag);
  }
  return attached;
});

const deleteTagTransaction = db.transaction((tagId) => {
  removeRelationsByTagIdQuery.run(tagId);
  deleteTagQuery.run(tagId);
});

function getAssetHashesByTagNames(tagNames) {
  const normalizedNames = [...new Set((tagNames || []).map(normalizeTagName).filter(Boolean))];
  if (normalizedNames.length === 0) return [];

  const placeholders = normalizedNames.map(() => '?').join(', ');
  const sql = `
    SELECT it.asset_hash
    FROM image_tags it
    INNER JOIN tags t ON t.id = it.tag_id
    WHERE t.normalized_name IN (${placeholders})
    GROUP BY it.asset_hash
    HAVING COUNT(DISTINCT t.normalized_name) = ?
  `;
  const rows = db.prepare(sql).all(...normalizedNames, normalizedNames.length);
  return rows.map((row) => row.asset_hash);
}

function getAssetHashesWithAnyTags(tagNames) {
  const normalizedNames = [...new Set((tagNames || []).map(normalizeTagName).filter(Boolean))];
  if (normalizedNames.length === 0) return [];

  const placeholders = normalizedNames.map(() => '?').join(', ');
  const sql = `
    SELECT DISTINCT it.asset_hash
    FROM image_tags it
    INNER JOIN tags t ON t.id = it.tag_id
    WHERE t.normalized_name IN (${placeholders})
  `;
  return db.prepare(sql).all(...normalizedNames).map((row) => row.asset_hash);
}

function searchAssetHashesByParsedExpression(parsedExpression) {
  const groups = Array.isArray(parsedExpression?.groups) ? parsedExpression.groups : [];
  if (groups.length === 0) return [];

  const allHashes = new Set(getAllAssetHashesQuery.all().map((row) => row.asset_hash).filter(Boolean));
  const matchedHashes = new Set();

  for (const group of groups) {
    const include = [...new Set((group?.include || []).map(normalizeTagName).filter(Boolean))];
    const exclude = [...new Set((group?.exclude || []).map(normalizeTagName).filter(Boolean))];

    if (include.length === 0 && exclude.length === 0) {
      continue;
    }

    if (include.some((name) => exclude.includes(name))) {
      continue;
    }

    const candidateSet = include.length > 0
      ? new Set(getAssetHashesByTagNames(include))
      : new Set(allHashes);

    if (candidateSet.size === 0) {
      continue;
    }

    if (exclude.length > 0) {
      const excludedHashes = new Set(getAssetHashesWithAnyTags(exclude));
      for (const hash of excludedHashes) {
        candidateSet.delete(hash);
      }
    }

    for (const hash of candidateSet) {
      matchedHashes.add(hash);
    }
  }

  return [...matchedHashes];
}

module.exports = {
  normalizeTagName,
  getOrCreate: (name) => createOrGetTag(name),
  list: () => getAllTagsQuery.all(),
  hasTagName: (name) => Boolean(hasTagByNormalizedNameQuery.get(normalizeTagName(name))),
  getTagsByAssetHash: (assetHash) => getTagsByAssetHashQuery.all(assetHash),
  attachTagsToAssetHash: (assetHash, tagNames) => attachTagsTransaction(assetHash, tagNames),
  removeTagFromAssetHash: (assetHash, tagId) => removeTagFromAssetQuery.run(assetHash, tagId),
  deleteTag: (tagId) => deleteTagTransaction(tagId),
  getAssetHashesByTagNames,
  getAssetHashesWithAnyTags,
  searchAssetHashesByParsedExpression,
};
