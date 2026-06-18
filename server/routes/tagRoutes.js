const express = require('express');
const { requirePassword } = require('../middleware/auth');
const imageRepository = require('../db/imageRepository');
const tagRepository = require('../db/tagRepository');

const router = express.Router();

router.get('/tags', requirePassword, (req, res) => {
  try {
    res.json({ success: true, data: tagRepository.list() });
  } catch (error) {
    console.error('List tags failed:', error);
    res.status(500).json({ success: false, error: '获取标签失败' });
  }
});

router.post('/tags', requirePassword, (req, res) => {
  try {
    const tag = tagRepository.getOrCreate(req.body?.name);
    if (!tag) {
      return res.status(400).json({ success: false, error: '标签名不能为空' });
    }
    res.json({ success: true, data: tag });
  } catch (error) {
    console.error('Create tag failed:', error);
    res.status(500).json({ success: false, error: '创建标签失败' });
  }
});

router.delete('/tags/:id', requirePassword, (req, res) => {
  try {
    tagRepository.deleteTag(Number(req.params.id));
    res.json({ success: true });
  } catch (error) {
    console.error('Delete tag failed:', error);
    res.status(500).json({ success: false, error: '删除标签失败' });
  }
});

router.get('/images/:imageId/tags', requirePassword, (req, res) => {
  try {
    const image = imageRepository.getById(Number(req.params.imageId));
    if (!image) {
      return res.status(404).json({ success: false, error: '图片不存在' });
    }

    if (!image.asset_hash) {
      return res.json({ success: true, data: [] });
    }

    res.json({ success: true, data: tagRepository.getTagsByAssetHash(image.asset_hash) });
  } catch (error) {
    console.error('Get image tags failed:', error);
    res.status(500).json({ success: false, error: '获取图片标签失败' });
  }
});

router.post('/images/:imageId/tags', requirePassword, (req, res) => {
  try {
    const image = imageRepository.getById(Number(req.params.imageId));
    if (!image) {
      return res.status(404).json({ success: false, error: '图片不存在' });
    }

    if (!image.asset_hash) {
      return res.status(400).json({ success: false, error: '当前图片还没有可用哈希，暂时不能添加标签' });
    }

    const tagNames = Array.isArray(req.body?.tagNames) ? req.body.tagNames : [];
    if (tagNames.length === 0) {
      return res.status(400).json({ success: false, error: '请至少传入一个标签' });
    }

    tagRepository.attachTagsToAssetHash(image.asset_hash, tagNames);
    res.json({ success: true, data: tagRepository.getTagsByAssetHash(image.asset_hash) });
  } catch (error) {
    console.error('Attach image tags failed:', error);
    res.status(500).json({ success: false, error: '添加标签失败' });
  }
});

router.delete('/images/:imageId/tags/:tagId', requirePassword, (req, res) => {
  try {
    const image = imageRepository.getById(Number(req.params.imageId));
    if (!image) {
      return res.status(404).json({ success: false, error: '图片不存在' });
    }

    if (!image.asset_hash) {
      return res.status(400).json({ success: false, error: '当前图片没有可用哈希' });
    }

    tagRepository.removeTagFromAssetHash(image.asset_hash, Number(req.params.tagId));
    res.json({ success: true, data: tagRepository.getTagsByAssetHash(image.asset_hash) });
  } catch (error) {
    console.error('Remove image tag failed:', error);
    res.status(500).json({ success: false, error: '删除图片标签失败' });
  }
});

module.exports = router;
