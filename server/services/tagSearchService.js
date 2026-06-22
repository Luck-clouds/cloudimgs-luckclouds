const imageRepository = require('../db/imageRepository');
const tagRepository = require('../db/tagRepository');
const { parseTagSearchExpression } = require('../utils/tagSearchParser');

function hasTagOperators(input) {
  return /[!,&]/.test(String(input || ''));
}

function shouldUseTagSearch(input) {
  const trimmed = String(input || '').trim();
  if (!trimmed) return false;

  if (hasTagOperators(trimmed)) {
    return true;
  }

  // 保持原有名字搜索兼容：只有精确命中已存在标签名时，才把纯文本切到标签搜索。
  return tagRepository.hasTagName(trimmed);
}

function searchImageRowsByExpression(expression, options = {}) {
  const parsedExpression = parseTagSearchExpression(expression);
  if (!parsedExpression.isValid) {
    const error = new Error('标签搜索表达式无效');
    error.statusCode = 400;
    throw error;
  }

  const assetHashes = tagRepository.searchAssetHashesByParsedExpression(parsedExpression);
  return imageRepository.getByAssetHashes(assetHashes, {
    dir: options.dir || '',
    search: options.search || '',
    excludeDirs: options.excludeDirs || [],
  });
}

module.exports = {
  hasTagOperators,
  shouldUseTagSearch,
  searchImageRowsByExpression,
};
