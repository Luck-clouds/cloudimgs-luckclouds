const db = require('./database');
const { HASH_VERSION } = require('../services/assetHashService');

const insertImage = db.prepare(`
  INSERT INTO images (
    filename, rel_path, asset_hash, hash_version, hash_status, hash_generated_at,
    source_type, source_rel_path, source_abs_path, source_mtime, source_size, is_external,
    size, mtime, upload_time, width, height, orientation, thumbhash, meta_json
  )
  VALUES (
    @filename, @rel_path, @asset_hash, @hash_version, @hash_status, @hash_generated_at,
    @source_type, @source_rel_path, @source_abs_path, @source_mtime, @source_size, @is_external,
    @size, @mtime, @upload_time, @width, @height, @orientation, @thumbhash, @meta_json
  )
`);

const updateImage = db.prepare(`
  UPDATE images
  SET filename = @filename,
      asset_hash = @asset_hash,
      hash_version = @hash_version,
      hash_status = @hash_status,
      hash_generated_at = @hash_generated_at,
      source_type = @source_type,
      source_rel_path = @source_rel_path,
      source_abs_path = @source_abs_path,
      source_mtime = @source_mtime,
      source_size = @source_size,
      is_external = @is_external,
      size = @size,
      mtime = @mtime,
      upload_time = @upload_time,
      width = @width,
      height = @height,
      orientation = @orientation,
      thumbhash = @thumbhash,
      meta_json = @meta_json
  WHERE rel_path = @rel_path
`);

const updateImageById = db.prepare(`
  UPDATE images
  SET filename = @filename,
      rel_path = @rel_path,
      asset_hash = @asset_hash,
      hash_version = @hash_version,
      hash_status = @hash_status,
      hash_generated_at = @hash_generated_at,
      source_type = @source_type,
      source_rel_path = @source_rel_path,
      source_abs_path = @source_abs_path,
      source_mtime = @source_mtime,
      source_size = @source_size,
      is_external = @is_external,
      size = @size,
      mtime = @mtime,
      upload_time = @upload_time,
      width = @width,
      height = @height,
      orientation = @orientation,
      thumbhash = @thumbhash,
      meta_json = @meta_json
  WHERE id = @id
`);

const getImageByPath = db.prepare('SELECT * FROM images WHERE rel_path = ?');
const getImageById = db.prepare('SELECT * FROM images WHERE id = ?');
const getFirstImageByAssetHash = db.prepare('SELECT * FROM images WHERE asset_hash = ? ORDER BY id ASC LIMIT 1');
const getAllImagesByAssetHashQuery = db.prepare('SELECT * FROM images WHERE asset_hash = ? ORDER BY id ASC');
const getAllImagesQuery = db.prepare('SELECT * FROM images ORDER BY upload_time DESC');
const deleteImageByPath = db.prepare('DELETE FROM images WHERE rel_path = ?');
const countImages = db.prepare('SELECT COUNT(*) as count FROM images');
const getImagesByDir = db.prepare("SELECT * FROM images WHERE rel_path LIKE ? || '/%' ORDER BY upload_time DESC");
const getAllSyncEntriesQuery = db.prepare(`
  SELECT id, filename, rel_path, asset_hash, hash_version, hash_status, hash_generated_at,
         mtime, source_type, source_rel_path, source_abs_path, source_mtime, source_size, is_external
  FROM images
`);
const getSyncEntriesBySourceQuery = db.prepare(`
  SELECT id, filename, rel_path, asset_hash, hash_version, hash_status, hash_generated_at,
         mtime, source_type, source_rel_path, source_abs_path, source_mtime, source_size, is_external
  FROM images
  WHERE source_type = ?
`);
const getPreviewsQuery = db.prepare("SELECT * FROM images WHERE rel_path LIKE ? || '/%' ORDER BY upload_time DESC LIMIT ?");
const countImagesByDirQuery = db.prepare("SELECT COUNT(*) as count FROM images WHERE rel_path LIKE ? || '/%'");
const getAllImagesByViewsQuery = db.prepare('SELECT * FROM images ORDER BY views DESC');

const getPaginatedQuery = db.prepare(`
  SELECT * FROM images
  WHERE rel_path LIKE ? || '/%'
    AND (? = '' OR filename LIKE '%' || ? || '%')
  ORDER BY upload_time DESC
  LIMIT ? OFFSET ?
`);

