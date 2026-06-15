const express = require('express');
const path = require('path');
const fs = require('fs-extra');
const config = require('../../config');
const { requirePassword } = require('../middleware/auth');
const imageRepository = require('../db/imageRepository');
const { syncFileSystem } = require('../services/syncService');
const { safeJoin, TRASH_DIR_NAME, CACHE_DIR_NAME } = require('../utils/fileUtils');
const { isExternalRecord } = require('../services/mediaSourceService');

const router = express.Router();
const STORAGE_PATH = config.storage.path;

const { getAlbumPasswordPath, verifyAlbumPassword } = require('../utils/albumUtils');

function ensureExternalWritable(req, res) {
    if (config.imageSource.enabled && !config.imageSource.uploadEnabled) {
        res.status(403).json({ success: false, error: "当前外部图床模式为只读，已关闭本地写入" });
        return false;
    }
    return true;
}

function getRecordOrNull(relPath) {
    return imageRepository.getByPath(relPath.replace(/\\/g, "/"));
}

function ensureRecordWritable(relPath, res) {
    const record = getRecordOrNull(relPath);
    if (record && isExternalRecord(record)) {
        res.status(403).json({ success: false, error: "外部图片源文件只读，请在外部图床中处理" });
        return null;
    }
    return record;
}

// 0. 手动同步
router.post('/sync', requirePassword, async (req, res) => {
    try {
        // 设置弹窗里的全量重建会走 fullRebuild=true，普通刷新仍走增量同步。
        const result = await syncFileSystem({ fullRebuild: Boolean(req.body?.fullRebuild) });
        res.json({ success: true, message: "同步完成", data: result });
    } catch (e) {
        console.error("Sync failed:", e);
        res.status(500).json({ success: false, error: "同步失败" });
    }
});

// 1. 相册密码管理
router.post('/album/password', requirePassword, async (req, res) => {
    try {
        const { dir, password } = req.body;
        if (dir === undefined) return res.status(400).json({ error: "Missing directory" });

        const configPath = await getAlbumPasswordPath(dir);

        if (!password) {
            if (await fs.pathExists(configPath)) {
                await fs.remove(configPath);
            }
            return res.json({ success: true, message: "密码已移除" });
        }

        await fs.ensureDir(path.dirname(configPath));
        await fs.writeJSON(configPath, { password });
        res.json({ success: true, message: "密码设置成功" });
    } catch (e) {
        console.error("Set album password error:", e);
        res.status(500).json({ error: "设置密码失败" });
    }
});

router.post('/album/verify', requirePassword, async (req, res) => {
    try {
        const { dir, password } = req.body;
        if (dir === undefined) return res.status(400).json({ error: "Missing directory" });

        const isValid = await verifyAlbumPassword(dir, password);
        if (isValid) {
            res.json({ success: true, message: "验证通过" });
        } else {
            res.status(401).json({ success: false, error: "密码错误" });
        }
    } catch (e) {
        res.status(500).json({ error: "验证失败" });
    }
});

async function moveToTrash(filePath) {
    try {
        const fileName = path.basename(filePath);
        const ext = path.extname(fileName);
        const nameWithoutExt = path.basename(fileName, ext);
        const timestamp = Date.now();
        const trashName = `${nameWithoutExt}_${timestamp}${ext}`;
        const trashPath = path.join(STORAGE_PATH, TRASH_DIR_NAME, trashName);

        await fs.ensureDir(path.dirname(trashPath));
        await fs.move(filePath, trashPath, { overwrite: true });
        return true;
    } catch (error) {
        console.error("[Trash] Move failed:", error);
        throw error;
    }
}

// 3. 删除图片
router.delete('/images/*', requirePassword, async (req, res) => {
    const relPath = decodeURIComponent(req.params[0]);
    try {
        const record = ensureRecordWritable(relPath, res);
        if (record === null) return;

        const filePath = safeJoin(STORAGE_PATH, relPath);
        if (await fs.pathExists(filePath)) {
            await moveToTrash(filePath);

            const dir = path.dirname(filePath);
            const filename = path.basename(filePath);
            const cacheFile = path.join(dir, CACHE_DIR_NAME, `${filename}.th`);
            if (await fs.pathExists(cacheFile)) await fs.remove(cacheFile);

            imageRepository.delete(relPath);
            res.json({ success: true });
        } else {
            imageRepository.delete(relPath);
            res.status(404).json({ error: "图片不存在 (但在数据库中已清理)" });
        }
    } catch (e) {
        console.error("Delete image failed:", e);
        res.status(400).json({ error: "操作失败", detail: e.message });
    }
});

// 4. 删除文件
router.delete('/files/*', requirePassword, async (req, res) => {
    const relPath = decodeURIComponent(req.params[0]);
    try {
        const record = ensureRecordWritable(relPath, res);
        if (record === null) return;

        const filePath = safeJoin(STORAGE_PATH, relPath);
        if (await fs.pathExists(filePath)) {
            await moveToTrash(filePath);
            imageRepository.delete(relPath);
            res.json({ success: true, message: "文件已移至回收站" });
        } else {
            res.status(404).json({ error: "文件不存在" });
        }
    } catch (e) {
        console.error("Delete file failed:", e);
        res.status(400).json({ error: "操作失败", detail: e.message });
    }
});

