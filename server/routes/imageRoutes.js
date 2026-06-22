const express = require('express');
const path = require('path');
const fs = require('fs-extra');
const mime = require('mime-types');
const sharp = require('sharp');
sharp.cache(false);
const imageRepository = require('../db/imageRepository');
const { requirePassword } = require('../middleware/auth');
const { safeJoin, CACHE_DIR_NAME, CONFIG_DIR_NAME, TRASH_DIR_NAME } = require('../utils/fileUtils');
const { formatImageResponse } = require('../utils/urlUtils');
const { getFileMetadata } = require('../services/metadataService');
const {
    getActiveMediaRoot,
    getActiveSourceType,
    resolveMediaPathFromRecord,
    resolveMediaPathFromRelPath,
} = require('../services/mediaSourceService');
const { hasTagOperators, shouldUseTagSearch, searchImageRowsByExpression } = require('../services/tagSearchService');

const router = express.Router();
const EXTERNAL_SKIP_DIRS = new Set(['cache', 'recycle', 'suspic']);

const { isAlbumLocked, verifyAlbumPassword, getAllLockedDirectories } = require('../utils/albumUtils');

function shouldSkipDirectory(dirName) {
    const sourceType = getActiveSourceType();
    if (!dirName || dirName.startsWith('.')) return true;
    if (sourceType === 'easyimage') {
        return EXTERNAL_SKIP_DIRS.has(dirName.toLowerCase());
    }
    return dirName === CACHE_DIR_NAME || dirName === CONFIG_DIR_NAME || dirName === TRASH_DIR_NAME;
}

function getIndexedOrFallbackPath(relPath) {
    const dbImage = imageRepository.getByPath(relPath);
    if (dbImage) {
        return { dbImage, filePath: resolveMediaPathFromRecord(dbImage) };
    }
    return { dbImage: null, filePath: resolveMediaPathFromRelPath(relPath) };
}

// 地图数据
router.get('/map-data', requirePassword, async (req, res) => {
    const lockedDirs = await getAllLockedDirectories();
    const images = imageRepository.getGpsImages();
    const mapData = images.filter(img => {
        if (lockedDirs.some(lockedDir => img.rel_path.startsWith(lockedDir + "/"))) return false;
        return true;
    }).map(img => {
        const formatted = formatImageResponse(req, img);
        return {
            filename: img.filename,
            relPath: img.rel_path,
            lat: img.lat,
            lng: img.lng,
            date: img.upload_time,
            thumbUrl: `${formatted.url}?w=200`,
            thumbhash: img.thumbhash,
            fullUrl: formatted.fullUrl,
            url: formatted.url
        };
    });
    res.json({ success: true, data: mapData });
});

// 目录列表
router.get('/directories', requirePassword, async (req, res) => {
    try {
        const mediaRoot = getActiveMediaRoot();

        async function getDirectories(dir) {
            const absDir = safeJoin(mediaRoot, dir);
            let results = [];
            try {
                const files = await fs.readdir(absDir);
                for (const file of files) {
                    if (shouldSkipDirectory(file)) continue;

                    const filePath = path.join(absDir, file);
                    const stats = await fs.stat(filePath);
                    if (stats.isDirectory()) {
                        const relPath = path.join(dir, file).replace(/\\/g, "/");
                        const isLocked = await isAlbumLocked(relPath);
                        let previews = [];

                        if (!isLocked) {
                            previews = imageRepository.getPreviews(relPath, 3).map(img =>
                                `/api/images/${img.rel_path.split("/").map(encodeURIComponent).join("/")}?w=400`
                            );
                        }

                        results.push({
                            name: file,
                            path: relPath,
                            fullUrl: relPath,
                            previews,
                            locked: isLocked,
                            imageCount: imageRepository.countByDir(relPath),
                            mtime: stats.mtime
                        });

                        const children = await getDirectories(relPath);
                        results = results.concat(children);
                    }
                }
            } catch (e) { }
            return results;
        }

        const directories = await getDirectories("");
        res.json({ success: true, data: directories });
    } catch (e) {
        console.error("List directories error:", e);
        res.status(500).json({ error: "Get directories failed" });
    }
});

