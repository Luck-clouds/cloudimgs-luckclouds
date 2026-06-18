const fs = require('fs-extra');
const path = require('path');
const config = require('../../config');
const imageRepository = require('../db/imageRepository');
const { getFileMetadata } = require('./metadataService');
const { CACHE_DIR_NAME, safeJoin } = require('../utils/fileUtils');
const { createHashFields, computeAssetHash } = require('./assetHashService');
const {
  SOURCE_TYPE_NATIVE,
  SOURCE_TYPE_EASYIMAGE,
  getActiveMediaRoot,
  isEasyImageSourceEnabled,
  resolveMediaPathFromRecord,
} = require('./mediaSourceService');

const STORAGE_PATH = config.storage.path;
const CONFIG_DIR_NAME = 'config';
const TRASH_DIR_NAME = '.trash';
const LEGACY_CACHE_PATH = path.join(STORAGE_PATH, CACHE_DIR_NAME, 'img_metadata.json');
const EXTERNAL_SKIP_DIRS = new Set(['cache', 'recycle', 'suspic']);

async function migrateFromLegacyJson() {
  if (imageRepository.count() > 0) {
    console.log('Database not empty, skipping JSON migration.');
    return;
  }

  if (!await fs.pathExists(LEGACY_CACHE_PATH)) {
    console.log('No legacy metadata file found.');
    return;
  }

  console.log('Migrating from legacy img_metadata.json...');
  try {
    const rawData = await fs.readJson(LEGACY_CACHE_PATH);
    const imagesToInsert = [];
    const items = Array.isArray(rawData) ? rawData : Object.values(rawData);

    for (const item of items) {
      const metaJson = {};
      if (item.lat && item.lng) {
        metaJson.gps = { lat: item.lat, lng: item.lng };
      }
      if (item.date) {
        metaJson.date = item.date;
      }

      imagesToInsert.push({
        filename: item.filename,
        rel_path: item.relPath,
        ...createHashFields(null),
        source_type: SOURCE_TYPE_NATIVE,
        source_rel_path: item.relPath,
        source_abs_path: safeJoin(STORAGE_PATH, item.relPath),
        source_mtime: item.lastModified || 0,
        source_size: 0,
        is_external: 0,
        size: 0,
        mtime: item.lastModified || 0,
        upload_time: item.date || new Date().toISOString(),
        width: null,
        height: null,
        orientation: item.orientation,
        thumbhash: item.thumbhash,
        meta_json: JSON.stringify(metaJson),
      });
    }

    if (imagesToInsert.length > 0) {
      imageRepository.insertMany(imagesToInsert);
      console.log(`Migrated ${imagesToInsert.length} images from JSON.`);
    }
  } catch (e) {
    console.error('Migration failed:', e);
  }
}

function shouldIncludeMediaFile(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  return config.upload.allowedExtensions.includes(ext);
}

function shouldSkipDirectory(dirName, sourceType) {
  if (!dirName || dirName.startsWith('.')) return true;
  if (sourceType === SOURCE_TYPE_NATIVE) {
    return dirName === CACHE_DIR_NAME || dirName === CONFIG_DIR_NAME || dirName === TRASH_DIR_NAME;
  }
  return EXTERNAL_SKIP_DIRS.has(dirName.toLowerCase());
}

async function getAllFiles(dir, options = {}) {
  const { rootPath, sourceType } = options;
  const absDir = safeJoin(rootPath, dir);
  let results = [];

  try {
    const files = await fs.readdir(absDir);
    for (const file of files) {
      const filePath = path.join(absDir, file);
      const relPath = path.join(dir, file).replace(/\\/g, '/');
      const stat = await fs.stat(filePath);

      if (stat.isDirectory()) {
        if (shouldSkipDirectory(file, sourceType)) continue;
        results = results.concat(await getAllFiles(relPath, options));
        continue;
      }

      if (!shouldIncludeMediaFile(file)) continue;
      results.push({ relPath, filePath, stat });
    }
  } catch (e) {
    // ignore
  }

  return results;
}