const getPaginatedRootQuery = db.prepare(`
  SELECT * FROM images
  WHERE (? = '' OR filename LIKE '%' || ? || '%')
  ORDER BY upload_time DESC
  LIMIT ? OFFSET ?
`);

const countByDirFilteredQuery = db.prepare(`
  SELECT COUNT(*) as count FROM images
  WHERE rel_path LIKE ? || '/%'
    AND (? = '' OR filename LIKE '%' || ? || '%')
`);

const countRootFilteredQuery = db.prepare(`
  SELECT COUNT(*) as count FROM images
  WHERE (? = '' OR filename LIKE '%' || ? || '%')
`);

const getPaginatedByDirQuery = db.prepare(`
  SELECT * FROM images WHERE rel_path LIKE ? || '/%' ORDER BY upload_time DESC LIMIT ? OFFSET ?
`);
const countByDirQuery = db.prepare("SELECT COUNT(*) as count FROM images WHERE rel_path LIKE ? || '/%'");

const getGpsImagesQuery = db.prepare(`
  SELECT *,
    json_extract(meta_json, '$.gps.lat') as lat,
    json_extract(meta_json, '$.gps.lng') as lng
  FROM images
  WHERE json_extract(meta_json, '$.gps.lat') IS NOT NULL
`);

const getRandomImageQuery = db.prepare('SELECT * FROM images ORDER BY RANDOM() LIMIT 1');
const getRandomImageByDirQuery = db.prepare(`
  SELECT * FROM images WHERE rel_path LIKE ? || '/%' ORDER BY RANDOM() LIMIT 1
`);

function _buildExcludeClause(lockedDirs) {
  if (!lockedDirs || lockedDirs.length === 0) return { sql: '', params: [] };
  const clauses = lockedDirs.map(() => "rel_path NOT LIKE ? || '/%'");
  return { sql: ' AND ' + clauses.join(' AND '), params: lockedDirs };
}

const _excludeStmtCache = Object.create(null);

const getTopImagesExcludeQuery = (lockedDirs, limit) => {
  const key = `top:${lockedDirs.length}`;
  let stmt = _excludeStmtCache[key];
  if (!stmt) {
    const { sql } = _buildExcludeClause(lockedDirs);
    stmt = _excludeStmtCache[key] = db.prepare(`SELECT * FROM images WHERE 1=1${sql} ORDER BY views DESC LIMIT ?`);
  }
  return stmt.all(...lockedDirs, limit);
};

const getRandomExcludeQuery = (lockedDirs) => {
  const key = `random:${lockedDirs.length}`;
  let stmt = _excludeStmtCache[key];
  if (!stmt) {
    const { sql } = _buildExcludeClause(lockedDirs);
    stmt = _excludeStmtCache[key] = db.prepare(`SELECT * FROM images WHERE 1=1${sql} ORDER BY RANDOM() LIMIT 1`);
  }
  return stmt.get(...lockedDirs);
};

const getPaginatedExcludeQuery = (lockedDirs, search, page, pageSize) => {
  const hasSearch = !!search;
  const key = `paginated:${lockedDirs.length}:${hasSearch ? 1 : 0}`;
  let stmt = _excludeStmtCache[key];
  if (!stmt) {
    const { sql } = _buildExcludeClause(lockedDirs);
    const searchClause = hasSearch ? " AND filename LIKE '%' || ? || '%'" : '';
    stmt = _excludeStmtCache[key] = db.prepare(`SELECT * FROM images WHERE 1=1${sql}${searchClause} ORDER BY upload_time DESC LIMIT ? OFFSET ?`);
  }
  const offset = (page - 1) * pageSize;
  const params = [...lockedDirs, ...(hasSearch ? [search] : []), pageSize, offset];
  return stmt.all(...params);
};

const countExcludeQuery = (lockedDirs, search) => {
  const hasSearch = !!search;
  const key = `count:${lockedDirs.length}:${hasSearch ? 1 : 0}`;
  let stmt = _excludeStmtCache[key];
  if (!stmt) {
    const { sql } = _buildExcludeClause(lockedDirs);
    const searchClause = hasSearch ? " AND filename LIKE '%' || ? || '%'" : '';
    stmt = _excludeStmtCache[key] = db.prepare(`SELECT COUNT(*) as count FROM images WHERE 1=1${sql}${searchClause}`);
  }
  const params = [...lockedDirs, ...(hasSearch ? [search] : [])];
  return stmt.get(...params).count;
};