// 图片列表
router.get('/images', requirePassword, async (req, res) => {
    try {
        let dir = req.query.dir || "";
        dir = dir.replace(/\\/g, "/");
        const page = parseInt(req.query.page) || 1;
        const pageSize = parseInt(req.query.pageSize) || 10;
        const search = String(req.query.search || "").trim();

        const albumPassword = req.headers["x-album-password"];
        if (dir && await isAlbumLocked(dir)) {
            if (!albumPassword || !(await verifyAlbumPassword(dir, albumPassword))) {
                return res.status(403).json({ success: false, error: "需要访问密码", locked: true });
            }
        }

        const useTagSearch = shouldUseTagSearch(search);

        if (useTagSearch) {
            // 直接复用当前图片列表接口，让现有搜索框无需改请求协议即可支持标签表达式。
            const lockedDirs = !dir ? await getAllLockedDirectories() : [];
            const tagRows = searchImageRowsByExpression(search, {
                dir,
                excludeDirs: lockedDirs,
            });
            const rows = hasTagOperators(search)
                ? tagRows
                : [...new Map([
                    ...tagRows,
                    ...imageRepository.getByFilenameSearch(search, { dir, excludeDirs: lockedDirs }),
                ].map((row) => [row.id, row])).values()];
            rows.sort((a, b) => String(b.upload_time || '').localeCompare(String(a.upload_time || '')));
            const offset = (page - 1) * pageSize;
            const paginated = rows.slice(offset, offset + pageSize);

            res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
            return res.json({
                success: true,
                data: paginated.map(img => formatImageResponse(req, img)),
                pagination: {
                    current: page,
                    pageSize,
                    total: rows.length,
                    totalPages: Math.ceil(rows.length / pageSize)
                }
            });
        }

        if (!dir) {
            const lockedDirs = await getAllLockedDirectories();
            if (lockedDirs.length > 0) {
                const total = imageRepository.countExclude(lockedDirs, search);
                const paginated = imageRepository.getPaginatedExclude(lockedDirs, search, page, pageSize);
                res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
                return res.json({
                    success: true,
                    data: paginated.map(img => formatImageResponse(req, img)),
                    pagination: { current: page, pageSize, total, totalPages: Math.ceil(total / pageSize) }
                });
            }
        }

        const total = imageRepository.countPaginated(dir, search);
        const paginated = imageRepository.getPaginated(dir, page, pageSize, search);
        const result = paginated.map(img => formatImageResponse(req, img));

        res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
        res.json({
            success: true,
            data: result,
            pagination: {
                current: page,
                pageSize,
                total,
                totalPages: Math.ceil(total / pageSize)
            }
        });
    } catch (e) {
        console.error("List images error:", e);
        res.status(500).json({ error: "获取图片列表失败" });
    }
});

// 提取图片元数据
router.get('/images/meta/*', requirePassword, async (req, res) => {
    const relPath = decodeURIComponent(req.params[0]);
    const { dbImage, filePath } = getIndexedOrFallbackPath(relPath);

    if (!await fs.pathExists(filePath)) {
        return res.status(404).json({ success: false, error: "图片不存在" });
    }

    let fileInfo = {};
    if (dbImage) {
        fileInfo = {
            width: dbImage.width,
            height: dbImage.height,
            orientation: dbImage.orientation,
            ...JSON.parse(dbImage.meta_json || '{}')
        };
    }

    try {
        const fstats = await fs.stat(filePath);
        const mimeType = mime.lookup(filePath) || "application/octet-stream";

        // 外部源模式优先复用索引，缺失字段时再即时补元数据。
        if (!fileInfo.space || (!fileInfo.width && mimeType.startsWith("image/"))) {
            const freshMeta = await getFileMetadata(filePath, relPath, fstats);
            const freshJson = JSON.parse(freshMeta.meta_json);
            fileInfo = {
                ...fileInfo,
                width: freshMeta.width,
                height: freshMeta.height,
                orientation: freshMeta.orientation,
                ...freshJson
            };
        }

        const rawInfo = {
            filename: path.basename(relPath),
            rel_path: relPath,
            size: fstats.size,
            upload_time: dbImage?.upload_time || fstats.mtime.toISOString(),
            mime_type: mimeType,
            width: fileInfo.width,
            height: fileInfo.height,
            meta_json: fileInfo,
            source_type: dbImage?.source_type || getActiveSourceType(),
            is_external: dbImage?.is_external || 0,
        };

        res.json({
            success: true,
            data: formatImageResponse(req, rawInfo)
        });
    } catch (e) {
        console.error("Meta error:", e);
        res.status(400).json({ success: false, error: "Error fetching metadata" });
    }
});

