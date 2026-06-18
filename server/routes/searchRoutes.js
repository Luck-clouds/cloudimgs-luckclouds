const express = require('express');
const router = express.Router();
const clipService = require('../services/clipService');
const imageRepository = require('../db/imageRepository');
const tagRepository = require('../db/tagRepository');
const { requirePassword } = require('../middleware/auth');
const { formatImageResponse } = require('../utils/urlUtils');
const { getAllLockedDirectories, isAlbumLocked, verifyAlbumPassword } = require('../utils/albumUtils');

async function filterTagSearchRows(req, rows, dir) {
    if (dir && await isAlbumLocked(dir)) {
        const albumPassword = req.headers['x-album-password'];
        if (!albumPassword || !(await verifyAlbumPassword(dir, albumPassword))) {
            const error = new Error('需要访问密码');
            error.statusCode = 403;
            error.payload = { success: false, error: '需要访问密码', locked: true };
            throw error;
        }
        return rows;
    }

    if (!dir) {
        const lockedDirs = await getAllLockedDirectories();
        if (lockedDirs.length > 0) {
            return rows.filter((row) => !lockedDirs.some((lockedDir) => row.rel_path.startsWith(`${lockedDir}/`)));
        }
    }

    return rows;
}

// 语义搜索
router.post('/semantic', async (req, res) => {
    try {
        const { query, limit } = req.body;
        if (!query) return res.status(400).json({ success: false, error: "Query is required" });

        const results = await clipService.search(query, limit || 50);

        // 使用 formatImageResponse 标准化输出
        const finalResults = results.map(r => {
            const formatted = formatImageResponse(req, r);
            return {
                ...formatted,
                score: r.distance
            };
        });

        res.json({ success: true, data: finalResults });
    } catch (error) {
        console.error("Semantic search error:", error);
        res.status(500).json({ success: false, error: "Search failed" });
    }
});

// 触发全量扫描
router.post('/scan', async (req, res) => {
    try {
        const result = await clipService.scanAll();
        res.json({ success: true, ...result });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 重新索引所有图片 (清除 DB 并重新扫描)
router.post('/reindex', async (req, res) => {
    try {
        const result = await clipService.reindex();
        res.json({ success: true, ...result });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.get('/by-tag', requirePassword, async (req, res) => {
    try {
        const tag = String(req.query.tag || '').trim();
        if (!tag) {
            return res.status(400).json({ success: false, error: 'tag is required' });
        }

        const assetHashes = tagRepository.getAssetHashesByTagNames([tag]);
        const dir = req.query.dir || '';
        const rows = await filterTagSearchRows(req, imageRepository.getByAssetHashes(assetHashes, {
            dir,
            search: req.query.search || '',
        }), dir);
        res.json({ success: true, data: rows.map((row) => formatImageResponse(req, row)) });
    } catch (error) {
        console.error('Tag search error:', error);
        res.status(error.statusCode || 500).json(error.payload || { success: false, error: 'Tag search failed' });
    }
});

router.get('/by-tags', requirePassword, async (req, res) => {
    try {
        const tags = String(req.query.tags || '')
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean);

        if (tags.length === 0) {
            return res.status(400).json({ success: false, error: 'tags is required' });
        }

        const assetHashes = tagRepository.getAssetHashesByTagNames(tags);
        const dir = req.query.dir || '';
        const rows = await filterTagSearchRows(req, imageRepository.getByAssetHashes(assetHashes, {
            dir,
            search: req.query.search || '',
        }), dir);
        res.json({ success: true, data: rows.map((row) => formatImageResponse(req, row)) });
    } catch (error) {
        console.error('Multi-tag search error:', error);
        res.status(error.statusCode || 500).json(error.payload || { success: false, error: 'Tag search failed' });
    }
});

// 状态
router.get('/status', (req, res) => {
    res.json({
        success: true,
        queueLength: clipService.queue.length,
        processing: clipService.processing
    });
});

module.exports = router;