const insertMany = db.transaction((images) => {
  for (const img of images) insertImage.run(normalizeImageRecord(img));
});

const renameImage = db.transaction((oldRelPath, newRelPath, newFilename, extraFields = {}) => {
  const existing = getImageByPath.get(oldRelPath);
  if (!existing) return null;

  const updatedRecord = normalizeImageRecord({
    ...existing,
    ...extraFields,
    id: existing.id,
    rel_path: newRelPath,
    filename: newFilename,
  });

  updateImageById.run(updatedRecord);
  return getImageById.get(existing.id);
});

const incrementViewQuery = db.prepare('UPDATE images SET views = views + 1, last_viewed = @now WHERE rel_path = @relPath');
const recordDailyUploadQuery = db.prepare(`
  INSERT INTO daily_stats (date, uploads_count, uploads_size)
  VALUES (@date, 1, @size)
  ON CONFLICT(date) DO UPDATE SET
    uploads_count = uploads_count + 1,
    uploads_size = uploads_size + @size
`);

const recordDailyViewQuery = db.prepare(`
  INSERT INTO daily_stats (date, views_count, views_size)
  VALUES (@date, 1, @size)
  ON CONFLICT(date) DO UPDATE SET
    views_count = views_count + 1,
    views_size = views_size + @size
`);

const getDailyStatsQuery = db.prepare('SELECT * FROM daily_stats ORDER BY date DESC LIMIT ?');
const getTopImagesQuery = db.prepare('SELECT * FROM images ORDER BY views DESC LIMIT ?');
const resetUploadStatsQuery = db.prepare('UPDATE daily_stats SET uploads_count = 0, uploads_size = 0');
const upsertUploadStatsRowQuery = db.prepare(`
  INSERT INTO daily_stats (date, uploads_count, uploads_size, views_count, views_size)
  VALUES (@date, @uploads_count, @uploads_size, 0, 0)
  ON CONFLICT(date) DO UPDATE SET
    uploads_count = excluded.uploads_count,
    uploads_size = excluded.uploads_size
`);
const cleanupEmptyDailyStatsQuery = db.prepare(`
  DELETE FROM daily_stats
  WHERE uploads_count = 0 AND uploads_size = 0 AND views_count = 0 AND views_size = 0
`);
const aggregateUploadStatsQuery = db.prepare(`
  SELECT substr(upload_time, 1, 10) AS date, COUNT(*) AS uploads_count, COALESCE(SUM(size), 0) AS uploads_size
  FROM images
  WHERE upload_time IS NOT NULL AND upload_time != ''
  GROUP BY substr(upload_time, 1, 10)
`);
const rebuildUploadStatsTransaction = db.transaction(() => {
  resetUploadStatsQuery.run();
  const rows = aggregateUploadStatsQuery.all();
  for (const row of rows) {
    upsertUploadStatsRowQuery.run(row);
  }
  cleanupEmptyDailyStatsQuery.run();
  return rows.length;
});

function normalizeImageRecord(image) {
  const assetHash = image.asset_hash || null;
  const hashStatus = image.hash_status || (assetHash ? 'ready' : 'missing');

  return {
    source_type: image.source_type || 'native',
    source_rel_path: image.source_rel_path || image.rel_path,
    source_abs_path: image.source_abs_path || null,
    source_mtime: image.source_mtime ?? image.mtime ?? null,
    source_size: image.source_size ?? image.size ?? null,
    is_external: image.is_external ?? ((image.source_type && image.source_type !== 'native') ? 1 : 0),
    asset_hash: assetHash,
    hash_version: image.hash_version || HASH_VERSION,
    hash_status: hashStatus,
    hash_generated_at: image.hash_generated_at ?? (assetHash ? Date.now() : null),
    ...image,
  };
}

