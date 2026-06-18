const { syncAllConfiguredSources } = require('../services/syncService');

(async () => {
  try {
    console.log("扫描开始，正在更新索引...")
    const result = await syncAllConfiguredSources({ fullRebuild: true });
    console.log('[index:build] completed:', JSON.stringify(result, null, 2));
    process.exit(0);
  } catch (error) {
    console.error('[index:build] failed:', error);
    process.exit(1);
  }
})();
