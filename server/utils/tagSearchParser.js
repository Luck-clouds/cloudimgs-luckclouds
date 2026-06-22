const { normalizeTagName } = require('../db/tagRepository');

function normalizeTagSearchExpression(input) {
  return String(input || '').replace(/\s+/g, '').trim();
}

function parseTagSearchExpression(input) {
  const raw = String(input || '');
  const normalized = normalizeTagSearchExpression(raw);

  if (!normalized) {
    return {
      raw,
      normalized: '',
      groups: [],
      hasTagSearch: false,
      isValid: false,
    };
  }

  const groups = normalized
    .split(',')
    .map((groupText) => {
      const include = [];
      const exclude = [];

      for (const tokenText of groupText.split('&')) {
        const token = String(tokenText || '').trim();
        if (!token) continue;

        if (token.startsWith('!')) {
          const tagName = normalizeTagName(token.slice(1));
          if (tagName) exclude.push(tagName);
          continue;
        }

        const tagName = normalizeTagName(token);
        if (tagName) include.push(tagName);
      }

      return {
        include: [...new Set(include)],
        exclude: [...new Set(exclude)],
      };
    })
    .filter((group) => group.include.length > 0 || group.exclude.length > 0);

  return {
    raw,
    normalized,
    groups,
    hasTagSearch: groups.length > 0,
    isValid: groups.length > 0,
  };
}

module.exports = {
  normalizeTagSearchExpression,
  parseTagSearchExpression,
};