function getByAssetHashes(assetHashes, options = {}) {
  if (!Array.isArray(assetHashes) || assetHashes.length === 0) {
    return [];
  }

  const uniqueHashes = [...new Set(assetHashes.filter(Boolean))];
  if (uniqueHashes.length === 0) return [];

  const placeholders = uniqueHashes.map(() => '?').join(', ');
  const params = [...uniqueHashes];
  let sql = `SELECT * FROM images WHERE asset_hash IN (${placeholders})`;

  if (options.dir) {
    sql += ' AND rel_path LIKE ?';
    params.push(`${options.dir.replace(/\\/g, '/')}/%`);
  }

  if (options.search) {
    sql += ' AND filename LIKE ?';
    params.push(`%${options.search}%`);
  }

  sql += ' ORDER BY upload_time DESC';
  return db.prepare(sql).all(...params);
}

module.exports = {
  add: (image) => {
    const normalizedImage = normalizeImageRecord(image);
    try {
      return insertImage.run(normalizedImage);
    } catch (e) {
      if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        console.warn(`Image ${normalizedImage.rel_path} already exists in DB. Attempting update.`);
        return updateImage.run(normalizedImage);
      }
      throw e;
    }
  },
  update: (image) => updateImage.run(normalizeImageRecord(image)),
  updateById: (image) => updateImageById.run(normalizeImageRecord(image)),
  rename: (oldRelPath, newRelPath, newFilename, extraFields = {}) => renameImage(oldRelPath, newRelPath, newFilename, extraFields),
  getById: (id) => getImageById.get(id),
  getByPath: (relPath) => getImageByPath.get(relPath),
  getByAssetHash: (assetHash) => getFirstImageByAssetHash.get(assetHash),
  getAllByAssetHash: (assetHash) => getAllImagesByAssetHashQuery.all(assetHash),
  getByAssetHashes,
  getAll: () => getAllImagesQuery.all(),
  getAllSyncEntries: () => getAllSyncEntriesQuery.all(),
  getSyncEntriesBySource: (sourceType) => getSyncEntriesBySourceQuery.all(sourceType),
  getAllByViews: () => getAllImagesByViewsQuery.all(),
  delete: (relPath) => deleteImageByPath.run(relPath),
  count: () => countImages.get().count,
  getByDir: (dir) => {
    if (!dir) return getAllImagesQuery.all();
    return getImagesByDir.all(dir);
  },
  getPreviews: (dir, limit = 3) => getPreviewsQuery.all(dir, limit),
  countByDir: (dir) => countImagesByDirQuery.get(dir).count,
  insertMany,
  getPaginated: (dir, page, pageSize, search = "") => {
    const offset = (page - 1) * pageSize;
    if (dir) {
      return getPaginatedQuery.all(dir + "/", search, search, pageSize, offset);
    }
    return getPaginatedRootQuery.all(search, search, pageSize, offset);
  },
  countPaginated: (dir, search = "") => {
    if (dir) {
      return countByDirFilteredQuery.get(dir + "/", search, search).count;
    }
    return countRootFilteredQuery.get(search, search).count;
  },
  getPaginatedByDir: (dir, page, pageSize) => {
    const offset = (page - 1) * pageSize;
    return getPaginatedByDirQuery.all(dir + "/", pageSize, offset);
  },
  countPaginatedByDir: (dir) => countByDirQuery.get(dir + "/").count,
  getGpsImages: () => getGpsImagesQuery.all(),
  getTopExclude: (lockedDirs, limit) => getTopImagesExcludeQuery(lockedDirs, limit),
  getRandomExclude: (lockedDirs) => getRandomExcludeQuery(lockedDirs),
  getPaginatedExclude: (lockedDirs, search, page, pageSize) => getPaginatedExcludeQuery(lockedDirs, search, page, pageSize),
  countExclude: (lockedDirs, search) => countExcludeQuery(lockedDirs, search),
  getRandom: () => getRandomImageQuery.get(),
  getRandomByDir: (dir) => getRandomImageByDirQuery.get(dir + "/"),
  transaction: (fn) => db.transaction(fn),
  incrementViews: (relPath) => incrementViewQuery.run({ relPath, now: Date.now() }),
  recordUpload: (size) => {
    const date = new Date().toISOString().split('T')[0];
    recordDailyUploadQuery.run({ date, size });
  },
  recordView: (size) => {
    const date = new Date().toISOString().split('T')[0];
    recordDailyViewQuery.run({ date, size });
  },
  getDailyStats: (limit = 30) => getDailyStatsQuery.all(limit),
  getTopImages: (limit = 10) => getTopImagesQuery.all(limit),
  rebuildUploadStats: () => rebuildUploadStatsTransaction(),
};