function buildIndexedRecord(file, metadata, sourceType, hashFields, existing = null) {
  const isExternal = sourceType === SOURCE_TYPE_EASYIMAGE;
  return {
    id: existing?.id,
    filename: path.basename(file.relPath),
    rel_path: file.relPath,
    ...hashFields,
    source_type: sourceType,
    source_rel_path: file.relPath,
    source_abs_path: file.filePath,
    source_mtime: file.stat.mtimeMs,
    source_size: file.stat.size,
    is_external: isExternal ? 1 : 0,
    ...metadata,
  };
}

function hasUsableHash(assetHash) {
  return typeof assetHash === 'string'
    && assetHash.trim() !== ''
    && assetHash !== 'null'
    && assetHash !== 'undefined';
}

async function buildHashFieldsForFile(file, existing, options = {}) {
  const diskMtime = file.stat.mtimeMs;
  const diskSize = file.stat.size;
  const existingMtime = existing?.source_mtime || existing?.mtime || 0;
  const existingSize = existing?.source_size || existing?.size || 0;
  const hasHash = hasUsableHash(existing?.asset_hash);
  const contentChanged = Math.abs(existingMtime - diskMtime) > 1000 || existingSize !== diskSize;

  if (hasHash && !contentChanged) {
    return {
      asset_hash: existing.asset_hash,
      hash_version: existing.hash_version,
      hash_status: existing.hash_status || 'ready',
      hash_generated_at: existing.hash_generated_at,
      computed: false,
    };
  }

  const assetHash = await computeAssetHash(file.filePath);
  return {
    ...createHashFields(assetHash),
    computed: true,
  };
}

async function backfillMissingHashes(sourceType, hashedPaths, result) {
  const entries = imageRepository.getSyncEntriesBySource(sourceType);

  for (const entry of entries) {
    if (hashedPaths.has(entry.rel_path)) continue;
    if (hasUsableHash(entry.asset_hash)) continue;

    const filePath = resolveMediaPathFromRecord(entry);
    if (!filePath || !await fs.pathExists(filePath)) {
      continue;
    }

    const stat = await fs.stat(filePath);
    const metadata = await getFileMetadata(filePath, entry.rel_path, stat);
    const hashFields = createHashFields(await computeAssetHash(filePath));

    // 兜底阶段专门修复“索引已存在但历史上没有哈希”的老数据。
    imageRepository.updateById({
      ...entry,
      ...metadata,
      ...hashFields,
      id: entry.id,
      source_mtime: stat.mtimeMs,
      source_size: stat.size,
      mtime: metadata.mtime,
      size: metadata.size,
    });

    hashedPaths.add(entry.rel_path);
    result.hashed++;
    result.updated++;
  }
}

