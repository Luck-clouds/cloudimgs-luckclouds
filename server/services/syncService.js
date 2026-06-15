const fs = require('fs-extra');
const path = require('path');
const config = require('../../config');
const imageRepository = require('../db/imageRepository');
const { getFileMetadata } = require('./metadataService');
const { CACHE_DIR_NAME, safeJoin } = require('../utils/fileUtils');
const {
    SOURCE_TYPE_NATIVE,
    SOURCE_TYPE_EASYIMAGE,
    getActiveMediaRoot,
    getActiveSourceType,
    isEasyImageSourceEnabled,
} = require('./mediaSourceService');

const STORAGE_PATH = config.storage.path;
const CONFIG_DIR_NAME = "config";
const TRASH_DIR_NAME = ".trash";
const LEGACY_CACHE_PATH = path.join(STORAGE_PATH, CACHE_DIR_NAME, "img_metadata.json");
const EXTERNAL_SKIP_DIRS = new Set(['cache', 'recycle', 'suspic']);

async function migrateFromLegacyJson() {
    if (imageRepository.count() > 0) {
        console.log("Database not empty, skipping JSON migration.");
        return;
    }

    if (!await fs.pathExists(LEGACY_CACHE_PATH)) {
        console.log("No legacy metadata file found.");
        return;
    }

    console.log("Migrating from legacy img_metadata.json...");
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
                meta_json: JSON.stringify(metaJson)
            });
        }

        if (imagesToInsert.length > 0) {
            imageRepository.insertMany(imagesToInsert);
            console.log(`Migrated ${imagesToInsert.length} images from JSON.`);
        }
    } catch (e) {
        console.error("Migration failed:", e);
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
            const relPath = path.join(dir, file).replace(/\\/g, "/");
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

function buildIndexedRecord(file, metadata, sourceType) {
    const isExternal = sourceType === SOURCE_TYPE_EASYIMAGE;
    return {
        filename: path.basename(file.relPath),
        rel_path: file.relPath,
        source_type: sourceType,
        source_rel_path: file.relPath,
        source_abs_path: file.filePath,
        source_mtime: file.stat.mtime.getTime(),
        source_size: file.stat.size,
        is_external: isExternal ? 1 : 0,
        ...metadata,
    };
}

async function syncNativeFileSystem() {
    console.log("Starting native file system sync...");
    const diskFiles = await getAllFiles("", {
        rootPath: path.resolve(STORAGE_PATH),
        sourceType: SOURCE_TYPE_NATIVE,
    });
    const dbSyncEntries = imageRepository.getSyncEntriesBySource(SOURCE_TYPE_NATIVE);

    const diskMap = new Map(diskFiles.map(f => [f.relPath, f]));
    const dbMap = new Map(dbSyncEntries.map(i => [i.rel_path, i]));
    const result = { sourceType: SOURCE_TYPE_NATIVE, added: 0, updated: 0, removed: 0, scanned: diskFiles.length, statsRebuilt: 0 };

    for (const file of diskFiles) {
        const dbEntry = dbMap.get(file.relPath);

        if (!dbEntry) {
            try {
                const metadata = await getFileMetadata(file.filePath, file.relPath, file.stat);
                imageRepository.add(buildIndexedRecord(file, metadata, SOURCE_TYPE_NATIVE));
                result.added++;
            } catch (e) {
                console.error(`Failed to sync file ${file.relPath}`, e);
            }
            await new Promise(r => setTimeout(r, 50));
            continue;
        }

        if (Math.abs(dbEntry.mtime - file.stat.mtime.getTime()) > 1000) {
            console.log(`Updating modified file: ${file.relPath}`);
            try {
                const metadata = await getFileMetadata(file.filePath, file.relPath, file.stat);
                imageRepository.update(buildIndexedRecord(file, metadata, SOURCE_TYPE_NATIVE));
                result.updated++;
            } catch (e) {
                console.error(`Failed to update ${file.relPath}`, e);
            }
            await new Promise(r => setTimeout(r, 50));
        }
    }

    for (const img of dbSyncEntries) {
        if (!diskMap.has(img.rel_path)) {
            console.log(`Removing missing file from DB: ${img.rel_path}`);
            imageRepository.delete(img.rel_path);
            result.removed++;
        }
    }

    console.log("Native sync completed.");
    return result;
}

async function syncEasyImageFileSystem(options = {}) {
    const { fullRebuild = false } = options;
    const sourceRoot = getActiveMediaRoot();

    console.log(`Starting EasyImages sync from ${sourceRoot}...`);
    if (!await fs.pathExists(sourceRoot)) {
        throw new Error(`EasyImages source path not found: ${sourceRoot}`);
    }

    const diskFiles = await getAllFiles("", {
        rootPath: sourceRoot,
        sourceType: SOURCE_TYPE_EASYIMAGE,
    });
    const dbSyncEntries = imageRepository.getSyncEntriesBySource(SOURCE_TYPE_EASYIMAGE);

    const diskMap = new Map(diskFiles.map(f => [f.relPath, f]));
    const dbMap = new Map(dbSyncEntries.map(i => [i.rel_path, i]));
    const result = {
        sourceType: SOURCE_TYPE_EASYIMAGE,
        added: 0,
        updated: 0,
        removed: 0,
        scanned: diskFiles.length,
        statsRebuilt: 0,
        fullRebuild,
    };

    for (const file of diskFiles) {
        const dbEntry = dbMap.get(file.relPath);
        const shouldRefreshMetadata = fullRebuild || !dbEntry
            || Math.abs((dbEntry.source_mtime || dbEntry.mtime || 0) - file.stat.mtime.getTime()) > 1000
            || (dbEntry.source_size || dbEntry.size || 0) !== file.stat.size;

        if (!shouldRefreshMetadata) continue;

        try {
            const metadata = await getFileMetadata(file.filePath, file.relPath, file.stat);
            imageRepository.add(buildIndexedRecord(file, metadata, SOURCE_TYPE_EASYIMAGE));
            if (dbEntry) result.updated++;
            else result.added++;
        } catch (e) {
            console.error(`Failed to sync external file ${file.relPath}`, e);
        }

        await new Promise(r => setTimeout(r, 25));
    }

    for (const img of dbSyncEntries) {
        if (!diskMap.has(img.rel_path)) {
            // 外部源文件丢失时直接清理索引，避免前端持续看到无效媒体。
            console.log(`Removing missing external file from DB: ${img.rel_path}`);
            imageRepository.delete(img.rel_path);
            result.removed++;
        }
    }

    result.statsRebuilt = imageRepository.rebuildUploadStats();
    console.log("EasyImages sync completed.");
    return result;
}

async function syncFileSystem(options = {}) {
    if (isEasyImageSourceEnabled()) {
        return syncEasyImageFileSystem(options);
    }

    return syncNativeFileSystem();
}

module.exports = {
    migrateFromLegacyJson,
    syncFileSystem,
};
