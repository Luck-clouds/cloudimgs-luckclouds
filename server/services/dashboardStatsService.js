const fs = require('fs/promises');
const path = require('path');
const { getActiveMediaRoot, getActiveSourceType, SOURCE_TYPE_EASYIMAGE } = require('./mediaSourceService');

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg', '.avif']);
const EXTERNAL_SKIP_DIRS = new Set(['cache', 'recycle', 'suspic']);
const NATIVE_SKIP_DIRS = new Set(['.cache', '.trash', 'config']);

function shouldSkipDirectory(name) {
    if (!name || name.startsWith('.')) return true;
    if (getActiveSourceType() === SOURCE_TYPE_EASYIMAGE) {
        return EXTERNAL_SKIP_DIRS.has(name.toLowerCase());
    }
    return NATIVE_SKIP_DIRS.has(name);
}

async function collectMediaRootStats(rootPath) {
    let imageCount = 0;
    let imageBytes = 0;
    let otherBytes = 0;
    const stack = [rootPath];

    // 目录扫描走异步 I/O，避免在主线程里做同步阻塞遍历。
    while (stack.length > 0) {
        const currentDir = stack.pop();
        const entries = await fs.readdir(currentDir, { withFileTypes: true });

        for (const entry of entries) {
            const absPath = path.join(currentDir, entry.name);

            if (entry.isDirectory()) {
                if (!shouldSkipDirectory(entry.name)) {
                    stack.push(absPath);
                }
                continue;
            }

            if (!entry.isFile()) continue;

            const stats = await fs.stat(absPath);
            const ext = path.extname(entry.name).toLowerCase();

            if (IMAGE_EXTENSIONS.has(ext)) {
                imageCount++;
                imageBytes += stats.size;
            } else {
                otherBytes += stats.size;
            }
        }
    }

    return {
        imageCount,
        imageBytes,
        otherBytes,
    };
}

async function getStorageStats(rootPath) {
    try {
        const stat = await fs.statfs(rootPath);
        const totalBytes = Number(stat.blocks) * Number(stat.bsize);
        const usedBytes = (Number(stat.blocks) - Number(stat.bfree)) * Number(stat.bsize);
        const usagePercent = totalBytes > 0 ? Number(((usedBytes / totalBytes) * 100).toFixed(2)) : 0;

        return {
            totalBytes,
            usedBytes,
            usagePercent,
        };
    } catch (error) {
        return {
            totalBytes: 0,
            usedBytes: 0,
            usagePercent: 0,
            error: error.message,
        };
    }
}

async function getDashboardOverviewStats() {
    const rootPath = getActiveMediaRoot();
    const [storage, media] = await Promise.all([
        getStorageStats(rootPath),
        collectMediaRootStats(rootPath),
    ]);

    return {
        rootPath,
        storage,
        media,
    };
}

module.exports = {
    getDashboardOverviewStats,
};