async function serveImage(req, res, relPath) {
    try {
        const { filePath } = getIndexedOrFallbackPath(relPath);
        if (!await fs.pathExists(filePath)) {
            return res.status(404).json({ error: "Not found" });
        }

        const { w, h, q, fmt, rows, cols, idx } = req.query;
        const fileMime = (mime.lookup(filePath) || "").toLowerCase();
        const isGif = fileMime.includes("gif");

        if (isGif && !w && !h && !q && !fmt && !rows && !cols) {
            try {
                const stats = await fs.stat(filePath);
                imageRepository.recordView(stats.size);
                imageRepository.incrementViews(relPath);
            } catch (e) { }
            res.setHeader("Content-Type", "image/gif");
            res.setHeader("Cache-Control", "public, max-age=86400, must-revalidate");
            return res.sendFile(filePath);
        }

        try {
            let img = isGif
                ? sharp(filePath, { animated: false }).rotate()
                : sharp(filePath).rotate();

            if (rows && cols && idx !== undefined) {
                const r = parseInt(rows);
                const c = parseInt(cols);
                const i = parseInt(idx);

                if (r > 0 && c > 0 && i >= 0 && i < r * c) {
                    const meta = await img.metadata();
                    const width = meta.width;
                    const height = meta.height;
                    const subW = Math.floor(width / c);
                    const subH = Math.floor(height / r);
                    const row = Math.floor(i / c);
                    const col = i % c;
                    const left = col * subW;
                    const top = row * subH;
                    const extractW = Math.min(subW, width - left);
                    const extractH = Math.min(subH, height - top);

                    img.extract({ left, top, width: extractW, height: extractH });
                }
            }

            if (w || h) {
                img = img.resize({
                    width: w ? parseInt(w) : null,
                    height: h ? parseInt(h) : null,
                    fit: "cover",
                    position: "center",
                    withoutEnlargement: true,
                });
            }

            let outMime = mime.lookup(filePath) || "application/octet-stream";
            if (fmt === "webp") {
                img = img.webp({ quality: q ?? 80 });
                outMime = "image/webp";
            } else if (fmt === "jpeg") {
                img = img.jpeg({ quality: q ?? 80 });
                outMime = "image/jpeg";
            } else if (fmt === "png") {
                img = img.png();
                outMime = "image/png";
            } else if (fmt === "avif") {
                img = img.avif({ quality: q ?? 50 });
                outMime = "image/avif";
            } else if (q) {
                const orig = (mime.lookup(filePath) || "").toLowerCase();
                if (orig.includes("jpeg") || orig.includes("jpg")) {
                    img = img.jpeg({ quality: q });
                    outMime = "image/jpeg";
                } else if (orig.includes("webp")) {
                    img = img.webp({ quality: q });
                    outMime = "image/webp";
                } else if (orig.includes("avif")) {
                    img = img.avif({ quality: q });
                    outMime = "image/avif";
                } else {
                    img = img.png();
                    outMime = "image/png";
                }
            }

            const buffer = await img.toBuffer();

            try {
                imageRepository.recordView(buffer.length);
                imageRepository.incrementViews(relPath);
            } catch (e) {
                console.error("Stats error", e);
            }

            res.setHeader("Content-Type", outMime);
            res.setHeader("Cache-Control", "public, max-age=86400, must-revalidate");
            res.send(buffer);
        } catch (e) {
            if (!w && !h && !q && !fmt) {
                try {
                    const stats = await fs.stat(filePath);
                    imageRepository.recordView(stats.size);
                    imageRepository.incrementViews(relPath);
                } catch (e) { }

                res.setHeader("Content-Type", mime.lookup(filePath) || 'application/octet-stream');
                return res.sendFile(filePath);
            }
            res.status(500).json({ error: "Image processing failed" });
        }
    } catch (e) {
        res.status(400).json({ error: "Error" });
    }
}

router.get('/random', async (req, res) => {
    try {
        let dir = req.query.dir || "";
        dir = dir.replace(/\\/g, "/");

        if (!dir) {
            const lockedDirs = await getAllLockedDirectories();
            if (lockedDirs.length > 0) {
                const randomImage = imageRepository.getRandomExclude(lockedDirs);
                if (!randomImage) return res.status(404).json({ error: "Not Found" });
                if (req.query.format === 'json') return res.json(formatImageResponse(req, randomImage));
                return await serveImage(req, res, randomImage.rel_path);
            }
        }

        const randomImage = dir ? imageRepository.getRandomByDir(dir) : imageRepository.getRandom();
        if (!randomImage) return res.status(404).json({ error: "Not Found" });

        if (req.query.format === 'json') {
            return res.json(formatImageResponse(req, randomImage));
        }

        await serveImage(req, res, randomImage.rel_path);
    } catch (e) {
        console.error("Random image error:", e);
        res.status(500).json({ error: "Failed to get random image" });
    }
});

router.get('/images/*', async (req, res) => {
    const relPath = decodeURIComponent(req.params[0]);
    await serveImage(req, res, relPath);
});

router.get('/files/*', async (req, res) => {
    const relPath = decodeURIComponent(req.params[0]);
    try {
        const { filePath } = getIndexedOrFallbackPath(relPath);
        if (await fs.pathExists(filePath)) {
            res.sendFile(filePath);
        } else {
            res.status(404).json({ error: "Not found" });
        }
    } catch (e) {
        res.status(400).json({ error: "Error" });
    }
});

module.exports = router;