async function syncSourceFileSystem(options = {}) {
  const {
    sourceType = isEasyImageSourceEnabled() ? SOURCE_TYPE_EASYIMAGE : SOURCE_TYPE_NATIVE,
    rootPath = getActiveMediaRoot(),
    fullRebuild = false,
  } = options;

  console.log(`Starting ${sourceType} sync from ${rootPath}...`);
  if (!await fs.pathExists(rootPath)) {
    throw new Error(`Source path not found: ${rootPath}`);
  }

  const diskFiles = await getAllFiles('', { rootPath, sourceType });
  const dbSyncEntries = imageRepository.getSyncEntriesBySource(sourceType);
  const diskMap = new Map(diskFiles.map((file) => [file.relPath, file]));
  const dbMap = new Map(dbSyncEntries.map((item) => [item.rel_path, item]));
  const remappedOldPaths = new Set();
  const hashedPaths = new Set();

  const result = {
    sourceType,
    added: 0,
    updated: 0,
    removed: 0,
    moved: 0,
    hashed: 0,
    scanned: diskFiles.length,
    statsRebuilt: 0,
    fullRebuild,
  };

  for (const file of diskFiles) {
    const existing = dbMap.get(file.relPath);
    const hashFields = await buildHashFieldsForFile(file, existing, { fullRebuild });
    const metadataNeeded = fullRebuild || !existing
      || hashFields.computed
      || Math.abs((existing?.source_mtime || existing?.mtime || 0) - file.stat.mtimeMs) > 1000
      || (existing?.source_size || existing?.size || 0) !== file.stat.size;

    const metadata = metadataNeeded
      ? await getFileMetadata(file.filePath, file.relPath, file.stat)
      : {
        size: existing.size,
        mtime: existing.mtime,
        upload_time: existing.upload_time,
        width: existing.width,
        height: existing.height,
        orientation: existing.orientation,
        thumbhash: existing.thumbhash,
        meta_json: existing.meta_json,
      };

    if (hashFields.computed) {
      hashedPaths.add(file.relPath);
      result.hashed++;
    }

    if (!existing) {
      const record = buildIndexedRecord(file, metadata, sourceType, hashFields);
      const hashMatch = record.asset_hash ? imageRepository.getByAssetHash(record.asset_hash) : null;

      if (hashMatch && hashMatch.rel_path !== file.relPath) {
        const oldPath = resolveMediaPathFromRecord(hashMatch);
        const oldStillExists = oldPath ? await fs.pathExists(oldPath) : false;

        // 系统外改名/移动时，用内容哈希锁定旧记录并直接更新路径，避免断开标签关系。
        if (!oldStillExists) {
          imageRepository.updateById({
            ...hashMatch,
            ...record,
            id: hashMatch.id,
          });
          remappedOldPaths.add(hashMatch.rel_path);
          result.moved++;
          continue;
        }
      }

      imageRepository.add(record);
      result.added++;
      continue;
    }

    if (metadataNeeded || fullRebuild) {
      imageRepository.update(buildIndexedRecord(file, metadata, sourceType, hashFields, existing));
      result.updated++;
    }

    await new Promise((resolve) => setTimeout(resolve, sourceType === SOURCE_TYPE_EASYIMAGE ? 10 : 20));
  }

  for (const img of dbSyncEntries) {
    if (remappedOldPaths.has(img.rel_path)) {
      continue;
    }
    if (!diskMap.has(img.rel_path)) {
      console.log(`Removing missing ${sourceType} file from DB: ${img.rel_path}`);
      imageRepository.delete(img.rel_path);
      result.removed++;
    }
  }

  if (fullRebuild) {
    await backfillMissingHashes(sourceType, hashedPaths, result);
  }

  if (sourceType === SOURCE_TYPE_EASYIMAGE) {
    result.statsRebuilt = imageRepository.rebuildUploadStats();
  }

  console.log(`${sourceType} sync completed.`);
  return result;
}

async function syncFileSystem(options = {}) {
  if (isEasyImageSourceEnabled()) {
    return syncSourceFileSystem({
      sourceType: SOURCE_TYPE_EASYIMAGE,
      rootPath: getActiveMediaRoot(),
      fullRebuild: Boolean(options.fullRebuild),
    });
  }

  return syncSourceFileSystem({
    sourceType: SOURCE_TYPE_NATIVE,
    rootPath: path.resolve(STORAGE_PATH),
    fullRebuild: Boolean(options.fullRebuild),
  });
}

async function syncAllConfiguredSources(options = {}) {
  const fullRebuild = Boolean(options.fullRebuild);
  const results = [];

  const nativeResult = await syncSourceFileSystem({
    sourceType: SOURCE_TYPE_NATIVE,
    rootPath: path.resolve(STORAGE_PATH),
    fullRebuild,
  });
  results.push(nativeResult);

  if (isEasyImageSourceEnabled()) {
    const externalResult = await syncSourceFileSystem({
      sourceType: SOURCE_TYPE_EASYIMAGE,
      rootPath: getActiveMediaRoot(),
      fullRebuild,
    });
    results.push(externalResult);
  }

  return {
    mode: 'all-configured-sources',
    fullRebuild,
    results,
    added: results.reduce((sum, item) => sum + (item.added || 0), 0),
    updated: results.reduce((sum, item) => sum + (item.updated || 0), 0),
    removed: results.reduce((sum, item) => sum + (item.removed || 0), 0),
    moved: results.reduce((sum, item) => sum + (item.moved || 0), 0),
    hashed: results.reduce((sum, item) => sum + (item.hashed || 0), 0),
    scanned: results.reduce((sum, item) => sum + (item.scanned || 0), 0),
    statsRebuilt: results.reduce((sum, item) => sum + (item.statsRebuilt || 0), 0),
  };
}

module.exports = {
  migrateFromLegacyJson,
  syncFileSystem,
  syncAllConfiguredSources,
};