// 5. 批量移动
router.post('/batch/move', requirePassword, async (req, res) => {
    try {
        if (!ensureExternalWritable(req, res)) return;

        const { files, targetDir } = req.body;
        if (!Array.isArray(files) || files.length === 0) {
            return res.status(400).json({ error: "未选择文件" });
        }

        const readonlyFile = files.find(file => {
            const record = getRecordOrNull(decodeURIComponent(file));
            return record && isExternalRecord(record);
        });
        if (readonlyFile) {
            return res.status(403).json({ success: false, error: "外部图片源文件只读，不能批量移动" });
        }

        let newDir = targetDir || "";
        newDir = newDir.replace(/\\/g, "/").trim();
        const absTargetDir = safeJoin(STORAGE_PATH, newDir);
        await fs.ensureDir(absTargetDir);

        let successCount = 0;
        let failCount = 0;

        for (const relPath of files) {
            try {
                const oldRelPath = decodeURIComponent(relPath).replace(/\\/g, "/");
                const oldFilePath = safeJoin(STORAGE_PATH, oldRelPath);

                if (await fs.pathExists(oldFilePath)) {
                    const filename = path.basename(oldFilePath);
                    let newRelPath = path.join(newDir, filename).replace(/\\/g, "/");
                    let newFilePath = safeJoin(STORAGE_PATH, newRelPath);

                    if (await fs.pathExists(newFilePath)) {
                        let counter = 1;
                        const ext = path.extname(filename);
                        const nameBase = path.basename(filename, ext);
                        while (await fs.pathExists(newFilePath)) {
                            const newName = `${nameBase}_${Date.now()}_${counter}${ext}`;
                            newRelPath = path.join(newDir, newName).replace(/\\/g, "/");
                            newFilePath = safeJoin(STORAGE_PATH, newRelPath);
                            counter++;
                        }
                    }

                    await fs.move(oldFilePath, newFilePath);

                    const oldCachePath = path.join(path.dirname(oldFilePath), CACHE_DIR_NAME, `${filename}.th`);
                    if (await fs.pathExists(oldCachePath)) {
                        const newCacheDir = path.join(path.dirname(newFilePath), CACHE_DIR_NAME);
                        await fs.ensureDir(newCacheDir);
                        const newCachePath = path.join(newCacheDir, `${path.basename(newFilePath)}.th`);
                        await fs.move(oldCachePath, newCachePath);
                    }

                    const dbImage = imageRepository.getByPath(oldRelPath);
                    if (dbImage) {
                        dbImage.rel_path = newRelPath;
                        dbImage.filename = path.basename(newFilePath);
                        dbImage.source_rel_path = newRelPath;
                        imageRepository.delete(oldRelPath);
                        imageRepository.add(dbImage);
                    }

                    successCount++;
                } else {
                    failCount++;
                }
            } catch (e) {
                console.error(`Move failed for ${relPath}:`, e);
                failCount++;
            }
        }
        res.json({ success: true, successCount, failCount });
    } catch (e) {
        res.status(500).json({ error: "批量移动失败" });
    }
});

// 6. 创建目录
router.post('/directories', requirePassword, async (req, res) => {
    try {
        if (!ensureExternalWritable(req, res)) return;

        const { name } = req.body;
        if (!name) return res.status(400).json({ error: "Missing directory name" });

        if (name.includes("..") || name.includes("\\") || name.startsWith("/")) {
            return res.status(400).json({ error: "Invalid directory name" });
        }

        const absDir = safeJoin(STORAGE_PATH, name);
        if (await fs.pathExists(absDir)) {
            return res.status(400).json({ error: "Directory already exists" });
        }

        await fs.ensureDir(absDir);
        res.json({ success: true, message: "目录创建成功" });
    } catch (e) {
        console.error("Create directory failed:", e);
        res.status(500).json({ error: "创建目录失败" });
    }
});

// 7. 重命名图片
router.put('/images/*', requirePassword, async (req, res) => {
    const relPath = decodeURIComponent(req.params[0]);
    const { newName } = req.body;

    if (!newName || !newName.trim()) {
        return res.status(400).json({ success: false, error: "新文件名不能为空" });
    }

    const safeName = path.basename(newName.trim());
    if (!safeName || safeName !== newName.trim()) {
        return res.status(400).json({ success: false, error: "非法文件名" });
    }

    try {
        if (!ensureExternalWritable(req, res)) return;
        const record = ensureRecordWritable(relPath, res);
        if (record === null) return;

        const oldFilePath = safeJoin(STORAGE_PATH, relPath);
        if (!await fs.pathExists(oldFilePath)) {
            return res.status(404).json({ success: false, error: "原文件不存在" });
        }

        const dir = path.dirname(relPath);
        const newRelPath = (dir && dir !== '.') ? `${dir}/${safeName}` : safeName;
        const newFilePath = safeJoin(STORAGE_PATH, newRelPath);

        if (oldFilePath === newFilePath) {
            return res.json({ success: true, data: { relPath, filename: path.basename(relPath) } });
        }

        if (await fs.pathExists(newFilePath)) {
            return res.status(409).json({ success: false, error: "目标文件名已存在" });
        }

        await fs.rename(oldFilePath, newFilePath);

        const oldCacheFile = path.join(path.dirname(oldFilePath), CACHE_DIR_NAME, `${path.basename(oldFilePath)}.th`);
        if (await fs.pathExists(oldCacheFile)) {
            const newCacheFile = path.join(path.dirname(newFilePath), CACHE_DIR_NAME, `${safeName}.th`);
            await fs.ensureDir(path.dirname(newCacheFile));
            await fs.rename(oldCacheFile, newCacheFile);
        }

        const updated = imageRepository.rename(relPath, newRelPath, safeName);
        const { formatImageResponse } = require('../utils/urlUtils');
        const responseData = updated
            ? formatImageResponse(req, updated)
            : { relPath: newRelPath, filename: safeName };

        res.json({ success: true, data: responseData });
    } catch (e) {
        console.error("Rename failed:", e);
        res.status(500).json({ success: false, error: "重命名失败: " + (e.message || e) });
    }
});

module.exports = router;
